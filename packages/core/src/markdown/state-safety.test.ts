import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { join } from "node:path"
import { MarkdownError } from "./errors.js"
import { importMigration } from "../migration/migration-import.js"
import {
  ensureStateDirectory,
  ensureStateSubdirectory,
  initializeNoteRoot,
} from "./root.js"

const temporaryRoot = (): string => mkdtempSync("/tmp/opencode/slipmem-state-")
const temporaryDirectories: Array<string> = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const temporaryDirectory = (): string => {
  const directory = temporaryRoot()
  temporaryDirectories.push(directory)
  return directory
}

const catchError = (run: () => unknown): MarkdownError | null => {
  try {
    run()
    return null
  } catch (cause) {
    return cause instanceof MarkdownError ? cause : null
  }
}

describe("local state path safety", () => {
  test("ensureStateDirectory rejects a symlinked .state", () => {
    const base = temporaryDirectory()
    const root = join(base, "notes")
    const outside = join(base, "outside")
    mkdirSync(root, { recursive: true })
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(root, ".state"))

    const error = catchError(() => ensureStateDirectory(root))

    expect(error?.code).toBe("symlink")
    expect(error?.path).toBe(join(root, ".state"))
    expect(readdirSync(outside)).toEqual([])
  })

  test("ensureStateSubdirectory rejects a symlinked migrations directory", () => {
    const base = temporaryDirectory()
    const root = join(base, "notes")
    const outside = join(base, "outside")
    mkdirSync(root, { recursive: true })
    mkdirSync(outside, { recursive: true })
    ensureStateDirectory(root)
    symlinkSync(outside, join(root, ".state", "migrations"))

    const error = catchError(() =>
      ensureStateSubdirectory(root, "migrations", "run-1"),
    )

    expect(error?.code).toBe("symlink")
    expect(error?.path).toBe(join(root, ".state", "migrations"))
    expect(readdirSync(outside)).toEqual([])
  })

  test("initializeNoteRoot refuses a symlinked .state without writing outside", async () => {
    const base = temporaryDirectory()
    const root = join(base, "notes")
    const outside = join(base, "outside")
    mkdirSync(root, { recursive: true })
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(root, ".state"))

    const exit = await Effect.runPromiseExit(initializeNoteRoot(root))

    expect(Exit.isFailure(exit)).toBe(true)
    let error: MarkdownError | null = null
    if (Exit.isFailure(exit)) {
      const fail = exit.cause.reasons.find((reason) => reason._tag === "Fail")
      if (fail !== undefined && fail._tag === "Fail") {
        error = fail.error as MarkdownError
      }
    }
    expect(error?.code).toBe("symlink")
    expect(readdirSync(outside)).toEqual([])
  })
})

describe("migration state path safety", () => {
  const createDatabase = (directory: string): string => {
    const path = join(directory, "slipmem.db")
    const database = new Database(path)
    try {
      database.exec(`
        CREATE TABLE fleeting_note (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL
        );
        INSERT INTO fleeting_note VALUES
          ('state-note', 'State note', 'Body.', 1794943845000, 1794943845000);
      `)
    } finally {
      database.close()
    }
    return path
  }

  const importErrorCode = (run: () => unknown): string | null => {
    try {
      run()
      return null
    } catch (cause) {
      return typeof cause === "object" && cause !== null && "code" in cause
        ? String((cause as { code: unknown }).code)
        : null
    }
  }

  test("a symlinked .state aborts the import before any note is written", () => {
    const base = temporaryDirectory()
    const root = join(base, "notes")
    const outside = join(base, "outside")
    mkdirSync(root, { recursive: true })
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(root, ".state"))
    const databasePath = createDatabase(base)

    const code = importErrorCode(() =>
      importMigration({ databasePath, noteRoot: root }),
    )

    expect(code).toBe("state-write-failed")
    expect(readdirSync(outside)).toEqual([])
    expect(
      readdirSync(root).filter((entry) => entry.endsWith(".md")),
    ).toEqual([])
  })

  test("a symlinked migrations directory aborts the import safely", () => {
    const base = temporaryDirectory()
    const root = join(base, "notes")
    const outside = join(base, "outside")
    mkdirSync(root, { recursive: true })
    mkdirSync(outside, { recursive: true })
    ensureStateDirectory(root)
    symlinkSync(outside, join(root, ".state", "migrations"))
    const databasePath = createDatabase(base)

    const code = importErrorCode(() =>
      importMigration({ databasePath, noteRoot: root }),
    )

    expect(code).toBe("state-write-failed")
    expect(readdirSync(outside)).toEqual([])
    expect(
      readdirSync(root).filter((entry) => entry.endsWith(".md")),
    ).toEqual([])
  })
})
