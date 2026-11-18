import { Markdown } from "@slipmem/schemas/markdown"
import { Context, Effect, Layer, Schema } from "effect"
import type { ParsedMarkdownNote } from "../markdown/note-document.js"
import {
  MarkdownNoteRepository,
  type MarkdownNoteRepositoryShape,
} from "../markdown/repository.js"
import { wikiError, type WikiError } from "./errors.js"
import {
  boundWikiText,
  extractiveSections,
  renderWikiMarkdown,
  truncateWikiMarkdownSafely,
  wikiSourceFromNote,
  MAX_WIKI_CITATION_PATH_CHARS,
  MAX_WIKI_OUTPUT_CHARS,
  MAX_WIKI_STRUCTURED_CHARS,
  type WikiEmptyReason,
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
  /**
   * Documented unsafe escape hatch. When true the configured agent runs
   * directly with the slipmem user's filesystem privileges instead of a probed
   * OS sandbox. It is off by default.
   */
  readonly allowUnsandboxedAgent?: boolean
  readonly agent?: {
    readonly timeoutMs?: number
    readonly maxOutputBytes?: number
    readonly cwd?: string
  }
  readonly excerptChars?: number
  readonly maxOutputChars?: number
}

export interface WikiBuildInput {
  readonly tag: string
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
  boundWikiText(
    wikiCitationPath(root, note),
    MAX_WIKI_CITATION_PATH_CHARS,
  )

const emptyPage = (input: {
  readonly tag: string
  readonly generatedAt: string
  readonly mode: Markdown.WikiMode
  readonly suggestions: ReadonlyArray<string>
  readonly omittedSentences?: number
  readonly emptyReason?: WikiEmptyReason
  readonly truncated?: boolean
}): Markdown.WikiPage => {
  const markdown = renderWikiMarkdown({
    tag: input.tag,
    generatedAt: input.generatedAt,
    mode: input.mode,
    sources: [],
    sections: [],
    suggestions: input.suggestions,
    ...(input.omittedSentences === undefined
      ? {}
      : { omittedSentences: input.omittedSentences }),
    ...(input.emptyReason === undefined
      ? {}
      : { emptyReason: input.emptyReason }),
    ...(input.truncated === undefined ? {} : { truncated: input.truncated }),
  })
  return {
    tag: input.tag,
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
 * On-demand tag wiki.
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
          tag: input.tag,
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
          tag: selection.tag,
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
        const unsafeUnsandboxed =
          config.allowUnsandboxedAgent === true ||
          synthesis.unsafeUnsandboxed === true
        const output = yield* runner(request, {
          command: synthesis.command,
          args: synthesis.args,
          unsafeUnsandboxed,
          hidePaths: [repository.root],
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

    /**
     * Assembles a page while enforcing both the Markdown and structured-output
     * bounds. It never slices a section or a citation: when the page is too
     * large it drops whole trailing sections and drops sources that no longer
     * have a citing section.
     */
    const assemblePage = (input: {
      readonly tag: string
      readonly generatedAt: string
      readonly mode: Markdown.WikiMode
      readonly notes: ReadonlyArray<ParsedMarkdownNote>
      readonly sections: ReadonlyArray<WikiSectionDraft>
      readonly omittedSentences?: number
      readonly emptyReason?: WikiEmptyReason
      readonly truncated?: boolean
    }): Effect.Effect<Markdown.WikiPage, WikiError> =>
      Effect.gen(function* () {
        if (input.sections.length === 0) {
          return yield* decodePage(
            emptyPage({
              tag: input.tag,
              generatedAt: input.generatedAt,
              mode: input.mode,
              suggestions: [],
              ...(input.omittedSentences === undefined
                ? {}
                : { omittedSentences: input.omittedSentences }),
              ...(input.emptyReason === undefined
                ? {}
                : { emptyReason: input.emptyReason }),
              ...(input.truncated === undefined
                ? {}
                : { truncated: input.truncated }),
            }),
          )
        }

        let sections = [...input.sections]
        let truncated = input.truncated === true
        while (sections.length > 0) {
          const usedIds = new Set(
            sections.flatMap((section) =>
              section.citations.map((citation) => citation.noteId),
            ),
          )
          const sources = input.notes
            .filter((note) => usedIds.has(note.id))
            .map((note) => pair(repository.root, note))
          const markdown = truncateWikiMarkdownSafely(
            renderWikiMarkdown({
              tag: input.tag,
              generatedAt: input.generatedAt,
              mode: input.mode,
              sources,
              sections,
              ...(input.omittedSentences === undefined
                ? {}
                : { omittedSentences: input.omittedSentences }),
              truncated: truncated || sections.length < input.sections.length,
            }),
            maxOutputChars,
          )
          const page: Markdown.WikiPage = {
            tag: input.tag,
            generatedAt: input.generatedAt,
            mode: input.mode,
            noteCount: sources.length,
            sources,
            sections,
            markdown,
          }

          if (
            markdown.length <= maxOutputChars &&
            JSON.stringify(page).length <= MAX_WIKI_STRUCTURED_CHARS
          ) {
            return yield* decodePage(page)
          }

          sections = sections.slice(0, -1)
          truncated = true
        }

        return yield* decodePage(
          emptyPage({
            tag: input.tag,
            generatedAt: input.generatedAt,
            mode: input.mode,
            suggestions: [],
            emptyReason: "output-truncated",
            ...(input.omittedSentences === undefined
              ? {}
              : { omittedSentences: input.omittedSentences }),
          }),
        )
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
              tag: selection.tag,
              generatedAt,
              mode,
              suggestions: selection.suggestions,
            }),
          )
        }

        if (mode === "extractive") {
          const { sections, truncated } = extractiveSections(selection, {
            root: repository.root,
            ...(config.excerptChars === undefined
              ? {}
              : { excerptChars: config.excerptChars }),
            maxOutputChars,
          })
          return yield* assemblePage({
            tag: selection.tag,
            generatedAt,
            mode,
            notes: selection.notes,
            sections,
            truncated,
          })
        }

        const raw = yield* runSynthesizer(selection)
        const validation = yield* validateSynthesisOutput(raw, selection.notes)

        if (validation.sentences.length === 0) {
          return yield* assemblePage({
            tag: selection.tag,
            generatedAt,
            mode,
            notes: selection.notes,
            sections: [],
            omittedSentences: validation.omitted,
            emptyReason: "no-supported-sentences",
          })
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
        return yield* assemblePage({
          tag: selection.tag,
          generatedAt,
          mode,
          notes: selection.notes,
          sections: grouped.sections,
          omittedSentences: validation.omitted + bounded.omitted,
          truncated: bounded.omitted > 0,
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
