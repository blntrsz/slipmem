import { Markdown } from "@slipmem/schemas/markdown"
import { Context, Effect, Layer, Schema } from "effect"
import type { ParsedMarkdownNote } from "../markdown/note-document.js"
import {
  MarkdownNoteRepository,
  type MarkdownNoteRepositoryShape,
} from "../markdown/repository.js"
import { wikiError, type WikiError } from "./errors.js"
import {
  extractiveSections,
  renderWikiMarkdown,
  wikiSourceFromNote,
  MAX_WIKI_OUTPUT_CHARS,
  type WikiSectionDraft,
} from "./render.js"
import {
  selectWikiNotes,
  wikiCitationPath,
  type WikiSelection,
} from "./selection.js"
import {
  groupSynthesizedSentences,
  resolveSynthesisSelection,
  runSynthesisAgent,
  SYNTHESIS_ADAPTER_HINT,
  validateSynthesisOutput,
  type SynthesisAgentRunner,
  type SynthesisModelAdapter,
  type SynthesisRequest,
  type SynthesisSelection,
  type SynthesisSentence,
} from "./synthesis.js"

/** Only the repository operations needed for read-only wiki assembly. */
export type WikiRepository = Pick<MarkdownNoteRepositoryShape, "root" | "scan">

export interface WikiServiceConfig {
  /** Injectable clock; timestamps are whole seconds in UTC. */
  readonly now?: () => number
  /** Default mode when an input omits `mode`. Extractive is the fallback. */
  readonly mode?: Markdown.WikiMode
  /** Explicit synthesizer choice; otherwise `SLIPMEM_WIKI_SYNTHESIS`. */
  readonly synthesis?: SynthesisSelection
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Exact model ID adapters. An unregistered model ID fails closed. */
  readonly modelAdapters?: ReadonlyArray<SynthesisModelAdapter>
  readonly agentRunner?: SynthesisAgentRunner
  readonly agent?: {
    readonly timeoutMs?: number
    readonly maxOutputBytes?: number
    readonly cwd?: string
  }
  readonly excerptChars?: number
  readonly maxOutputChars?: number
}

export interface WikiBuildInput {
  readonly topic: string
  readonly limit?: number
  readonly mode?: Markdown.WikiMode
  readonly includeFleeting?: boolean
}

export interface WikiServiceShape {
  readonly root: string
  readonly select: (
    input: WikiBuildInput,
  ) => Effect.Effect<WikiSelection, WikiError>
  /** Reads notes and returns a page. Never writes under the note root. */
  readonly build: (
    input: WikiBuildInput,
  ) => Effect.Effect<Markdown.WikiPage, WikiError>
}

export class WikiService extends Context.Service<WikiService, WikiServiceShape>()(
  "@slipmem/core/WikiService",
) {}

const pair = (
  root: string,
  note: ParsedMarkdownNote,
): Markdown.WikiSource => wikiSourceFromNote(root, note)

const citationPath = (root: string) => (note: ParsedMarkdownNote) =>
  wikiCitationPath(root, note)

const emptyPage = (input: {
  readonly topic: string
  readonly generatedAt: string
  readonly mode: Markdown.WikiMode
  readonly suggestions: ReadonlyArray<string>
  readonly omittedSentences?: number
}): Markdown.WikiPage => {
  const markdown = renderWikiMarkdown({
    topic: input.topic,
    generatedAt: input.generatedAt,
    mode: input.mode,
    sources: [],
    sections: [],
    suggestions: input.suggestions,
    ...(input.omittedSentences === undefined
      ? {}
      : { omittedSentences: input.omittedSentences }),
  })
  return {
    topic: input.topic,
    generatedAt: input.generatedAt,
    mode: input.mode,
    noteCount: 0,
    sources: [],
    sections: [],
    markdown,
  }
}

const decodePage = (
  page: Markdown.WikiPage,
): Effect.Effect<Markdown.WikiPage, WikiError> =>
  Schema.decodeUnknownEffect(Markdown.WikiPage)(page).pipe(
    Effect.mapError((issue) =>
      wikiError({
        code: "synthesis-output-invalid",
        message: `The assembled wiki page did not satisfy the public schema: ${String(issue)}`,
      }),
    ),
  )

/**
 * On-demand topic wiki.
 *
 * Selection is read-only and bounded. Extractive mode quotes verbatim note
 * spans, one section per note, and cites every section. Synthesized mode runs
 * only an explicitly configured local model adapter or agent process, feeds it
 * bounded untrusted JSON, and drops every sentence that lacks an exact support
 * span. Nothing is persisted; callers decide whether to print or stream the
 * page.
 */
export const makeWikiService = (
  repository: WikiRepository,
  config: WikiServiceConfig = {},
): Effect.Effect<WikiServiceShape, WikiError> =>
  Effect.sync(() => {
    const now = config.now ?? Date.now
    const maxOutputChars = Math.min(
      config.maxOutputChars ?? MAX_WIKI_OUTPUT_CHARS,
      MAX_WIKI_OUTPUT_CHARS,
    )
    const adapters = config.modelAdapters ?? []

    const readNotes = (): Effect.Effect<ReadonlyArray<ParsedMarkdownNote>, WikiError> =>
      repository.scan().pipe(
        Effect.map((scan) => scan.notes),
        Effect.mapError((error) =>
          wikiError({
            code: "repository-failure",
            path: error.path,
            message: `Could not read notes for the wiki: ${error.message}`,
          }),
        ),
      )

    const select = (
      input: WikiBuildInput,
    ): Effect.Effect<WikiSelection, WikiError> =>
      Effect.gen(function* () {
        const notes = yield* readNotes()
        return yield* selectWikiNotes({
          notes,
          topic: input.topic,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.includeFleeting === undefined
            ? {}
            : { includeFleeting: input.includeFleeting }),
        })
      })

    const resolveMode = (
      mode: Markdown.WikiMode | undefined,
    ): Effect.Effect<Markdown.WikiMode, WikiError> => {
      const resolved = mode ?? config.mode ?? "extractive"
      return resolved === "extractive" || resolved === "synthesized"
        ? Effect.succeed(resolved)
        : Effect.fail(
            wikiError({
              code: "invalid-mode",
              field: "mode",
              message: "Wiki mode must be 'extractive' or 'synthesized'.",
            }),
          )
    }

    const runSynthesizer = (
      selection: WikiSelection,
    ): Effect.Effect<unknown, WikiError> =>
      Effect.gen(function* () {
        const resolvedConfig =
          config.synthesis === undefined
            ? yield* resolveSynthesisSelection(config.env ?? process.env)
            : { selection: config.synthesis }
        const synthesis = resolvedConfig.selection
        const request: SynthesisRequest = {
          topic: selection.topic,
          notes: selection.notes.map((note) => ({
            id: note.id,
            type: note.metadata.type,
            title: note.metadata.title,
            path: wikiCitationPath(repository.root, note),
            body: note.body,
          })),
        }

        if (synthesis.kind === "extractive") {
          return yield* Effect.fail(
            wikiError({
              code: "synthesis-config",
              message: `Synthesized mode requires a configured local synthesizer, but the resolved mode is extractive. Set SLIPMEM_WIKI_SYNTHESIS=agent with SLIPMEM_WIKI_AGENT, or register a model adapter. ${SYNTHESIS_ADAPTER_HINT}`,
              field: "SLIPMEM_WIKI_SYNTHESIS",
            }),
          )
        }

        if (synthesis.kind === "model") {
          const adapter = adapters.find(
            (candidate) => candidate.modelId === synthesis.modelId,
          )
          if (adapter === undefined) {
            return yield* Effect.fail(
              wikiError({
                code: "synthesis-adapter-unsupported",
                field: "model",
                message: `Model ID '${synthesis.modelId}' has no configured adapter in this process. slipmem does not assume a provider for an arbitrary model ID. ${SYNTHESIS_ADAPTER_HINT}`,
              }),
            )
          }
          return yield* adapter.synthesize(request)
        }

        const runner = config.agentRunner ?? runSynthesisAgent
        const output = yield* runner(request, {
          command: synthesis.command,
          args: synthesis.args,
          ...(config.agent?.timeoutMs === undefined
            ? {}
            : { timeoutMs: config.agent.timeoutMs }),
          ...(config.agent?.maxOutputBytes === undefined
            ? {}
            : { maxOutputBytes: config.agent.maxOutputBytes }),
          ...(config.agent?.cwd === undefined ? {} : { cwd: config.agent.cwd }),
        })
        return yield* parseAgentOutput(output)
      })

    const build = (
      input: WikiBuildInput,
    ): Effect.Effect<Markdown.WikiPage, WikiError> =>
      Effect.gen(function* () {
        const mode = yield* resolveMode(input.mode)
        const generatedAt = Markdown.toUtcTimestamp(now()).isoTimestamp
        const selection = yield* select(input)

        if (selection.notes.length === 0) {
          return yield* decodePage(
            emptyPage({
              topic: selection.topic,
              generatedAt,
              mode,
              suggestions: selection.suggestions,
            }),
          )
        }

        if (mode === "extractive") {
          const { sections, used, truncated } = extractiveSections(selection, {
            root: repository.root,
            ...(config.excerptChars === undefined
              ? {}
              : { excerptChars: config.excerptChars }),
            maxOutputChars,
          })
          const sources = used.map((note) => pair(repository.root, note))
          const markdown = renderWikiMarkdown({
            topic: selection.topic,
            generatedAt,
            mode,
            sources,
            sections,
            truncated,
          })
          return yield* decodePage({
            topic: selection.topic,
            generatedAt,
            mode,
            noteCount: sources.length,
            sources,
            sections,
            markdown: boundMarkdown(markdown, maxOutputChars),
          })
        }

        const raw = yield* runSynthesizer(selection)
        const validation = yield* validateSynthesisOutput(raw, selection.notes)

        if (validation.sentences.length === 0) {
          return yield* decodePage(
            emptyPage({
              topic: selection.topic,
              generatedAt,
              mode,
              suggestions: [],
              omittedSentences: validation.omitted,
            }),
          )
        }

        const bounded = boundSentences(
          validation.sentences,
          maxOutputChars - 1500,
        )
        const grouped = groupSynthesizedSentences(
          bounded.sentences,
          selection.notes,
          citationPath(repository.root),
        )
        const usedNotes = selection.notes.filter((note) =>
          grouped.usedNoteIds.includes(note.id),
        )
        const sources = usedNotes.map((note) => pair(repository.root, note))
        const sections: ReadonlyArray<WikiSectionDraft> = grouped.sections
        const markdown = renderWikiMarkdown({
          topic: selection.topic,
          generatedAt,
          mode,
          sources,
          sections,
          omittedSentences: validation.omitted + bounded.omitted,
          truncated: bounded.omitted > 0,
        })

        return yield* decodePage({
          topic: selection.topic,
          generatedAt,
          mode,
          noteCount: sources.length,
          sources,
          sections,
          markdown: boundMarkdown(markdown, maxOutputChars),
        })
      })

    return { root: repository.root, select, build }
  })

export const WikiServiceLive = (
  config: WikiServiceConfig = {},
): Layer.Layer<WikiService, WikiError, MarkdownNoteRepository> =>
  Layer.effect(
    WikiService,
    Effect.gen(function* () {
      const repository = yield* MarkdownNoteRepository
      return yield* makeWikiService(repository, config)
    }),
  )

const parseAgentOutput = (
  output: string,
): Effect.Effect<unknown, WikiError> => {
  const trimmed = output.trim()
  if (trimmed === "") {
    return Effect.fail(
      wikiError({
        code: "synthesis-output-invalid",
        message: `The configured agent returned no output. It must print a JSON object shaped as {"sentences":[...]}. ${SYNTHESIS_ADAPTER_HINT}`,
      }),
    )
  }
  try {
    return Effect.succeed(JSON.parse(trimmed))
  } catch {
    return Effect.fail(
      wikiError({
        code: "synthesis-output-invalid",
        message: `The configured agent did not print valid JSON. Return only {"sentences":[...]}. Received: ${trimmed.slice(0, 300)}`,
      }),
    )
  }
}

const boundMarkdown = (markdown: string, maxOutputChars: number): string => {
  if (markdown.length <= maxOutputChars) {
    return markdown
  }
  const suffix = "\n\n_Output truncated at the wiki bound._"
  return `${markdown.slice(0, Math.max(0, maxOutputChars - suffix.length)).trimEnd()}${suffix}`
}

interface BoundedSentences {
  readonly sentences: ReadonlyArray<SynthesisSentence>
  readonly omitted: number
}

/**
 * Bounds structured synthesized output before rendering. Whole sentences are
 * kept; the remainder is counted as omitted so the footer stays truthful.
 */
const boundSentences = (
  sentences: ReadonlyArray<SynthesisSentence>,
  maxChars: number,
): BoundedSentences => {
  const kept: SynthesisSentence[] = []
  let used = 0
  for (const sentence of sentences) {
    const cost = sentence.text.length + sentence.quote.length + 120
    if (used + cost > maxChars) {
      break
    }
    kept.push(sentence)
    used += cost
  }
  return { sentences: kept, omitted: sentences.length - kept.length }
}
