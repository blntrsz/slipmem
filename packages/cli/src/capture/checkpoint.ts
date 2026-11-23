import {
  STATE_DIRECTORY,
  atomicWriteFile,
  isPathInside,
} from "@slipmem/core"
import {
  DEFAULT_RUN_LEASE_STALE_MS,
  RUN_LEASE_FILENAME,
  inspectRunLease,
  runLeasePath,
  tryAcquireRunLeaseSync,
} from "@slipmem/core/runtime"
import { Effect } from "effect"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import type { ParsedMarkdownNote } from "@slipmem/core"
import type { CaptureEvidence } from "./evidence.js"
import { gitCaptureError, type GitCaptureError } from "./errors.js"

export const GIT_CAPTURE_METADATA_KEY = "gitCapture"
export const GIT_CAPTURE_MARKER_VERSION = 1
export const GIT_CAPTURE_DIRECTORY = "git-capture"
export const GIT_CAPTURE_CHECKPOINT_VERSION = 1
/**
 * The served memory runtime serializes consolidation with this exact lease
 * file. CLI consolidation participates in the same lease instead of using a
 * separate lock, so both owners can never consolidate one note root at once.
 */
export const AUTOMATIC_MEMORY_LEASE_FILENAME = RUN_LEASE_FILENAME
export const DEFAULT_CONSOLIDATION_LEASE_STALE_MS =
  DEFAULT_RUN_LEASE_STALE_MS

const SHA1_OR_SHA256 = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const SHA256 = /^[0-9a-f]{64}$/
const MAX_MARKER_EVIDENCE = 8

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const captureRepositoryKey = (repository: string): string =>
  createHash("sha256")
    .update(resolve(repository), "utf8")
    .digest("hex")

export interface GitCaptureNoteMarker {
  readonly version: typeof GIT_CAPTURE_MARKER_VERSION
  readonly key: string
  readonly repository: string
  readonly before: string
  readonly after: string
  readonly capturedAt: string
  readonly evidence: ReadonlyArray<CaptureEvidence>
}

const parseEvidence = (value: unknown): CaptureEvidence | null => {
  if (!isRecord(value)) {
    return null
  }
  if (
    typeof value.commit !== "string" ||
    !SHA1_OR_SHA256.test(value.commit) ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    value.path.length > 1_024 ||
    typeof value.hunk !== "number" ||
    !Number.isSafeInteger(value.hunk) ||
    value.hunk < 0 ||
    typeof value.quote !== "string" ||
    value.quote.length === 0 ||
    value.quote.length > 500
  ) {
    return null
  }
  return {
    commit: value.commit,
    path: value.path,
    hunk: value.hunk,
    quote: value.quote,
  }
}

/**
 * Markers are only an idempotency and audit hint. They are written inside the
 * note as unknown frontmatter and are never treated as instructions. A
 * malformed marker is ignored, never repaired.
 */
export const readGitCaptureMarker = (
  unknown: Readonly<Record<string, unknown>>,
): GitCaptureNoteMarker | null => {
  const raw = unknown[GIT_CAPTURE_METADATA_KEY]
  if (
    !isRecord(raw) ||
    raw.version !== GIT_CAPTURE_MARKER_VERSION ||
    typeof raw.key !== "string" ||
    !SHA256.test(raw.key) ||
    typeof raw.repository !== "string" ||
    !SHA256.test(raw.repository) ||
    typeof raw.before !== "string" ||
    !SHA1_OR_SHA256.test(raw.before) ||
    typeof raw.after !== "string" ||
    !SHA1_OR_SHA256.test(raw.after) ||
    typeof raw.capturedAt !== "string" ||
    raw.capturedAt.length === 0 ||
    !Array.isArray(raw.evidence) ||
    raw.evidence.length === 0 ||
    raw.evidence.length > MAX_MARKER_EVIDENCE
  ) {
    return null
  }

  const evidence: CaptureEvidence[] = []
  for (const item of raw.evidence) {
    const parsed = parseEvidence(item)
    if (parsed === null) {
      return null
    }
    evidence.push(parsed)
  }

  return {
    version: GIT_CAPTURE_MARKER_VERSION,
    key: raw.key,
    repository: raw.repository,
    before: raw.before,
    after: raw.after,
    capturedAt: raw.capturedAt,
    evidence,
  }
}

export interface ExistingCaptureSource {
  readonly noteId: string
  readonly title: string
  readonly marker: GitCaptureNoteMarker
}

export interface CaptureScan {
  /** First note wins for a duplicate key. */
  readonly byKey: ReadonlyMap<string, ExistingCaptureSource>
  readonly byAfter: ReadonlyMap<string, ReadonlyArray<ExistingCaptureSource>>
}

export const scanCaptureMarkers = (
  notes: ReadonlyArray<Pick<ParsedMarkdownNote, "id" | "metadata" | "unknown">>,
): CaptureScan => {
  const byKey = new Map<string, ExistingCaptureSource>()
  const byAfter = new Map<string, ExistingCaptureSource[]>()
  for (const note of notes) {
    const marker = readGitCaptureMarker(note.unknown)
    if (marker === null) {
      continue
    }
    const source = { noteId: note.id, title: note.metadata.title, marker }
    if (!byKey.has(marker.key)) {
      byKey.set(marker.key, source)
    }
    const forAfter = byAfter.get(marker.after) ?? []
    forAfter.push(source)
    byAfter.set(marker.after, forAfter)
  }
  return { byKey, byAfter }
}

export interface GitCaptureCheckpointSource {
  readonly key: string
  readonly title: string
  readonly noteId: string
}

export type GitCaptureConsolidationStatus = "applied" | "no-op"

export interface GitCaptureCheckpointConsolidation {
  readonly status: GitCaptureConsolidationStatus
  readonly writes: number
  readonly pendingSourceCount: number
}

export interface GitCaptureCheckpoint {
  readonly version: typeof GIT_CAPTURE_CHECKPOINT_VERSION
  readonly repository: string
  readonly before: string
  readonly after: string
  readonly capturedAt: string
  readonly status: "captured" | "consolidated"
  readonly sources: ReadonlyArray<GitCaptureCheckpointSource>
  readonly consolidation?: GitCaptureCheckpointConsolidation
}

export const parseCheckpoint = (
  value: unknown,
): GitCaptureCheckpoint | null => {
  if (
    !isRecord(value) ||
    value.version !== GIT_CAPTURE_CHECKPOINT_VERSION ||
    typeof value.repository !== "string" ||
    !SHA256.test(value.repository) ||
    typeof value.before !== "string" ||
    !SHA1_OR_SHA256.test(value.before) ||
    typeof value.after !== "string" ||
    !SHA1_OR_SHA256.test(value.after) ||
    typeof value.capturedAt !== "string" ||
    value.capturedAt.length === 0 ||
    (value.status !== "captured" && value.status !== "consolidated") ||
    !Array.isArray(value.sources)
  ) {
    return null
  }

  const sources: GitCaptureCheckpointSource[] = []
  for (const item of value.sources) {
    if (
      !isRecord(item) ||
      typeof item.key !== "string" ||
      !SHA256.test(item.key) ||
      typeof item.title !== "string" ||
      typeof item.noteId !== "string" ||
      item.noteId.length === 0
    ) {
      return null
    }
    sources.push({ key: item.key, title: item.title, noteId: item.noteId })
  }

  let consolidation: GitCaptureCheckpointConsolidation | undefined
  if (isRecord(value.consolidation)) {
    const raw = value.consolidation
    if (
      (raw.status === "applied" || raw.status === "no-op") &&
      typeof raw.writes === "number" &&
      Number.isSafeInteger(raw.writes) &&
      raw.writes >= 0 &&
      typeof raw.pendingSourceCount === "number" &&
      Number.isSafeInteger(raw.pendingSourceCount) &&
      raw.pendingSourceCount >= 0
    ) {
      consolidation = {
        status: raw.status,
        writes: raw.writes,
        pendingSourceCount: raw.pendingSourceCount,
      }
    }
  }

  return {
    version: GIT_CAPTURE_CHECKPOINT_VERSION,
    repository: value.repository,
    before: value.before,
    after: value.after,
    capturedAt: value.capturedAt,
    status: value.status,
    sources,
    ...(consolidation === undefined ? {} : { consolidation }),
  }
}

const assertRealDirectoryInsideRoot = (
  path: string,
  root: string,
): GitCaptureError | null => {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      return gitCaptureError({
        code: "checkpoint-failed",
        path,
        message:
          "The Git-capture state path is a symbolic link. Point local state at a real directory inside the note root.",
      })
    }
    const real = realpathSync(path)
    if (!isPathInside(real, resolve(root))) {
      return gitCaptureError({
        code: "checkpoint-failed",
        path,
        message:
          "The Git-capture state path resolves outside the note root. Refusing to write the checkpoint.",
      })
    }
    return null
  } catch (cause) {
    return gitCaptureError({
      code: "checkpoint-failed",
      path,
      message: `Could not inspect the Git-capture state path: ${cause instanceof Error ? cause.message : String(cause)}`,
    })
  }
}

export const ensureGitCaptureStateDirectory = (
  root: string,
): { readonly path: string } | { readonly error: GitCaptureError } => {
  const absoluteRoot = resolve(root)
  const state = join(absoluteRoot, STATE_DIRECTORY)
  const capture = join(state, GIT_CAPTURE_DIRECTORY)
  try {
    let realRoot: string
    try {
      realRoot = realpathSync(absoluteRoot)
    } catch (cause) {
      return {
        error: gitCaptureError({
          code: "checkpoint-failed",
          path: absoluteRoot,
          message: `Could not resolve the note root: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      }
    }
    for (const path of [state, capture]) {
      if (existsSync(path)) {
        if (!statSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
          return {
            error: gitCaptureError({
              code: "checkpoint-failed",
              path,
              message: "The Git-capture state path must be a real directory.",
            }),
          }
        }
      } else {
        mkdirSync(path, { recursive: true, mode: 0o700 })
      }
      const invalid = assertRealDirectoryInsideRoot(path, realRoot)
      if (invalid !== null) {
        return { error: invalid }
      }
    }
    return { path: capture }
  } catch (cause) {
    return {
      error: gitCaptureError({
        code: "checkpoint-failed",
        path: capture,
        message: `Could not create the Git-capture state directory: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    }
  }
}

export const checkpointPath = (root: string, repositoryKey: string): string =>
  join(resolve(root), STATE_DIRECTORY, GIT_CAPTURE_DIRECTORY, `${repositoryKey}.json`)

export const readCheckpoint = (
  root: string,
  repositoryKey: string,
): {
  readonly checkpoint: GitCaptureCheckpoint | null
  readonly path: string
  readonly warning?: string
} => {
  const path = checkpointPath(root, repositoryKey)
  if (!existsSync(path)) {
    return { checkpoint: null, path }
  }
  try {
    const parsed = parseCheckpoint(JSON.parse(readFileSync(path, "utf8")))
    if (parsed === null) {
      return {
        checkpoint: null,
        path,
        warning:
          "The Git-capture checkpoint is malformed; ignoring it and recapturing. Existing note markers still prevent duplicate sources.",
      }
    }
    return { checkpoint: parsed, path }
  } catch (cause) {
    return {
      checkpoint: null,
      path,
      warning: `The Git-capture checkpoint could not be read (${cause instanceof Error ? cause.message : String(cause)}); recapturing. Existing note markers still prevent duplicate sources.`,
    }
  }
}

export const writeCheckpoint = (
  root: string,
  repositoryKey: string,
  checkpoint: GitCaptureCheckpoint,
): Effect.Effect<string, GitCaptureError> => {
  const ensured = ensureGitCaptureStateDirectory(root)
  if ("error" in ensured) {
    return Effect.fail(ensured.error)
  }
  const path = checkpointPath(root, repositoryKey)
  return atomicWriteFile(path, `${JSON.stringify(checkpoint, null, 2)}\n`, {
    overwrite: true,
    mode: 0o600,
  }).pipe(
    Effect.map(() => path),
    Effect.mapError((cause) =>
      gitCaptureError({
        code: "checkpoint-failed",
        path,
        message: `Could not write the Git-capture checkpoint: ${cause.message}`,
      }),
    ),
  )
}

export interface ConsolidationLock {
  readonly path: string
  readonly release: () => void
}

const liveConsolidationLeaseError = (path: string): GitCaptureError =>
  gitCaptureError({
    code: "consolidation-locked",
    path,
    message:
      "--consolidate is unsafe while another consolidation owns the note root. A serving memory runtime or another CLI run holds the shared automatic-memory lease. Sources are already durable; retry after it finishes, or remove the lease if the owner was killed.",
  })

export interface ConsolidationLeaseStatus {
  readonly path: string
  readonly live: boolean
  readonly pid?: number
}

/** Reads the shared runtime lease without acquiring or repairing it. */
export const inspectConsolidationLease = (
  root: string,
): ConsolidationLeaseStatus => {
  const status = inspectRunLease(root, {
    staleMs: DEFAULT_CONSOLIDATION_LEASE_STALE_MS,
  })
  return {
    path: status.path,
    live: status.live,
    ...(status.pid === undefined ? {} : { pid: status.pid }),
  }
}

/** Rejects `--consolidate` before capture work when a live owner exists. */
export const assertNoLiveConsolidationLease = (
  root: string,
): GitCaptureError | null => {
  const status = inspectConsolidationLease(root)
  return status.live ? liveConsolidationLeaseError(status.path) : null
}

/**
 * Acquires the same cross-process lease as the served memory runtime, so CLI
 * consolidation and runtime consolidation serialize instead of racing. A live
 * owner is rejected rather than awaited; sources stay durable and can be
 * retried. It is not the repository mutation lock and is never held around
 * source writes.
 */
export const acquireConsolidationLock = (
  root: string,
  now: () => number,
): { readonly lock: ConsolidationLock } | { readonly error: GitCaptureError } => {
  const ensured = ensureGitCaptureStateDirectory(root)
  if ("error" in ensured) {
    return { error: ensured.error }
  }
  const path = runLeasePath(root)
  try {
    const lease = tryAcquireRunLeaseSync(root, {
      staleMs: DEFAULT_CONSOLIDATION_LEASE_STALE_MS,
      now,
    })
    if (lease === null) {
      return { error: liveConsolidationLeaseError(path) }
    }
    return {
      lock: {
        path: lease.path,
        release: lease.releaseUnsafe,
      },
    }
  } catch (cause) {
    return {
      error: gitCaptureError({
        code: "consolidation-locked",
        path,
        message: `Could not acquire the shared consolidation lease: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      }),
    }
  }
}
