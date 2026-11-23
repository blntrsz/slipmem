import {
  DEFAULT_MAINTENANCE_SOURCE_LIMIT,
  MAX_MAINTENANCE_SOURCE_LIMIT,
  makePermanentMaintenanceWorker,
  makePromptMaintenanceProvider,
  type MarkdownNoteRepositoryShape,
  type PermanentMaintenanceWorkerShape,
} from "@slipmem/core"
import { Markdown } from "@slipmem/schemas/markdown"
import { Effect, Option } from "effect"
import {
  resolveCaptureLimits,
  resolveCaptureModel,
  type CaptureLimits,
  type CaptureModelRuntime,
} from "./config.js"
import {
  GIT_CAPTURE_METADATA_KEY,
  GIT_CAPTURE_MARKER_VERSION,
  acquireConsolidationLock,
  assertNoLiveConsolidationLease,
  captureRepositoryKey,
  readCheckpoint,
  readGitCaptureMarker,
  scanCaptureMarkers,
  writeCheckpoint,
  type GitCaptureCheckpoint,
  type GitCaptureCheckpointSource,
  type GitCaptureNoteMarker,
} from "./checkpoint.js"
import { validateCaptureOutput, type CaptureSourceDraft, type CaptureSourceSkip } from "./evidence.js"
import { gitCaptureError, type GitCaptureError } from "./errors.js"
import {
  captureGitDiff,
  noteRootExcludedPrefix,
  verifyGitRange,
  type GitDiff,
  type VerifiedGitRange,
} from "./git.js"
import { renderGitCapturePrompt } from "./prompt.js"

export const GIT_CAPTURE_ACTOR = "slipmem-git-capture"
export const GIT_CAPTURE_PROVENANCE_SOURCE = "cli"
export const MAX_CAPTURE_MODEL_OUTPUT_CHARS = 64_000
export const DEFAULT_CAPTURE_MAX_TOKENS = 4_096

export interface GitCaptureSourceResult {
  readonly id: string
  readonly title: string
  readonly captureKey: string
  readonly created: boolean
}

export interface GitCaptureConsolidationResult {
  readonly requested: boolean
  readonly status: "skipped" | "already-consolidated" | "applied" | "no-op"
  readonly writes: number
  readonly pendingSourceCount: number
}

export interface GitCaptureRunResult {
  readonly repository: VerifiedGitRange
  readonly repositoryKey: string
  readonly checkpointPath: string
  readonly checkpointStatus: "captured" | "consolidated"
  readonly reusedCheckpoint: boolean
  readonly reason?: "no-changes" | "no-capturable-hunks"
  readonly diff: {
    readonly files: number
    readonly omitted: ReadonlyArray<{ readonly path: string; readonly reason: string }>
    readonly omittedCount: number
    readonly totalChars: number
    readonly truncated: boolean
  }
  readonly model: {
    readonly called: boolean
    readonly label?: string
    readonly egress?: "local" | "remote"
  }
  readonly sources: ReadonlyArray<GitCaptureSourceResult>
  readonly skipped: ReadonlyArray<CaptureSourceSkip>
  readonly consolidation: GitCaptureConsolidationResult
  readonly warnings: ReadonlyArray<string>
}

export interface GitCaptureRunOptions {
  readonly repository: MarkdownNoteRepositoryShape
  readonly repositoryPath: string
  readonly noteRoot: string
  readonly before: string
  readonly after: string
  readonly consolidate: boolean
  readonly env: Readonly<Record<string, string | undefined>>
  readonly now: () => number
  /** Test seam; production resolves an explicit provider from env. */
  readonly model?: CaptureModelRuntime
  /** Test seam; production resolves the bounded defaults from env. */
  readonly limits?: CaptureLimits
}

const capturedAt = (now: () => number): string =>
  Markdown.toUtcTimestamp(now()).isoTimestamp

const repositoryError = (
  action: string,
  cause: { readonly message: string; readonly path?: string },
): GitCaptureError =>
  gitCaptureError({
    code: "write-failed",
    message: `Could not ${action}: ${cause.message}`,
    ...(cause.path === undefined ? {} : { path: cause.path }),
  })

const markerFor = (input: {
  readonly draft: Pick<CaptureSourceDraft, "captureKey" | "evidence">
  readonly repositoryKey: string
  readonly before: string
  readonly after: string
  readonly now: () => number
}): GitCaptureNoteMarker => ({
  version: GIT_CAPTURE_MARKER_VERSION,
  key: input.draft.captureKey,
  repository: input.repositoryKey,
  before: input.before,
  after: input.after,
  capturedAt: capturedAt(input.now),
  evidence: input.draft.evidence,
})

const modelProvider = (
  model: CaptureModelRuntime,
): ReturnType<typeof makePromptMaintenanceProvider> =>
  makePromptMaintenanceProvider((prompt) =>
    model.transport
      .chat({
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        maxTokens: DEFAULT_CAPTURE_MAX_TOKENS,
      })
      .pipe(Effect.map((result) => result.content)),
  )

const captureModelCall = (
  model: CaptureModelRuntime,
  prompt: string,
): Effect.Effect<string, GitCaptureError> =>
  model.transport
    .chat({
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      maxTokens: DEFAULT_CAPTURE_MAX_TOKENS,
    })
    .pipe(
      Effect.map((result) => result.content),
      Effect.mapError((cause) =>
        gitCaptureError({
          code: "model-failed",
          message: `The capture chat request failed: ${cause.message}`,
        }),
      ),
    )

const parseModelJson = (
  content: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: GitCaptureError } => {
  if (content.length > MAX_CAPTURE_MODEL_OUTPUT_CHARS) {
    return {
      ok: false,
      error: gitCaptureError({
        code: "model-output-invalid",
        message: `The capture provider output exceeds ${MAX_CAPTURE_MODEL_OUTPUT_CHARS} characters.`,
      }),
    }
  }
  const trimmed = content.trim()
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: gitCaptureError({
        code: "model-output-invalid",
        message: "The capture provider returned no output.",
      }),
    }
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown }
  } catch {
    return {
      ok: false,
      error: gitCaptureError({
        code: "model-output-invalid",
        message: "The capture provider did not return valid JSON. Output is not repaired or retried.",
      }),
    }
  }
}

const diffSummary = (diff: GitDiff): GitCaptureRunResult["diff"] => ({
  files: diff.files.length,
  omitted: diff.omitted.map((file) => ({
    path: file.path,
    reason: file.reason,
  })),
  omittedCount: diff.omittedCount,
  totalChars: diff.totalChars,
  truncated: diff.truncated,
})

interface ConsolidatedCapture {
  readonly checkpointStatus: "captured" | "consolidated"
  readonly consolidation: GitCaptureConsolidationResult
}

const consolidateCapturedSources = (input: {
  readonly repository: MarkdownNoteRepositoryShape
  readonly noteRoot: string
  readonly model: CaptureModelRuntime
  readonly now: () => number
  readonly sourceCount: number
}): Effect.Effect<ConsolidatedCapture, GitCaptureError> => {
  const acquired = acquireConsolidationLock(input.noteRoot, input.now)
  if ("error" in acquired) {
    return Effect.fail(acquired.error)
  }
  const lock = acquired.lock
  const result = Effect.gen(function* () {
    const worker: PermanentMaintenanceWorkerShape = yield* makePermanentMaintenanceWorker(
      input.repository,
      {
        provider: modelProvider(input.model),
        now: input.now,
      },
    ).pipe(
      Effect.mapError((cause) =>
        gitCaptureError({
          code: "consolidation-failed",
          message: `Could not create the maintenance worker: ${cause.message}`,
        }),
      ),
    )
    const sourceLimit = Math.min(
      MAX_MAINTENANCE_SOURCE_LIMIT,
      Math.max(DEFAULT_MAINTENANCE_SOURCE_LIMIT, input.sourceCount + 1),
    )
    const run = yield* worker.run({ sourceLimit }).pipe(
      Effect.mapError((cause) =>
        gitCaptureError({
          code: "consolidation-failed",
          message: `The optional CLI consolidation failed after sources were saved: ${cause.message}`,
        }),
      ),
    )
    return {
      checkpointStatus: "consolidated" as const,
      consolidation: {
        requested: true,
        status: run.status,
        writes: run.writes.length,
        pendingSourceCount: run.pendingSourceCount,
      },
    }
  })
  return result.pipe(Effect.ensuring(Effect.sync(lock.release)))
}

const checkpointSources = (
  sources: ReadonlyArray<GitCaptureSourceResult>,
): ReadonlyArray<GitCaptureCheckpointSource> =>
  sources.map((source) => ({
    key: source.captureKey,
    title: source.title,
    noteId: source.id,
  }))

const saveCheckpoint = (input: {
  readonly root: string
  readonly repositoryKey: string
  readonly before: string
  readonly after: string
  readonly now: () => number
  readonly status: "captured" | "consolidated"
  readonly sources: ReadonlyArray<GitCaptureSourceResult>
  readonly consolidation?: ConsolidatedCapture["consolidation"]
}): Effect.Effect<string, GitCaptureError> =>
  writeCheckpoint(
    input.root,
    input.repositoryKey,
    {
      version: 1,
      repository: input.repositoryKey,
      before: input.before,
      after: input.after,
      capturedAt: capturedAt(input.now),
      status: input.status,
      sources: checkpointSources(input.sources),
      ...(input.consolidation === undefined
        ? {}
        : {
            consolidation: {
              status:
                input.consolidation.status === "applied"
                  ? ("applied" as const)
                  : ("no-op" as const),
              writes: input.consolidation.writes,
              pendingSourceCount: input.consolidation.pendingSourceCount,
            },
          }),
    },
  )

const resumeFromCheckpoint = (
  input: GitCaptureRunOptions,
  checkpoint: GitCaptureCheckpoint,
  repositoryKey: string,
): Effect.Effect<
  | { readonly reusable: true; readonly sources: ReadonlyArray<GitCaptureSourceResult> }
  | { readonly reusable: false },
  GitCaptureError
> =>
  Effect.gen(function* () {
    const sources: GitCaptureSourceResult[] = []
    for (const source of checkpoint.sources) {
      const note = yield* input.repository
        .get(source.noteId)
        .pipe(Effect.mapError((cause) => repositoryError("read a checkpoint source note", cause)))
      if (Option.isNone(note)) {
        return { reusable: false as const }
      }
      const marker = readGitCaptureMarker(note.value.unknown)
      if (
        marker === null ||
        marker.key !== source.key ||
        marker.repository !== repositoryKey ||
        marker.after !== checkpoint.after
      ) {
        return { reusable: false as const }
      }
      sources.push({
        id: source.noteId,
        title: source.title,
        captureKey: source.key,
        created: false,
      })
    }
    return { reusable: true as const, sources }
  })

const resolveModel = (
  input: GitCaptureRunOptions,
): CaptureModelRuntime | GitCaptureError => {
  if (input.model !== undefined) {
    return input.model
  }
  const resolved = resolveCaptureModel(input.env)
  return "error" in resolved ? resolved.error : resolved
}

export const runGitCapture = (
  input: GitCaptureRunOptions,
): Effect.Effect<GitCaptureRunResult, GitCaptureError> =>
  Effect.gen(function* () {
    const verified = verifyGitRange(
      input.repositoryPath,
      input.before,
      input.after,
    )
    if (!verified.ok) {
      return yield* Effect.fail(verified.error)
    }
    const repositoryInfo = verified.value
    const repositoryKey = captureRepositoryKey(repositoryInfo.repository)
    const resolvedLimits = input.limits ?? resolveCaptureLimits(input.env)
    if ("error" in resolvedLimits) {
      return yield* Effect.fail(resolvedLimits.error)
    }
    const limits = resolvedLimits

    if (input.consolidate) {
      const conflict = assertNoLiveConsolidationLease(input.noteRoot)
      if (conflict !== null) {
        return yield* Effect.fail(conflict)
      }
    }

    const checkpointState = readCheckpoint(input.noteRoot, repositoryKey)
    const warnings: string[] = []
    if (checkpointState.warning !== undefined) {
      warnings.push(checkpointState.warning)
    }

    if (
      checkpointState.checkpoint !== null &&
      checkpointState.checkpoint.repository === repositoryKey &&
      checkpointState.checkpoint.before === input.before &&
      checkpointState.checkpoint.after === input.after
    ) {
      const resumed = yield* resumeFromCheckpoint(
        input,
        checkpointState.checkpoint,
        repositoryKey,
      )
      if (resumed.reusable) {
        const checkpoint = checkpointState.checkpoint
        if (
          input.consolidate &&
          checkpoint.status !== "consolidated" &&
          resumed.sources.length > 0
        ) {
          const resolvedModel = resolveModel(input)
          if (!("transport" in resolvedModel)) {
            return yield* Effect.fail(resolvedModel)
          }
          const consolidated = yield* consolidateCapturedSources({
            repository: input.repository,
            noteRoot: input.noteRoot,
            model: resolvedModel,
            now: input.now,
            sourceCount: resumed.sources.length,
          })
          const checkpointPath = yield* saveCheckpoint({
            root: input.noteRoot,
            repositoryKey,
            before: input.before,
            after: input.after,
            now: input.now,
            status: consolidated.checkpointStatus,
            sources: resumed.sources,
            consolidation: consolidated.consolidation,
          })
          return {
            repository: repositoryInfo,
            repositoryKey,
            checkpointPath,
            checkpointStatus: consolidated.checkpointStatus,
            reusedCheckpoint: true,
            diff: { files: 0, omitted: [], omittedCount: 0, totalChars: 0, truncated: false },
            model: { called: false },
            sources: resumed.sources,
            skipped: [],
            consolidation: consolidated.consolidation,
            warnings,
          }
        }

        return {
          repository: repositoryInfo,
          repositoryKey,
          checkpointPath: checkpointState.path,
          checkpointStatus: checkpoint.status,
          reusedCheckpoint: true,
          diff: { files: 0, omitted: [], omittedCount: 0, totalChars: 0, truncated: false },
          model: { called: false },
          sources: resumed.sources,
          skipped: [],
          consolidation: {
            requested: input.consolidate,
            status:
              input.consolidate && checkpoint.status === "consolidated"
                ? "already-consolidated"
                : "skipped",
            writes: checkpoint.consolidation?.writes ?? 0,
            pendingSourceCount:
              checkpoint.consolidation?.pendingSourceCount ?? 0,
          },
          warnings,
        }
      }
      if (checkpointState.checkpoint.sources.length > 0) {
        warnings.push(
          "The checkpoint named source notes that are missing or no longer match. Recapturing; existing markers still prevent duplicates.",
        )
      }
    }

    const excluded = noteRootExcludedPrefix(
      repositoryInfo.repository,
      input.noteRoot,
    )
    const diffResult = captureGitDiff(
      repositoryInfo.repository,
      repositoryInfo.before,
      repositoryInfo.after,
      {
        limits,
        ...(excluded === null ? {} : { excludedPrefixes: [excluded] }),
      },
    )
    if (!diffResult.ok) {
      return yield* Effect.fail(diffResult.error)
    }
    const diff = diffResult.value
    const summary = diffSummary(diff)

    if (diff.files.length === 0 || diff.files.every((file) => file.hunks.length === 0)) {
      const reason =
        diff.files.length === 0 ? ("no-changes" as const) : ("no-capturable-hunks" as const)
      const checkpointPath = yield* saveCheckpoint({
        root: input.noteRoot,
        repositoryKey,
        before: input.before,
        after: input.after,
        now: input.now,
        status: "captured",
        sources: [],
      })
      return {
        repository: repositoryInfo,
        repositoryKey,
        checkpointPath,
        checkpointStatus: "captured",
        reusedCheckpoint: false,
        reason,
        diff: summary,
        model: { called: false },
        sources: [],
        skipped: [],
        consolidation: {
          requested: input.consolidate,
          status: "skipped",
          writes: 0,
          pendingSourceCount: 0,
        },
        warnings,
      }
    }

    const resolvedModel = resolveModel(input)
    if (!("transport" in resolvedModel)) {
      return yield* Effect.fail(resolvedModel)
    }
    const model = resolvedModel

    const prompt = renderGitCapturePrompt({
      repository: repositoryInfo.repository,
      before: repositoryInfo.before,
      after: repositoryInfo.after,
      diff,
      limits,
    })
    const content = yield* captureModelCall(model, prompt)
    const parsed = parseModelJson(content)
    if (!parsed.ok) {
      return yield* Effect.fail(parsed.error)
    }
    const validated = validateCaptureOutput(parsed.value, {
      repository: repositoryKey,
      before: repositoryInfo.before,
      after: repositoryInfo.after,
      diff,
      limits,
    })
    if (!validated.ok) {
      return yield* Effect.fail(validated.error)
    }

    const scan = yield* input.repository
      .scan()
      .pipe(Effect.mapError((cause) => repositoryError("scan the note repository", cause)))
    const existing = scanCaptureMarkers(scan.notes)
    const knownByKey = new Map(existing.byKey)
    const sources: GitCaptureSourceResult[] = []
    const seenKeys = new Set<string>()
    for (const draft of validated.value.sources) {
      if (seenKeys.has(draft.captureKey)) {
        continue
      }
      seenKeys.add(draft.captureKey)
      const found = knownByKey.get(draft.captureKey)
      if (found !== undefined) {
        sources.push({
          id: found.noteId,
          title: found.title,
          captureKey: draft.captureKey,
          created: false,
        })
        continue
      }

      const marker = markerFor({
        draft,
        repositoryKey,
        before: repositoryInfo.before,
        after: repositoryInfo.after,
        now: input.now,
      })
      const note = yield* input.repository
        .create({
          type: "fleeting",
          title: draft.title,
          content: draft.content,
          ...(draft.tags.length === 0 ? {} : { tags: draft.tags }),
          provenance: {
            source: GIT_CAPTURE_PROVENANCE_SOURCE,
            actor: GIT_CAPTURE_ACTOR,
          },
          unknown: { [GIT_CAPTURE_METADATA_KEY]: marker },
        })
        .pipe(Effect.mapError((cause) => repositoryError("create a capture source note", cause)))
      knownByKey.set(draft.captureKey, {
        noteId: note.id,
        title: note.metadata.title,
        marker,
      })
      sources.push({
        id: note.id,
        title: note.metadata.title,
        captureKey: draft.captureKey,
        created: true,
      })
    }

    let checkpointPath = yield* saveCheckpoint({
      root: input.noteRoot,
      repositoryKey,
      before: input.before,
      after: input.after,
      now: input.now,
      status: "captured",
      sources,
    })
    let checkpointStatus: "captured" | "consolidated" = "captured"
    let consolidation: GitCaptureConsolidationResult = {
      requested: input.consolidate,
      status: "skipped",
      writes: 0,
      pendingSourceCount: 0,
    }

    if (input.consolidate && sources.length > 0) {
      const consolidated = yield* consolidateCapturedSources({
        repository: input.repository,
        noteRoot: input.noteRoot,
        model,
        now: input.now,
        sourceCount: sources.length,
      })
      checkpointStatus = consolidated.checkpointStatus
      consolidation = consolidated.consolidation
      checkpointPath = yield* saveCheckpoint({
        root: input.noteRoot,
        repositoryKey,
        before: input.before,
        after: input.after,
        now: input.now,
        status: consolidated.checkpointStatus,
        sources,
        consolidation: consolidated.consolidation,
      })
    }

    return {
      repository: repositoryInfo,
      repositoryKey,
      checkpointPath,
      checkpointStatus,
      reusedCheckpoint: false,
      diff: summary,
      model: {
        called: true,
        label: model.label,
        egress: model.egress,
      },
      sources,
      skipped: validated.value.skips,
      consolidation,
      warnings,
    }
  })
