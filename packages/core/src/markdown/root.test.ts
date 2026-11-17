import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import type { MarkdownError } from "./errors.js"
import {
  defaultBackupDirectory,
  defaultIndexCacheDirectory,
  findAncestorNoteRoot,
  findGitRoot,
  initializeNoteRoot,
  resolveNoteRoot,
} from "./root.js"

const temporaryRoot = (): string => mkdtempSync("/tmp/opencode/slipmem-root-")

const cleanup = (path: string): void => {
  rmSync(path, { recursive: true, force: true })
}

const failure = async <A>(
  effect: Effect.Effect<A, MarkdownError>,
): Promise<MarkdownError> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) {
    throw new Error("Expected a MarkdownError")
  }
  const fail = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (fail === undefined || fail._tag !== "Fail") {
    throw new Error("Expected a typed failure")
  }
  return fail.error
}

describe("note root resolution", () => {
  test("uses SLIPMEM_DIR first, relative to the working directory", async () => {
    const base = temporaryRoot()
    try {
      const cwd = join(base, "workspace")
      mkdirSync(cwd, { recursive: true })
      mkdirSync(join(base, ".slipmem"), { recursive: true })

      const resolution = await Effect.runPromise(
        resolveNoteRoot({
          cwd,
          env: { SLIPMEM_DIR: "custom-notes" },
        }),
      )

      expect(resolution).toEqual({
        root: join(cwd, "custom-notes"),
        source: "env",
      })
    } finally {
      cleanup(base)
    }
  })

  test("walks up to the nearest ancestor .slipmem directory", async () => {
    const base = temporaryRoot()
    try {
      const nested = join(base, "a/b/c")
      mkdirSync(nested, { recursive: true })
      mkdirSync(join(base, ".slipmem"), { recursive: true })
      mkdirSync(join(base, "a", ".slipmem"), { recursive: true })

      expect(findAncestorNoteRoot(nested)).toBe(join(base, "a", ".slipmem"))
      expect(
        await Effect.runPromise(resolveNoteRoot({ cwd: nested, env: {} })),
      ).toEqual({ root: join(base, "a", ".slipmem"), source: "ancestor" })
    } finally {
      cleanup(base)
    }
  })

  test("fails when no repository exists and init is not requested", async () => {
    const base = temporaryRoot()
    try {
      const exit = await Effect.runPromiseExit(
        resolveNoteRoot({ cwd: base, env: {} }),
      )
      expect(exit._tag).toBe("Failure")
    } finally {
      cleanup(base)
    }
  })

  test("rejects a symlinked ancestor root with an actionable typed error", async () => {
    const base = temporaryRoot()
    try {
      const real = join(base, "real-notes")
      const workspace = join(base, "workspace")
      mkdirSync(real, { recursive: true })
      mkdirSync(workspace, { recursive: true })
      symlinkSync(real, join(base, ".slipmem"))

      const error = await failure(
        resolveNoteRoot({ cwd: workspace, env: {} }),
      )
      expect(error.area).toBe("repository")
      expect(error.code).toBe("symlink")
      expect(error.path).toBe(join(base, ".slipmem"))
      expect(error.message).toContain("symbolic link")
      expect(error.message).toContain("SLIPMEM_DIR")
    } finally {
      cleanup(base)
    }
  })

  test("rejects a symlinked SLIPMEM_DIR root instead of following it", async () => {
    const base = temporaryRoot()
    try {
      const real = join(base, "real-notes")
      mkdirSync(real, { recursive: true })
      symlinkSync(real, join(base, "linked-notes"))

      const error = await failure(
        resolveNoteRoot({
          cwd: base,
          env: { SLIPMEM_DIR: "linked-notes" },
        }),
      )
      expect(error.code).toBe("symlink")
      expect(error.path).toBe(join(base, "linked-notes"))
    } finally {
      cleanup(base)
    }
  })

  test("init resolves to the Git root, else the current directory", async () => {
    const gitBase = temporaryRoot()
    const plainBase = temporaryRoot()
    try {
      const nested = join(gitBase, "packages/app")
      mkdirSync(nested, { recursive: true })
      mkdirSync(join(gitBase, ".git"), { recursive: true })

      expect(findGitRoot(nested)).toBe(gitBase)
      expect(
        await Effect.runPromise(
          resolveNoteRoot({ cwd: nested, env: {}, init: true }),
        ),
      ).toEqual({ root: join(gitBase, ".slipmem"), source: "git" })

      expect(
        await Effect.runPromise(
          resolveNoteRoot({ cwd: plainBase, env: {}, init: true }),
        ),
      ).toEqual({ root: join(plainBase, ".slipmem"), source: "cwd" })
    } finally {
      cleanup(gitBase)
      cleanup(plainBase)
    }
  })
})

describe("note root initialization", () => {
  test("creates the root, state, README, and gitignore idempotently", async () => {
    const base = temporaryRoot()
    try {
      const root = join(base, ".slipmem")
      const first = await Effect.runPromise(initializeNoteRoot(root))

      expect(first.created).toBe(true)
      expect(existsSync(join(root, "README.md"))).toBe(true)
      expect(existsSync(join(root, ".state"))).toBe(true)
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(".state/\n")
      expect(readFileSync(join(root, "README.md"), "utf8")).toContain(
        "slipmem notes",
      )

      writeFileSync(join(root, "README.md"), "user edited\n")
      const second = await Effect.runPromise(initializeNoteRoot(root))
      expect(second.created).toBe(false)
      expect(readFileSync(join(root, "README.md"), "utf8")).toBe("user edited\n")
    } finally {
      cleanup(base)
    }
  })

  test("refuses to initialize through a symlinked note root", async () => {
    const base = temporaryRoot()
    try {
      const real = join(base, "real-notes")
      mkdirSync(real, { recursive: true })
      const linked = join(base, ".slipmem")
      symlinkSync(real, linked)

      const error = await failure(initializeNoteRoot(linked))
      expect(error.code).toBe("symlink")
      expect(error.path).toBe(linked)
      expect(existsSync(join(real, "README.md"))).toBe(false)
    } finally {
      cleanup(base)
    }
  })

  test("backup and index directories are outside the root and per-root keyed", () => {
    const root = "/tmp/opencode/example/.slipmem"
    const other = "/tmp/opencode/other/.slipmem"
    const env = {
      XDG_STATE_HOME: "/tmp/opencode/state",
      XDG_CACHE_HOME: "/tmp/opencode/cache",
    }

    const backup = defaultBackupDirectory(root, env)
    const cache = defaultIndexCacheDirectory(root, env)

    expect(backup.startsWith("/tmp/opencode/state/slipmem/trash/")).toBe(true)
    expect(cache.startsWith("/tmp/opencode/cache/slipmem/index/")).toBe(true)
    expect(backup).not.toBe(defaultBackupDirectory(other, env))
    expect(cache).not.toBe(defaultIndexCacheDirectory(other, env))
  })
})
