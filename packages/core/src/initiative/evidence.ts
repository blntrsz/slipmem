import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs"
import { resolve } from "node:path"
import { Effect } from "effect"
import { isPathInside } from "../markdown/root.js"
import {
  InitiativeError,
  initiativeError,
} from "./errors.js"
import {
  MAX_EVIDENCE_EXCERPT_CHARS,
  MAX_EVIDENCE_FILE_BYTES,
  MAX_EVIDENCE_LINE_SPAN,
  MAX_SCOPE_EXCERPT_CHARS,
  MAX_SCOPE_SOURCE_BYTES,
  SHA256_HEX_PATTERN,
  type EvidenceCheck,
  type EvidenceKind,
  type EvidencePin,
  type EvidencePinInput,
  type EvidenceStance,
  type GitSnapshot,
  type InitiativeScopeSource,
  type InitiativeSnapshot,
} from "./types.js"

export const sha256Hex = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex")

export const isSha256Hex = (value: unknown): value is string =>
  typeof value === "string" && SHA256_HEX_PATTERN.test(value.toLowerCase())

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) < 32) {
      return true
    }
  }
  return false
}

const evidenceError = (
  code:
    | "evidence-outside-root"
    | "evidence-unreadable"
    | "evidence-invalid"
    | "scope-read-failed",
  path: string,
  message: string,
  field?: string,
): InitiativeError =>
  initiativeError({
    code,
    path,
    message,
    ...(field === undefined ? {} : { field }),
  })

/**
 * Evidence paths are project-relative POSIX paths. Rejecting absolute paths,
 * backslashes, empty segments, and traversal keeps an evidence pin from
 * reaching outside the configured project root.
 */
export const normalizeEvidencePath = (
  value: unknown,
): Effect.Effect<string, InitiativeError> =>
  Effect.gen(function* () {
    if (typeof value !== "string" || value.trim().length === 0) {
      return yield* Effect.fail(
        evidenceError(
          "evidence-invalid",
          "<evidence>",
          "Evidence path must be a non-blank string.",
          "path",
        ),
      )
    }

    const path = value.trim()
    if (
      path.startsWith("/") ||
      path.startsWith("\\") ||
      /^[A-Za-z]:/.test(path) ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.includes(":") ||
      hasControlCharacter(path) ||
      path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      return yield* Effect.fail(
        evidenceError(
          "evidence-outside-root",
          path,
          "Evidence paths must be relative, POSIX-style, and stay inside the project root.",
          "path",
        ),
      )
    }

    return path
  })

interface EvidenceSource {
  readonly path: string
  readonly absolutePath: string
  readonly content: string
  readonly contentHash: string
  readonly lines: ReadonlyArray<string>
}

const splitSourceLines = (content: string): ReadonlyArray<string> =>
  content.split(/\r?\n/)

/**
 * Reads one source file under the evidence root. The path is checked lexically
 * and again after resolving symlinks. Missing, oversized, symlinked, or
 * non-regular files are typed failures, never silently skipped evidence.
 */
export const readEvidenceSource = (
  evidenceRoot: string,
  relativePath: unknown,
): Effect.Effect<EvidenceSource, InitiativeError> =>
  Effect.gen(function* () {
    const path = yield* normalizeEvidencePath(relativePath)
    const absoluteRoot = resolve(evidenceRoot)
    const absolutePath = resolve(absoluteRoot, path)

    if (!isPathInside(absolutePath, absoluteRoot)) {
      return yield* Effect.fail(
        evidenceError(
          "evidence-outside-root",
          path,
          "The evidence path resolves outside the project root.",
        ),
      )
    }

    if (!existsSync(absolutePath)) {
      return yield* Effect.fail(
        evidenceError(
          "evidence-unreadable",
          path,
          `Evidence file '${path}' does not exist under ${absoluteRoot}.`,
        ),
      )
    }

    let stats: ReturnType<typeof lstatSync>
    try {
      stats = lstatSync(absolutePath)
    } catch (cause) {
      return yield* Effect.fail(
        evidenceError(
          "evidence-unreadable",
          path,
          `Could not inspect evidence file '${path}': ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      )
    }

    if (stats.isSymbolicLink()) {
      return yield* Effect.fail(
        evidenceError(
          "evidence-unreadable",
          path,
          "Evidence files must not be symbolic links.",
        ),
      )
    }
    if (!stats.isFile()) {
      return yield* Effect.fail(
        evidenceError(
          "evidence-unreadable",
          path,
          "Evidence must be a regular file.",
        ),
      )
    }
    if (stats.size > MAX_EVIDENCE_FILE_BYTES) {
      return yield* Effect.fail(
        evidenceError(
          "evidence-invalid",
          path,
          `Evidence files must be ${MAX_EVIDENCE_FILE_BYTES} bytes or fewer.`,
        ),
      )
    }

    try {
      const realRoot = realpathSync(absoluteRoot)
      const realFile = realpathSync(absolutePath)
      if (!isPathInside(realFile, realRoot)) {
        return yield* Effect.fail(
          evidenceError(
            "evidence-outside-root",
            path,
            "The evidence file resolves outside the project root through a symlink.",
          ),
        )
      }
    } catch (cause) {
      return yield* Effect.fail(
        evidenceError(
          "evidence-unreadable",
          path,
          `Could not resolve evidence file '${path}': ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      )
    }

    let content: string
    try {
      content = readFileSync(absolutePath, "utf8")
    } catch (cause) {
      return yield* Effect.fail(
        evidenceError(
          "evidence-unreadable",
          path,
          `Could not read evidence file '${path}': ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      )
    }

    return {
      path,
      absolutePath,
      content,
      contentHash: sha256Hex(content),
      lines: splitSourceLines(content),
    }
  })

export interface EvidencePinRequest {
  readonly kind: EvidenceKind
  readonly path: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly note?: string
}

const lineRangeProblem = (
  path: string,
  lineStart: number,
  lineEnd: number,
  lineCount: number,
): string | null => {
  if (
    !Number.isSafeInteger(lineStart) ||
    !Number.isSafeInteger(lineEnd) ||
    lineStart < 1 ||
    lineEnd < lineStart
  ) {
    return "Evidence line ranges must be one-based, inclusive, and ordered."
  }
  if (lineEnd - lineStart + 1 > MAX_EVIDENCE_LINE_SPAN) {
    return `Evidence ranges must span at most ${MAX_EVIDENCE_LINE_SPAN} lines.`
  }
  if (lineEnd > lineCount) {
    return `Evidence range ends at line ${lineEnd}, but the file has ${lineCount} lines.`
  }
  return null
}

const excerptOf = (
  lines: ReadonlyArray<string>,
  lineStart: number,
  lineEnd: number,
): string => lines.slice(lineStart - 1, lineEnd).join("\n")

const boundedExcerpt = (excerpt: string): string =>
  excerpt.length <= MAX_EVIDENCE_EXCERPT_CHARS
    ? excerpt
    : `${excerpt.slice(0, MAX_EVIDENCE_EXCERPT_CHARS - 3)}...`

/**
 * Reads current source and returns a pin whose hashes are derived from that
 * source. Callers cannot supply the hashes, so `initiative pin` cannot accept
 * an unchecked claim that a file contains a supporting line.
 */
export const makeEvidencePin = (
  evidenceRoot: string,
  request: EvidencePinRequest,
): Effect.Effect<EvidencePin, InitiativeError> =>
  Effect.gen(function* () {
    const source = yield* readEvidenceSource(evidenceRoot, request.path)
    const problem = lineRangeProblem(
      source.path,
      request.lineStart,
      request.lineEnd,
      source.lines.length,
    )
    if (problem !== null) {
      return yield* Effect.fail(
        evidenceError("evidence-invalid", source.path, problem, "lineStart"),
      )
    }

    const excerpt = excerptOf(source.lines, request.lineStart, request.lineEnd)
    return {
      kind: request.kind,
      path: source.path,
      lineStart: request.lineStart,
      lineEnd: request.lineEnd,
      contentHash: source.contentHash,
      excerptHash: sha256Hex(excerpt),
      ...(request.note === undefined || request.note.trim() === ""
        ? {}
        : { note: request.note.trim() }),
    }
  })

const invalidCheck = (
  pin: EvidencePinInput,
  stance: EvidenceStance,
  reason: string,
): EvidenceCheck => ({
  kind: pin.kind,
  stance,
  path: pin.path,
  lineStart: pin.lineStart,
  lineEnd: pin.lineEnd,
  valid: false,
  reason,
  contentHash: null,
  excerptHash: null,
  excerpt: "",
})

export interface TrustedEvidenceSnapshot {
  readonly root: string
  readonly commit: string
}

/**
 * Reads an evidence file exactly as it exists at a Git commit. This is the
 * trusted snapshot path: a dirty working tree cannot make a pin pass, and a pin
 * from an unmerged feature branch is checked against that branch commit, which
 * promotion then separately tests for reachability from main.
 */
export const readEvidenceSourceAtCommit = (
  evidenceRoot: string,
  commit: string,
  relativePath: unknown,
): Effect.Effect<EvidenceSource, InitiativeError> =>
  Effect.gen(function* () {
    if (!/^[0-9a-f]{40}$/i.test(commit)) {
      return yield* Effect.fail(
        evidenceError(
          "evidence-unreadable",
          "<snapshot>",
          `Trusted snapshot commit '${commit}' is not a full Git object ID.`,
        ),
      )
    }
    const path = yield* normalizeEvidencePath(relativePath)
    let output: Buffer
    try {
      output = execFileSync("git", ["show", `${commit}:${path}`], {
        cwd: resolve(evidenceRoot),
        maxBuffer: MAX_EVIDENCE_FILE_BYTES + 1024,
        stdio: ["ignore", "pipe", "ignore"],
      })
    } catch (cause) {
      return yield* Effect.fail(
        evidenceError(
          "evidence-unreadable",
          path,
          `Evidence file '${path}' is not available at trusted snapshot ${commit.slice(0, 12)}: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      )
    }

    if (output.length > MAX_EVIDENCE_FILE_BYTES) {
      return yield* Effect.fail(
        evidenceError(
          "evidence-invalid",
          path,
          `Evidence files must be ${MAX_EVIDENCE_FILE_BYTES} bytes or fewer.`,
        ),
      )
    }
    const content = output.toString("utf8")
    if (content.includes("\0")) {
      return yield* Effect.fail(
        evidenceError(
          "evidence-invalid",
          path,
          "Evidence must be text, not binary data.",
        ),
      )
    }

    return {
      path,
      absolutePath: `${commit}:${path}`,
      content,
      contentHash: sha256Hex(output),
      lines: splitSourceLines(content),
    }
  })

/**
 * Re-reads a pin and compares both hashes. With a trusted snapshot, the read is
 * from that commit; otherwise it is from the working tree. The result is
 * advisory evidence, not semantic truth: it proves that the pinned lines are
 * still exactly those lines.
 */
export const checkEvidencePin = (
  evidenceRoot: string,
  pin: EvidencePinInput,
  stance: EvidenceStance,
  snapshot?: TrustedEvidenceSnapshot,
): Effect.Effect<EvidenceCheck> =>
  (snapshot === undefined
    ? readEvidenceSource(evidenceRoot, pin.path)
    : readEvidenceSourceAtCommit(evidenceRoot, snapshot.commit, pin.path)
  ).pipe(
    Effect.match({
      onFailure: (error) => invalidCheck(pin, stance, error.message),
      onSuccess: (source) => {
        const problem = lineRangeProblem(
          source.path,
          pin.lineStart,
          pin.lineEnd,
          source.lines.length,
        )
        if (problem !== null) {
          return invalidCheck(pin, stance, problem)
        }

        const excerpt = excerptOf(source.lines, pin.lineStart, pin.lineEnd)
        const excerptHash = sha256Hex(excerpt)
        const declaredContentHash = String(pin.contentHash).toLowerCase()
        const declaredExcerptHash = String(pin.excerptHash).toLowerCase()
        const contentMatches = source.contentHash === declaredContentHash
        const excerptMatches = excerptHash === declaredExcerptHash

        return {
          kind: pin.kind,
          stance,
          path: source.path,
          lineStart: pin.lineStart,
          lineEnd: pin.lineEnd,
          valid: contentMatches && excerptMatches,
          ...(contentMatches && excerptMatches
            ? {}
            : {
                reason: contentMatches
                  ? "The pinned lines changed even though the rest of the file hash still matches."
                  : "The evidence file changed after this pin was recorded.",
              }),
          contentHash: source.contentHash,
          excerptHash,
          excerpt: boundedExcerpt(excerpt),
        }
      },
    }),
  )

export const evidenceDigest = (pins: ReadonlyArray<EvidencePin>): string => {
  const normalized = [...pins]
    .map((pin) => ({
      kind: pin.kind,
      path: pin.path,
      lineStart: pin.lineStart,
      lineEnd: pin.lineEnd,
      contentHash: pin.contentHash.toLowerCase(),
      excerptHash: pin.excerptHash.toLowerCase(),
      ...(pin.note === undefined ? {} : { note: pin.note }),
    }))
    .sort((left, right) => {
      const leftKey = JSON.stringify(left)
      const rightKey = JSON.stringify(right)
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
  return sha256Hex(JSON.stringify(normalized))
}

/**
 * Reads an initiative scope source without turning it into a note. Only a
 * bounded excerpt and content hash are retained.
 */
export const readScopeSource = (
  evidenceRoot: string,
  relativePath: unknown,
): Effect.Effect<InitiativeScopeSource, InitiativeError> =>
  Effect.gen(function* () {
    const path = yield* normalizeEvidencePath(relativePath).pipe(
      Effect.mapError((error) =>
        evidenceError("scope-read-failed", error.path ?? "<scope>", error.message),
      ),
    )
    const absoluteRoot = resolve(evidenceRoot)
    const absolutePath = resolve(absoluteRoot, path)
    if (!isPathInside(absolutePath, absoluteRoot)) {
      return yield* Effect.fail(
        evidenceError(
          "scope-read-failed",
          path,
          "The scope source resolves outside the project root.",
        ),
      )
    }
    if (!existsSync(absolutePath)) {
      return yield* Effect.fail(
        evidenceError(
          "scope-read-failed",
          path,
          `Scope source '${path}' does not exist under ${absoluteRoot}.`,
        ),
      )
    }

    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(absolutePath)
    } catch (cause) {
      return yield* Effect.fail(
        evidenceError(
          "scope-read-failed",
          path,
          `Could not inspect the scope source: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      )
    }
    if (!stats.isFile()) {
      return yield* Effect.fail(
        evidenceError(
          "scope-read-failed",
          path,
          "Scope source must be a regular file.",
        ),
      )
    }
    if (stats.size > MAX_SCOPE_SOURCE_BYTES) {
      return yield* Effect.fail(
        evidenceError(
          "scope-read-failed",
          path,
          `Scope source must be ${MAX_SCOPE_SOURCE_BYTES} bytes or fewer.`,
        ),
      )
    }

    let content: string
    try {
      const realRoot = realpathSync(absoluteRoot)
      const realFile = realpathSync(absolutePath)
      if (!isPathInside(realFile, realRoot)) {
        return yield* Effect.fail(
          evidenceError(
            "scope-read-failed",
            path,
            "The scope source resolves outside the project root through a symlink.",
          ),
        )
      }
      content = readFileSync(absolutePath, "utf8")
    } catch (cause) {
      return yield* Effect.fail(
        evidenceError(
          "scope-read-failed",
          path,
          `Could not read the scope source: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      )
    }

    if (content.includes("\0")) {
      return yield* Effect.fail(
        evidenceError(
          "scope-read-failed",
          path,
          "Scope source must be text, not binary data.",
        ),
      )
    }

    return {
      path,
      contentHash: sha256Hex(content),
      bytes: Buffer.byteLength(content, "utf8"),
      lineCount: splitSourceLines(content).length,
      excerpt:
        content.length <= MAX_SCOPE_EXCERPT_CHARS
          ? content
          : `${content.slice(0, MAX_SCOPE_EXCERPT_CHARS - 3)}...`,
    }
  })

/**
 * Best-effort Git identity for a verification report or promotion snapshot.
 * No repository or missing git executable is normal in tests and temporary
 * roots, so this returns null instead of failing a local advisory check.
 */
export const readGitSnapshot = (cwd: string): GitSnapshot | null => {
  const run = (args: ReadonlyArray<string>): string | null => {
    try {
      const value = execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
      return value.length === 0 ? null : value
    } catch {
      return null
    }
  }

  const commit = run(["rev-parse", "--verify", "HEAD"])
  if (commit === null) {
    return null
  }
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"])
  return {
    branch: branch === "HEAD" ? null : branch,
    commit,
    detached: branch === "HEAD" || branch === null,
  }
}

export const resolveGitCommit = (cwd: string, ref: string): string | null => {
  try {
    const value = execFileSync(
      "git",
      ["rev-parse", "--verify", `${ref}^{commit}`],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim()
    return /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null
  } catch {
    return null
  }
}

export const isCommitReachable = (
  cwd: string,
  commit: string,
  ancestor: string,
): boolean => {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, ancestor], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    })
    return true
  } catch {
    return false
  }
}

/**
 * Resolves the observed commit and the configured main commit. Evidence is
 * always checked against the observed commit when Git is available; promotion
 * additionally requires `reachableFromMain` (or an explicit opt-out).
 */
export const makeInitiativeSnapshot = (
  cwd: string,
  mainRef: string,
  observedRef: string,
): InitiativeSnapshot | null => {
  const observedCommit = resolveGitCommit(cwd, observedRef)
  if (observedCommit === null) {
    return null
  }
  const mainCommit = resolveGitCommit(cwd, mainRef)
  return {
    mainRef,
    mainCommit,
    observedRef,
    observedCommit,
    reachableFromMain:
      mainCommit !== null &&
      isCommitReachable(cwd, observedCommit, mainCommit),
  }
}
