import { Effect } from "effect"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { createHash } from "node:crypto"
import { MarkdownError, markdownError } from "./errors.js"

export const NOTE_ROOT_DIRECTORY = ".slipmem"
export const STATE_DIRECTORY = ".state"

export type NoteRootSource = "env" | "ancestor" | "git" | "cwd"

export interface NoteRootResolution {
  readonly root: string
  readonly source: NoteRootSource
}

export interface ResolveNoteRootOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly cwd?: string
  /**
   * When true, a missing repository resolves to the Git root or current
   * directory. `slipmem init` uses this; every other caller must not create a
   * repository implicitly.
   */
  readonly init?: boolean
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Ancestor discovery must also notice a broken `.slipmem` symlink. `stat`
 * follows the link and reports nothing, which would hide the configured
 * repository behind a misleading "not found" error.
 */
const isDirectoryOrSymlink = (path: string): boolean => {
  try {
    const stats = lstatSync(path)
    return stats.isDirectory() || stats.isSymbolicLink()
  } catch {
    return false
  }
}

const parent = (path: string): string | null => {
  const next = dirname(path)
  return next === path ? null : next
}

/** Walks up from `start` and returns the nearest existing `.slipmem/`. */
export const findAncestorNoteRoot = (start: string): string | null => {
  let current: string | null = resolve(start)
  while (current !== null) {
    const candidate = join(current, NOTE_ROOT_DIRECTORY)
    if (isDirectoryOrSymlink(candidate)) {
      return candidate
    }
    current = parent(current)
  }
  return null
}

/** Walks up from `start` and returns the nearest directory containing `.git`. */
export const findGitRoot = (start: string): string | null => {
  let current: string | null = resolve(start)
  while (current !== null) {
    if (existsSync(join(current, ".git"))) {
      return current
    }
    current = parent(current)
  }
  return null
}

const rootError = (path: string, message: string): MarkdownError =>
  markdownError({
    area: "repository",
    code: "repository-root-missing",
    path,
    message,
  })

export const rootSymlinkError = (path: string): MarkdownError =>
  markdownError({
    area: "repository",
    code: "symlink",
    path,
    message: `The note root '${path}' is a symbolic link. Point SLIPMEM_DIR (or the repository) at the real directory; slipmem does not follow a linked note root.`,
  })

export const stateSymlinkError = (path: string): MarkdownError =>
  markdownError({
    area: "repository",
    code: "symlink",
    path,
    message: `The local state path '${path}' is a symbolic link or resolves outside the note root. slipmem keeps locks, manifests, quarantine, and backups inside the repository; remove the link and retry.`,
  })

const stateWriteError = (path: string, message: string): MarkdownError =>
  markdownError({
    area: "repository",
    code: "write-failed",
    path,
    message,
  })

/**
 * Rejects a note root that is itself a symlink even when it resolves to an
 * existing directory. A missing path is not this function's concern.
 */
export const symlinkedNoteRoot = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Resolves the note root using the frozen order:
 *
 * 1. `SLIPMEM_DIR`, relative to the working directory when it is not absolute.
 * 2. The nearest ancestor `.slipmem/`.
 * 3. For `init`, the Git root (or current directory) joined with `.slipmem`.
 *
 * The resolved directory is not required to exist except for the ancestor
 * branch, which only matches an existing directory.
 */
export const resolveNoteRoot = (
  options: ResolveNoteRootOptions = {},
): Effect.Effect<NoteRootResolution, MarkdownError> =>
  Effect.gen(function* () {
    const cwd = resolve(options.cwd ?? process.cwd())
    const env = options.env ?? process.env
    const configured = env.SLIPMEM_DIR?.trim()

    if (configured !== undefined && configured.length > 0) {
      const root = resolve(cwd, configured)
      if (symlinkedNoteRoot(root)) {
        return yield* Effect.fail(rootSymlinkError(root))
      }
      return { root, source: "env" as const }
    }

    const ancestor = findAncestorNoteRoot(cwd)
    if (ancestor !== null) {
      if (symlinkedNoteRoot(ancestor)) {
        return yield* Effect.fail(rootSymlinkError(ancestor))
      }
      return { root: ancestor, source: "ancestor" as const }
    }

    if (options.init === true) {
      const gitRoot = findGitRoot(cwd)
      if (gitRoot !== null) {
        return {
          root: join(gitRoot, NOTE_ROOT_DIRECTORY),
          source: "git" as const,
        }
      }
      return {
        root: join(cwd, NOTE_ROOT_DIRECTORY),
        source: "cwd" as const,
      }
    }

    return yield* Effect.fail(
      rootError(
        cwd,
        `No ${NOTE_ROOT_DIRECTORY}/ directory was found. Run 'slipmem init' or set SLIPMEM_DIR.`,
      ),
    )
  })

const STARTER_README = `# slipmem notes

This directory is a slipmem Markdown note repository.

- Every new note is a direct child named \`<title-slug>.md\`; a numeric suffix
  keeps names unique. Legacy \`YYYYMMDDHHmmss-<slug>.md\` names remain valid.
- YAML frontmatter is the metadata; the body is the note.
- \`.state/\` holds local implementation state and is not a note.
- Files are plaintext. Do not store secrets.

Read and edit these files with any tool. Git can version and back them up.
`

export interface InitializeNoteRootResult {
  readonly root: string
  readonly created: boolean
  readonly stateDir: string
  readonly readmePath: string
}

/**
 * Creates an idempotent repository root with local state, a starter README, and
 * a `.gitignore` that keeps `.state/` out of Git. It never deletes anything.
 */
export const initializeNoteRoot = (
  root: string,
): Effect.Effect<InitializeNoteRootResult, MarkdownError> =>
  Effect.gen(function* () {
    const absoluteRoot = resolve(root)
    const stateDir = join(absoluteRoot, STATE_DIRECTORY)
    const readmePath = join(absoluteRoot, "README.md")
    const gitignorePath = join(absoluteRoot, ".gitignore")
    const existed = isDirectory(absoluteRoot)

    if (symlinkedNoteRoot(absoluteRoot)) {
      return yield* Effect.fail(rootSymlinkError(absoluteRoot))
    }

    try {
      mkdirSync(absoluteRoot, { recursive: true, mode: 0o755 })
      ensureStateDirectory(absoluteRoot)
      if (!existsSync(readmePath)) {
        writeFileSync(readmePath, STARTER_README, { encoding: "utf8", flag: "wx" })
      }
      if (!existsSync(gitignorePath)) {
        writeFileSync(gitignorePath, ".state/\n", {
          encoding: "utf8",
          flag: "wx",
        })
      }
    } catch (cause) {
      if (cause instanceof MarkdownError) {
        return yield* Effect.fail(cause)
      }
      return yield* Effect.fail(
        markdownError({
          area: "repository",
          code: "write-failed",
          path: absoluteRoot,
          message: `Could not initialize the note root: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      )
    }

    return {
      root: absoluteRoot,
      created: !existed,
      stateDir,
      readmePath,
    }
  })

const assertStatePath = (
  path: string,
  root: string,
  code: "symlink" | "write-failed",
): void => {
  if (isSymbolicLinkPath(path)) {
    throw stateSymlinkError(path)
  }
  try {
    if (!isPathInside(realpathSync(path), realpathSync(root))) {
      throw stateSymlinkError(path)
    }
  } catch (cause) {
    if (cause instanceof MarkdownError) throw cause
    if (code === "symlink") throw stateSymlinkError(path)
    throw stateWriteError(
      path,
      `Could not verify that the local state path stays inside the note root: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
  }
}

/**
 * Creates `.state/` lazily without turning a missing root into a repository.
 * A symlinked `.state/` is rejected: following it would let lock files,
 * manifests, and quarantine data escape the repository.
 */
export const ensureStateDirectory = (root: string): string => {
  const absoluteRoot = resolve(root)
  const stateDir = join(absoluteRoot, STATE_DIRECTORY)
  if (isSymbolicLinkPath(stateDir)) {
    throw stateSymlinkError(stateDir)
  }

  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  } catch (cause) {
    throw stateWriteError(
      stateDir,
      `Could not create ${STATE_DIRECTORY}/: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
  }

  assertStatePath(stateDir, absoluteRoot, "symlink")
  return stateDir
}

/**
 * Creates one internal state child (for example `.state/migrations/<run>/`)
 * while rejecting a symlink at every level. Only relative, single-segment names
 * are accepted so an internal constant cannot become a traversal.
 */
export const ensureStateSubdirectory = (
  root: string,
  ...segments: ReadonlyArray<string>
): string => {
  const absoluteRoot = resolve(root)
  let current = ensureStateDirectory(absoluteRoot)

  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes(sep)
    ) {
      throw stateWriteError(
        join(current, segment),
        `Refusing to create local state outside ${STATE_DIRECTORY}/ for segment "${segment}".`,
      )
    }

    current = join(current, segment)
    if (isSymbolicLinkPath(current)) {
      throw stateSymlinkError(current)
    }

    try {
      if (!existsSync(current)) {
        mkdirSync(current, { recursive: false, mode: 0o700 })
      } else if (!statSync(current).isDirectory()) {
        throw stateWriteError(
          current,
          `The local state path '${current}' is not a directory.`,
        )
      }
    } catch (cause) {
      if (cause instanceof MarkdownError) throw cause
      throw stateWriteError(
        current,
        `Could not create the local state directory: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      )
    }

    assertStatePath(current, absoluteRoot, "symlink")
  }

  return current
}

export const stateDirectory = (root: string): string =>
  join(resolve(root), STATE_DIRECTORY)

const gitignoreIgnoresState = (content: string): boolean =>
  content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some(
      (line) =>
        line === ".state" ||
        line === ".state/" ||
        line === "/.state" ||
        line === "/.state/",
    )

export interface EnsureStateIgnoredResult {
  readonly path: string
  readonly created: boolean
  readonly changed: boolean
}

/**
 * Ensures `.gitignore` excludes `.state/` without replacing user content.
 * `slipmem init` and an importer that creates a new note root use this; an
 * existing user `.gitignore` is appended to, never rewritten.
 */
export const ensureStateIgnored = (root: string): EnsureStateIgnoredResult => {
  const path = join(resolve(root), ".gitignore")
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null
  if (existing !== null && gitignoreIgnoresState(existing)) {
    return { path, created: false, changed: false }
  }

  if (existing === null) {
    writeFileSync(path, ".state/\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    })
    return { path, created: true, changed: true }
  }

  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n"
  appendFileSync(path, `${prefix}.state/\n`, { encoding: "utf8" })
  return { path, created: false, changed: true }
}

const rootKey = (root: string): string =>
  createHash("sha256").update(resolve(root)).digest("hex").slice(0, 24)

const xdgDirectory = (
  env: Readonly<Record<string, string | undefined>>,
  variable: "XDG_STATE_HOME" | "XDG_CACHE_HOME",
  fallback: string,
): string => resolve(env[variable]?.trim() || join(homedir(), fallback))

/**
 * A per-root, per-user backup directory outside `.slipmem/`.
 * `XDG_STATE_HOME` can be overridden in tests and by operators.
 */
export const defaultBackupDirectory = (
  root: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string =>
  join(
    xdgDirectory(env, "XDG_STATE_HOME", ".local/state"),
    "slipmem",
    "trash",
    rootKey(root),
  )

/** The disposable index lives under the user cache, never in the note root. */
export const defaultIndexCacheDirectory = (
  root: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string =>
  join(
    xdgDirectory(env, "XDG_CACHE_HOME", ".cache"),
    "slipmem",
    "index",
    rootKey(root),
  )

export const isPathInside = (child: string, parentPath: string): boolean => {
  const parentResolved = resolve(parentPath)
  const childResolved = resolve(child)
  return (
    childResolved === parentResolved ||
    childResolved.startsWith(`${parentResolved}${sep}`)
  )
}

export const isSymbolicLinkPath = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Resolves every existing component of a possibly-not-yet-created path. This is
 * the containment check for state and cache directories: a lexical check would
 * treat `backups -> .slipmem` as safely outside even though the write lands
 * inside the note root.
 */
export const realPathOf = (path: string): string => {
  let current = resolve(path)
  const suffix: string[] = []

  for (;;) {
    try {
      return join(realpathSync(current), ...suffix)
    } catch (cause) {
      // A broken or looping symlink is not a path we can prove safe.
      if (isSymbolicLinkPath(current)) {
        throw cause
      }
      const next = dirname(current)
      if (next === current) {
        throw cause
      }
      suffix.unshift(basename(current))
      current = next
    }
  }
}

/** True when the real, symlink-resolved paths are inside one another. */
export const isRealPathInside = (child: string, parentPath: string): boolean =>
  isPathInside(realPathOf(child), realPathOf(parentPath))
