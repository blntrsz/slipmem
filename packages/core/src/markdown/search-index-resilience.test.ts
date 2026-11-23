import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeMarkdownNoteRepository } from "./repository.js"
import {
  isIndexCorruptionError,
  isIndexDatabaseMovedError,
  makeMarkdownSearchIndexResilient,
} from "./search-index.js"

test("moved-database and I/O errors are not classified as corruption", () => {
  const moved = new Error("database file has been moved")
  const io = new Error("disk I/O error")

  expect(isIndexDatabaseMovedError(moved)).toBe(true)
  expect(isIndexCorruptionError(moved)).toBe(false)
  expect(isIndexDatabaseMovedError(io)).toBe(false)
  expect(isIndexCorruptionError(io)).toBe(false)
})

test("reopens a cache file replaced by another process instead of reading the old inode", async () => {
  const base = mkdtempSync(join(tmpdir(), "slipmem-resilient-index-"))
  const root = join(base, ".slipmem")
  const cache = join(base, "cache")
  mkdirSync(root, { recursive: true })
  try {
    const repository = await Effect.runPromise(
      makeMarkdownNoteRepository({
        root,
        backupDir: join(base, "backups"),
      }),
    )
    await Effect.runPromise(
      repository.create({
        type: "permanent",
        title: "Before replacement",
        content: "The resilient index must follow the replacement file.",
      }),
    )

    const index = await Effect.runPromise(
      makeMarkdownSearchIndexResilient({ root, cacheDir: cache }),
    )
    try {
      await Effect.runPromise(index.refresh())
      const original = await Effect.runPromise(index.status())
      expect(original.noteCount).toBe(1)

      // Another process repairs or clears the cache by replacing the SQLite
      // file. The old handle still points at the unlinked inode, so a resilient
      // read must verify the path and reopen the replacement.
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        rmSync(`${original.path}${suffix}`, { force: true })
      }
      const replacement = new Database(original.path, { create: true })
      replacement.close()

      const replaced = await Effect.runPromise(index.status())
      expect(replaced.noteCount).toBe(0)

      // The replacement is a valid empty cache; the next refresh repopulates it
      // from Markdown rather than writing into the old inode.
      await Effect.runPromise(index.refresh())
      const refreshed = await Effect.runPromise(index.status())
      expect(refreshed.noteCount).toBe(1)
    } finally {
      await Effect.runPromise(index.close())
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}, 30000)
