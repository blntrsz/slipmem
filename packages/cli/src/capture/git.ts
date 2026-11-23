import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { relative, resolve, sep } from "node:path"
import { gitCaptureError, type GitCaptureError } from "./errors.js"

export const GIT_COMMAND_TIMEOUT_MS = 60_000
export const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export interface GitCommandResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  /** The child exceeded the configured output bound or could not be spawned. */
  readonly bufferExceeded: boolean
  readonly timedOut: boolean
}

export interface GitCommandOptions {
  readonly maxBufferBytes?: number
  readonly timeoutMs?: number
}

/**
 * A deliberately small, read-only Git adapter.
 *
 * Every call clears inherited Git environment variables, ignores system/global
 * configuration, disables lazy fetching from partial clones, and runs with
 * `--no-pager`. Callers only use read commands (`rev-parse`, `cat-file`,
 * `merge-base`, `diff`). Capture never checks out, resets, cleans, fetches, or
 * writes to the checkout.
 */
export const runGit = (
  repository: string,
  args: ReadonlyArray<string>,
  options: GitCommandOptions = {},
): GitCommandResult => {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
  }

  const result = spawnSync(
    "git",
    [
      "--no-pager",
      "-c",
      "core.quotepath=false",
      "-c",
      "core.useReplaceRefs=false",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "diff.external=",
      "-C",
      repository,
      ...args,
    ],
    {
      encoding: "utf8",
      env,
      maxBuffer: options.maxBufferBytes ?? 4 * 1024 * 1024,
      timeout: options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  const spawnError = result.error as NodeJS.ErrnoException | undefined
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    bufferExceeded: spawnError?.code === "ENOBUFS",
    timedOut: spawnError?.code === "ETIMEDOUT",
  }
}

const commandFailure = (
  action: string,
  result: GitCommandResult,
): GitCaptureError => {
  const detail = result.timedOut
    ? "the command timed out"
    : result.bufferExceeded
      ? "the command output exceeded its bound"
      : result.stderr.trim().split(/\r?\n/)[0] ||
        `git exited with status ${String(result.status)}`
  return gitCaptureError({
    code: "git-failed",
    message: `Could not ${action}: ${detail}`,
  })
}

const requireSuccess = (
  action: string,
  result: GitCommandResult,
): GitCaptureError | null =>
  result.status === 0 ? null : commandFailure(action, result)

const assertCommitSha = (
  value: string,
  field: string,
): GitCaptureError | null => {
  if (!GIT_SHA_PATTERN.test(value)) {
    return gitCaptureError({
      code: "invalid-commit",
      field,
      message: `${field} must be an exact lowercase 40- or 64-character commit SHA from the push event, not a branch, tag, or short SHA.`,
    })
  }
  if (/^0+$/.test(value)) {
    return gitCaptureError({
      code: "invalid-commit",
      field,
      message: `${field} is the all-zero creation/deletion sentinel. The first slice requires an existing before and after commit on the pushed branch.`,
    })
  }
  return null
}

type CommitTypeResult =
  | { readonly ok: true; readonly type: string }
  | { readonly ok: false; readonly error: GitCaptureError }

const commitType = (
  repository: string,
  sha: string,
  field: string,
): CommitTypeResult => {
  const result = runGit(repository, ["cat-file", "-t", sha])
  if (result.status !== 0) {
    return {
      ok: false,
      error: gitCaptureError({
        code: "commit-missing",
        field,
        message:
          "The commit is not present in this checkout. Fetch full history in CI (for example actions/checkout with fetch-depth: 0) and retry; capture never fetches objects.",
      }),
    }
  }
  const type = result.stdout.trim()
  if (type !== "commit") {
    return {
      ok: false,
      error: gitCaptureError({
        code: "invalid-commit",
        field,
        message: `${field} resolves to a ${type || "non-commit"} object, not a commit.`,
      }),
    }
  }
  return { ok: true, type }
}

export interface VerifiedGitRange {
  /** Absolute worktree root reported by Git. */
  readonly repository: string
  readonly before: string
  readonly after: string
  readonly head: string
}

/**
 * Verifies that both inputs are exact commits in this checkout, that the
 * checkout is at `after`, and that `after` descends from `before`. Capture
 * refuses force-push reversals rather than inventing a delta.
 */
export const verifyGitRange = (
  repository: string,
  before: string,
  after: string,
): { readonly ok: true; readonly value: VerifiedGitRange } | { readonly ok: false; readonly error: GitCaptureError } => {
  const absolute = resolve(repository)
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    return {
      ok: false,
      error: gitCaptureError({
        code: "invalid-config",
        field: "repo",
        path: absolute,
        message: "The repository path does not exist or is not a directory.",
      }),
    }
  }

  for (const [value, field] of [
    [before, "before"],
    [after, "after"],
  ] as const) {
    const invalid = assertCommitSha(value, field)
    if (invalid !== null) {
      return { ok: false, error: invalid }
    }
  }

  const toplevel = runGit(absolute, ["rev-parse", "--show-toplevel"])
  const topFailure = requireSuccess("read the Git worktree root", toplevel)
  if (topFailure !== null) {
    return { ok: false, error: topFailure }
  }
  const repositoryRoot = resolve(toplevel.stdout.trim())
  if (repositoryRoot.length === 0) {
    return {
      ok: false,
      error: gitCaptureError({
        code: "git-failed",
        message: "Git did not report a worktree root for the repository.",
      }),
    }
  }

  for (const [sha, field] of [
    [before, "before"],
    [after, "after"],
  ] as const) {
    const type = commitType(repositoryRoot, sha, field)
    if (!type.ok) {
      return { ok: false, error: type.error }
    }
  }

  for (const [sha, field] of [
    [before, "before"],
    [after, "after"],
  ] as const) {
    const resolved = runGit(repositoryRoot, [
      "rev-parse",
      "--verify",
      `${sha}^{commit}`,
    ])
    const failure = requireSuccess(`verify the ${field} commit`, resolved)
    if (failure !== null) {
      return { ok: false, error: failure }
    }
    if (resolved.stdout.trim() !== sha) {
      return {
        ok: false,
        error: gitCaptureError({
          code: "invalid-commit",
          field,
          message: `${field} did not resolve to the exact requested commit SHA.`,
        }),
      }
    }
  }

  const headResult = runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD"])
  const headFailure = requireSuccess("read the checked-out HEAD", headResult)
  if (headFailure !== null) {
    return { ok: false, error: headFailure }
  }
  const head = headResult.stdout.trim()
  if (head !== after) {
    return {
      ok: false,
      error: gitCaptureError({
        code: "checkout-mismatch",
        field: "after",
        message:
          "The checkout HEAD does not equal the push's after commit. Check out the pushed commit (actions/checkout defaults to github.sha) and retry; capture only reads Git objects and never changes the checkout.",
      }),
    }
  }

  const ancestor = runGit(repositoryRoot, [
    "merge-base",
    "--is-ancestor",
    before,
    after,
  ])
  if (ancestor.status !== 0) {
    return {
      ok: false,
      error: gitCaptureError({
        code: "not-ancestor",
        field: "after",
        message:
          "The after commit is not a descendant of the before commit. This looks like a force push, branch replacement, or reversed range; the first slice refuses it instead of fabricating a delta.",
      }),
    }
  }

  return {
    ok: true,
    value: { repository: repositoryRoot, before, after, head },
  }
}

export type GitChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "typechanged"
  | "copied"
  | "unknown"

export interface GitHunk {
  /** Zero-based position in the file's `hunks` array. */
  readonly index: number
  readonly oldStart: number
  readonly oldCount: number
  readonly newStart: number
  readonly newCount: number
  /** Unified-diff lines, including their leading space, plus, or minus. */
  readonly lines: ReadonlyArray<string>
  readonly chars: number
  readonly truncated: boolean
}

export interface GitChangedFile {
  readonly path: string
  readonly status: GitChangeStatus
  readonly hunks: ReadonlyArray<GitHunk>
  readonly binary: boolean
}

export interface OmittedGitFile {
  readonly path: string
  readonly reason:
    | "file-limit"
    | "patch-too-large"
    | "line-too-long"
    | "diff-too-large"
    | "unsupported-status"
  readonly status: GitChangeStatus
}

export interface GitDiff {
  readonly before: string
  readonly after: string
  readonly files: ReadonlyArray<GitChangedFile>
  /** Bounded details; use `omittedCount` for the aggregate. */
  readonly omitted: ReadonlyArray<OmittedGitFile>
  readonly omittedCount: number
  readonly totalChars: number
  readonly truncated: boolean
}

/** Bounded detail rows for prompts, human output, and JSON. */
export const MAX_OMITTED_FILE_DETAILS = 32

export interface GitDiffLimits {
  readonly maxFiles: number
  readonly maxHunksPerFile: number
  readonly maxFilePatchChars: number
  readonly maxTotalPatchChars: number
  readonly maxHunkLineChars: number
}

export const DEFAULT_GIT_DIFF_LIMITS: GitDiffLimits = {
  maxFiles: 24,
  maxHunksPerFile: 20,
  maxFilePatchChars: 12_000,
  maxTotalPatchChars: 60_000,
  maxHunkLineChars: 2_000,
}

export interface CaptureDiffOptions {
  readonly limits?: GitDiffLimits
  /** Absolute paths whose repository-relative prefix is never captured. */
  readonly excludedPrefixes?: ReadonlyArray<string>
}

const statusFromGit = (status: string): GitChangeStatus => {
  switch (status) {
    case "A":
      return "added"
    case "M":
      return "modified"
    case "D":
      return "deleted"
    case "T":
      return "typechanged"
    case "C":
      return "copied"
    default:
      return "unknown"
  }
}

const normalizeRelativePath = (path: string): string =>
  path.split(sep).join("/").replace(/^\/+/, "")

/**
 * `git diff --name-status -z` is authoritative for the changed-path list. A
 * caller-configured note root is excluded so capture never feeds its own notes
 * (or local state) back into a later push.
 */
const changedPaths = (
  repository: string,
  before: string,
  after: string,
  excludedPrefixes: ReadonlyArray<string>,
): { readonly paths: ReadonlyArray<{ path: string; status: GitChangeStatus }> } | { readonly error: GitCaptureError } => {
  const result = runGit(
    repository,
    [
      "diff",
      "--name-status",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--diff-filter=ACDMT",
      before,
      after,
      "--",
    ],
    { maxBufferBytes: 8 * 1024 * 1024 },
  )
  const failure = requireSuccess("read changed paths from Git", result)
  if (failure !== null) {
    return { error: failure }
  }

  const tokens = result.stdout.split("\u0000")
  const paths: Array<{ path: string; status: GitChangeStatus }> = []
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const rawStatus = tokens[index] ?? ""
    const path = tokens[index + 1] ?? ""
    if (rawStatus === "" || path === "") {
      continue
    }
    if (excludedPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      continue
    }
    paths.push({ path, status: statusFromGit(rawStatus.charAt(0)) })
  }
  return { paths }
}

const HUNK_HEADER =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

const parseHunk = (
  lines: ReadonlyArray<string>,
  index: number,
  value: {
    readonly oldStart: number
    readonly oldCount: number
    readonly newStart: number
    readonly newCount: number
  },
  maxLineChars: number,
): GitHunk | { readonly reason: "line-too-long" } => {
  let chars = 0
  for (const line of lines) {
    if (line.length > maxLineChars) {
      return { reason: "line-too-long" }
    }
    chars += line.length + 1
  }
  return {
    index,
    ...value,
    lines,
    chars,
    truncated: false,
  }
}

/**
 * Parses one file's unified diff. Only hunk bodies are retained; file headers
 * and index lines are not model input. A hunk with an oversized single line is
 * omitted whole rather than cut, so an evidence quote can never match a
 * silently shortened line.
 */
export const parseFilePatch = (
  patch: string,
  limits: GitDiffLimits,
  remainingTotalChars: number,
):
  | {
      readonly hunks: ReadonlyArray<GitHunk>
      readonly omittedReason?: "line-too-long" | "patch-too-large" | "diff-too-large"
    } => {
  interface Draft {
    readonly oldStart: number
    readonly oldCount: number
    readonly newStart: number
    readonly newCount: number
    readonly lines: string[]
  }

  const drafts: Draft[] = []
  let current: Draft | null = null
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@ ")) {
      const match = HUNK_HEADER.exec(line)
      if (match !== null) {
        current = {
          oldStart: Number(match[1]),
          oldCount: match[2] === undefined ? 1 : Number(match[2]),
          newStart: Number(match[3]),
          newCount: match[4] === undefined ? 1 : Number(match[4]),
          lines: [],
        }
        drafts.push(current)
      }
      continue
    }
    if (current === null) {
      continue
    }
    if (line === "" && patch.endsWith("\n")) {
      // The final split element after a trailing newline is not a diff line.
      continue
    }
    if (line.startsWith("diff --git ") || line.startsWith("Binary files ")) {
      current = null
      continue
    }
    current.lines.push(line)
  }

  const hunks: GitHunk[] = []
  let consumed = 0
  let omittedReason: "line-too-long" | "patch-too-large" | "diff-too-large" | undefined
  for (const draft of drafts) {
    if (hunks.length >= limits.maxHunksPerFile) {
      omittedReason = "patch-too-large"
      break
    }
    const hunk = parseHunk(draft.lines, hunks.length, {
      oldStart: draft.oldStart,
      oldCount: draft.oldCount,
      newStart: draft.newStart,
      newCount: draft.newCount,
    }, limits.maxHunkLineChars)
    if ("reason" in hunk) {
      omittedReason = "line-too-long"
      continue
    }
    if (consumed + hunk.chars > Math.min(limits.maxFilePatchChars, remainingTotalChars)) {
      omittedReason =
        remainingTotalChars < limits.maxFilePatchChars
          ? "diff-too-large"
          : "patch-too-large"
      break
    }
    hunks.push(hunk)
    consumed += hunk.chars
  }

  return omittedReason === undefined ? { hunks } : { hunks, omittedReason }
}

const filePatch = (
  repository: string,
  before: string,
  after: string,
  path: string,
  limits: GitDiffLimits,
): { readonly patch: string } | { readonly reason: "patch-too-large" } => {
  const result = runGit(
    repository,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
      "--unified=3",
      before,
      after,
      "--",
      path,
    ],
    {
      maxBufferBytes:
        Math.min(limits.maxFilePatchChars, limits.maxTotalPatchChars) * 4 +
        64 * 1024,
    },
  )
  if (result.bufferExceeded) {
    return { reason: "patch-too-large" }
  }
  if (result.status !== 0) {
    return { reason: "patch-too-large" }
  }
  return { patch: result.stdout }
}

/**
 * Builds the complete, bounded delta that may be shown to the model.
 * Renames are treated as delete/add pairs, binaries have no hunk text, and
 * every limit produces an explicit omission rather than silent truncation.
 */
export const captureGitDiff = (
  repository: string,
  before: string,
  after: string,
  options: CaptureDiffOptions = {},
): { readonly ok: true; readonly value: GitDiff } | { readonly ok: false; readonly error: GitCaptureError } => {
  for (const [sha, field] of [
    [before, "before"],
    [after, "after"],
  ] as const) {
    const invalid = assertCommitSha(sha, field)
    if (invalid !== null) {
      return { ok: false, error: invalid }
    }
    const type = commitType(repository, sha, field)
    if (!type.ok) {
      return { ok: false, error: type.error }
    }
  }

  const limits = options.limits ?? DEFAULT_GIT_DIFF_LIMITS
  const excluded = (options.excludedPrefixes ?? []).map(normalizeRelativePath)
  const changed = changedPaths(repository, before, after, excluded)
  if ("error" in changed) {
    return { ok: false, error: changed.error }
  }

  const files: GitChangedFile[] = []
  const omitted: OmittedGitFile[] = []
  let omittedCount = 0
  let totalChars = 0
  let truncated = false
  const omit = (entry: OmittedGitFile): void => {
    omittedCount++
    if (omitted.length < MAX_OMITTED_FILE_DETAILS) {
      omitted.push(entry)
    }
  }

  for (let index = 0; index < changed.paths.length; index++) {
    const entry = changed.paths[index]!
    if (index >= limits.maxFiles) {
      omit({ path: entry.path, reason: "file-limit", status: entry.status })
      truncated = true
      continue
    }
    if (entry.status === "unknown") {
      omit({
        path: entry.path,
        reason: "unsupported-status",
        status: entry.status,
      })
      continue
    }
    if (totalChars >= limits.maxTotalPatchChars) {
      omit({ path: entry.path, reason: "diff-too-large", status: entry.status })
      truncated = true
      continue
    }

    const patch = filePatch(repository, before, after, entry.path, limits)
    if ("reason" in patch) {
      omit({ path: entry.path, reason: patch.reason, status: entry.status })
      truncated = true
      continue
    }

    const binary =
      patch.patch.includes("Binary files ") ||
      patch.patch.includes("GIT binary patch")
    const parsed = parseFilePatch(
      patch.patch,
      limits,
      limits.maxTotalPatchChars - totalChars,
    )
    if (parsed.omittedReason !== undefined) {
      omit({
        path: entry.path,
        reason: parsed.omittedReason,
        status: entry.status,
      })
      truncated = true
    }
    const chars = parsed.hunks.reduce((sum, hunk) => sum + hunk.chars, 0)
    totalChars += chars
    files.push({
      path: entry.path,
      status: entry.status,
      hunks: parsed.hunks,
      binary,
    })
  }

  return {
    ok: true,
    value: {
      before,
      after,
      files,
      omitted,
      omittedCount,
      totalChars,
      truncated,
    },
  }
}

/** Repository-relative prefix for a note root inside the checkout. */
export const noteRootExcludedPrefix = (
  repository: string,
  noteRoot: string,
): string | null => {
  const path = normalizeRelativePath(relative(repository, resolve(noteRoot)))
  if (path === "" || path === ".") {
    return null
  }
  if (path.startsWith("../") || path === "..") {
    return null
  }
  return path
}
