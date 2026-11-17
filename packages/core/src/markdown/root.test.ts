import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
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
