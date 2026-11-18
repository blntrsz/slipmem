import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { NoteService } from "../note/note.service"
import { MarkdownNoteService } from "../note/markdown-note.service"
import { Effect, Exit, Layer } from "effect"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { checkNoteRoot } from "./check.js"
import { MarkdownError } from "./errors.js"
import {
  MarkdownNoteRepositoryLive,
  makeMarkdownNoteRepository,
  type MarkdownNoteRepositoryShape,
} from "./repository.js"
import {
  INDEX_FILENAME,
  INDEX_SCHEMA_VERSION,
  MarkdownSearchIndexFromRepository,
  makeMarkdownSearchIndex,
  type MarkdownSearchIndexShape,
} from "./search-index.js"

const FIXED_NOW = Date.parse("2026-11-17T21:30:00Z")

interface Fixture {
  readonly base: string
  readonly root: string
  readonly cache: string
  readonly backup: string
}

const setup = (): Fixture => {
  const base = mkdtempSync("/tmp/opencode/slipmem-index-")
  const root = join(base, ".slipmem")
  const cache = join(base, "cache")
  const backup = join(base, "backups")
  mkdirSync(root, { recursive: true })
  return { base, root, cache, backup }
}

const cleanup = (fixture: Fixture): void => {
  rmSync(fixture.base, { recursive: true, force: true })
}

const repository = (fixture: Fixture): Promise<MarkdownNoteRepositoryShape> =>
  Effect.runPromise(
    makeMarkdownNoteRepository({
      root: fixture.root,
      backupDir: fixture.backup,
      now: () => FIXED_NOW,
    }),
  )

const searchIndex = (
  fixture: Fixture,
  forceLinearFallback = false,
): Promise<MarkdownSearchIndexShape> =>
  Effect.runPromise(
    makeMarkdownSearchIndex({
      root: fixture.root,
      cacheDir: fixture.cache,
      forceLinearFallback,
    }),
  )

const failure = async <A>(effect: Effect.Effect<A, MarkdownError>): Promise<MarkdownError> => {
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

const seed = async (
  fixture: Fixture,
): Promise<{
  repo: MarkdownNoteRepositoryShape
  index: MarkdownSearchIndexShape
  ids: Readonly<Record<string, string>>
}> => {
  const repo = await repository(fixture)
  const permanent = await Effect.runPromise(
    repo.create({
      type: "permanent",
      title: "Agent memory is bounded",
      content: "Every recall operation has a hard server-side limit.",
      topics: ["agent-memory", "retrieval"],
    }),
  )
  const literature = await Effect.runPromise(
    repo.create({
      type: "literature",
      title: "MCP recall must cite sources",
      content: "Every recall result identifies the note file and ID.",
      reference: "https://example.com/mcp-recall",
      topics: ["mcp", "citations"],
    }),
  )
  const fleeting = await Effect.runPromise(
    repo.create({
      type: "fleeting",
      title: "Café notes",
      content: "A quick inbox thought about bounded recall.",
      topics: ["cafe"],
    }),
  )
  const index = await searchIndex(fixture)
  return {
    repo,
    index,
    ids: {
      permanent: permanent.id,
      literature: literature.id,
      fleeting: fleeting.id,
    },
  }
}

describe("disposable FTS search index", () => {
  test("rebuilds from files and searches title, body, reference, type, and topic", async () => {
    const fixture = setup()
    const index = await (async () => {
      const seeded = await seed(fixture)
      return seeded
    })()
    try {
      expect(index.index.mode).toBe("fts5")
      const stats = await Effect.runPromise(index.index.rebuild())
      expect(stats.mode).toBe("fts5")
      expect(stats.added).toBe(3)
      expect(stats.invalid).toBe(0)

      const all = await Effect.runPromise(index.index.search({ query: "recall" }))
      expect(new Set(all.map((hit) => hit.id))).toEqual(
        new Set([index.ids.permanent, index.ids.literature, index.ids.fleeting]),
      )

      const titleOnly = await Effect.runPromise(
        index.index.search({ query: "bounded", fields: ["title"] }),
      )
      expect(titleOnly.map((hit) => hit.id)).toEqual([index.ids.permanent])

      const referenceOnly = await Effect.runPromise(
        index.index.search({ query: "example", fields: ["reference"] }),
      )
      expect(referenceOnly.map((hit) => hit.id)).toEqual([index.ids.literature])

      const literatureOnly = await Effect.runPromise(
        index.index.search({ query: "recall", kinds: ["literature"] }),
      )
      expect(literatureOnly.map((hit) => hit.id)).toEqual([index.ids.literature])

      const topicOnly = await Effect.runPromise(
        index.index.search({ query: "recall", topic: "MCP" }),
      )
      expect(topicOnly.map((hit) => hit.id)).toEqual([index.ids.literature])

      const notes = await Effect.runPromise(
        index.index.searchNotes({ query: "cite", kinds: ["literature"] }),
      )
      expect(notes).toHaveLength(1)
      expect(notes[0]).toMatchObject({
        type: "literature",
        title: "MCP recall must cite sources",
        reference: "https://example.com/mcp-recall",
      })
    } finally {
      await Effect.runPromise(index.index.close())
      cleanup(fixture)
    }
  })

  test("bounds default and maximum search results and rejects oversized queries", async () => {
    const fixture = setup()
    const repo = await repository(fixture)
    try {
      for (let index = 0; index < 12; index++) {
        await Effect.runPromise(
          repo.create({
            type: "fleeting",
            title: `Bound note ${index}`,
            content: `common token number ${index}`,
          }),
        )
      }
      const index = await searchIndex(fixture)
      try {
        await Effect.runPromise(index.rebuild())
        const defaulted = await Effect.runPromise(
          index.search({ query: "common" }),
        )
        expect(defaulted).toHaveLength(10)

        const requested = await Effect.runPromise(
          index.search({ query: "common", limit: 500 }),
        )
        expect(requested).toHaveLength(12)

        const tooLong = await failure(
          index.search({ query: "x".repeat(513) }),
        )
        expect(tooLong.area).toBe("index")
        expect(tooLong.code).toBe("index-error")
      } finally {
        await Effect.runPromise(index.close())
      }
    } finally {
      cleanup(fixture)
    }
  })

  test("lists bounded topic counts and filters email-like display topics", async () => {
    const fixture = setup()
    const seeded = await seed(fixture)
    try {
      await Effect.runPromise(seeded.index.rebuild())
      const topics = await Effect.runPromise(
        seeded.index.listTopics({ limit: 2 }),
      )
      expect(topics).toHaveLength(2)
      expect(topics[0]).toMatchObject({ noteCount: 1 })
      expect(topics.map((topic) => topic.topic)).toEqual(
        expect.arrayContaining(["agent-memory"]),
      )

      const mcp = await Effect.runPromise(
        seeded.index.listTopics({ query: "MCP" }),
      )
      expect(mcp).toEqual([{ topic: "mcp", noteCount: 1 }])
    } finally {
      await Effect.runPromise(seeded.index.close())
      cleanup(fixture)
    }
  })

  test("deleting the index and rebuilding returns the same IDs and search results", async () => {
    const fixture = setup()
    const first = await seed(fixture)
    try {
      await Effect.runPromise(first.index.rebuild())
      const beforeSnapshot = await Effect.runPromise(first.index.snapshot())
      const beforeSearch = await Effect.runPromise(
        first.index.search({ query: "recall" }),
      )
      await Effect.runPromise(first.index.close())

      expect(existsSync(join(fixture.cache, INDEX_FILENAME))).toBe(true)
      rmSync(fixture.cache, { recursive: true, force: true })

      const rebuilt = await searchIndex(fixture)
      try {
        const stats = await Effect.runPromise(rebuilt.rebuild())
        expect(stats.added).toBe(3)
        const afterSnapshot = await Effect.runPromise(rebuilt.snapshot())
        const afterSearch = await Effect.runPromise(
          rebuilt.search({ query: "recall" }),
        )

        expect(afterSnapshot.map((entry) => entry.id).sort()).toEqual(
          beforeSnapshot.map((entry) => entry.id).sort(),
        )
        expect(afterSearch.map((hit) => hit.id)).toEqual(
          beforeSearch.map((hit) => hit.id),
        )
      } finally {
        await Effect.runPromise(rebuilt.close())
      }
    } finally {
      cleanup(fixture)
    }
  })

  test("persists derived backlinks and returns bounded typed sources", async () => {
    const fixture = setup()
    const seeded = await seed(fixture)
    try {
      const source = await Effect.runPromise(
        seeded.repo.create({
          type: "fleeting",
          title: "Link source",
          content: "Placeholder before links.",
        }),
      )
      await Effect.runPromise(
        seeded.repo.update({
          id: source.id,
          content: [
            `First [[${seeded.ids.permanent}]]`,
            `Second [literature](${seeded.ids.literature}.md) and [[${seeded.ids.permanent}]]`,
            `Self [[${source.id}]]`,
            "Dangling [[20261117235959-missing]]",
            "Unsafe [bad](../escape.md)",
          ].join("\n"),
        }),
      )
      const second = await Effect.runPromise(
        seeded.repo.create({
          type: "fleeting",
          title: "Second link source",
          content: `Also [[${seeded.ids.permanent}]]`,
        }),
      )

      const stats = await Effect.runPromise(seeded.index.rebuild())
      expect(stats.links).toBe(6)

      const permanentBacklinks = await Effect.runPromise(
        seeded.index.backlinks(seeded.ids.permanent),
      )
      expect(permanentBacklinks.map((entry) => entry.id).sort()).toEqual(
        [source.id, second.id].sort(),
      )
      const first = permanentBacklinks.find((entry) => entry.id === source.id)!
      expect(first).toMatchObject({ linkCount: 2, lines: [1, 2] })
      expect(first.path).toBe(join(fixture.root, `${source.id}.md`))

      expect(
        await Effect.runPromise(seeded.index.backlinks(source.id)),
      ).toEqual([])
      expect(
        await Effect.runPromise(
          seeded.index.backlinks("20261117235959-missing"),
        ),
      ).toEqual([])
      expect(
        (await Effect.runPromise(
          seeded.index.backlinks(seeded.ids.permanent, 1),
        )).length,
      ).toBe(1)

      const status = await Effect.runPromise(seeded.index.status())
      expect(status.schemaVersion).toBe(INDEX_SCHEMA_VERSION)
      await Effect.runPromise(seeded.index.close())

      const db = new Database(join(fixture.cache, INDEX_FILENAME))
      try {
        expect(
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM links")
            .get()!.count,
        ).toBe(6)
        expect(
          db
            .query<{ count: number }, []>(
              "SELECT COUNT(*) AS count FROM links WHERE resolved = 0",
            )
            .get()!.count,
        ).toBe(1)
        expect(
          db
            .query<{ count: number }, [string, string]>(
              "SELECT COUNT(*) AS count FROM links WHERE source_id = ?1 AND target_id = ?2",
            )
            .get(source.id, source.id)!.count,
        ).toBe(1)
      } finally {
        db.close()
      }
    } finally {
      cleanup(fixture)
    }
  })

  test("refreshes backlinks after external edits and deletes", async () => {
    const fixture = setup()
    const seeded = await seed(fixture)
    try {
      const source = await Effect.runPromise(
        seeded.repo.create({
          type: "fleeting",
          title: "Editable link source",
          content: `Only [[${seeded.ids.permanent}]] for now.`,
        }),
      )
      await Effect.runPromise(seeded.index.rebuild())
      expect(
        (await Effect.runPromise(
          seeded.index.backlinks(seeded.ids.permanent),
        )).map((entry) => entry.id),
      ).toEqual([source.id])

      const sourcePath = join(fixture.root, `${source.id}.md`)
      writeFileSync(
        sourcePath,
        readFileSync(sourcePath, "utf8").replace(
          `[[${seeded.ids.permanent}]]`,
          `[[${seeded.ids.literature}]]`,
        ),
      )
      const edited = await Effect.runPromise(seeded.index.refresh())
      expect(edited.updated).toBe(1)
      expect(edited.links).toBe(1)
      expect(
        await Effect.runPromise(
          seeded.index.backlinks(seeded.ids.permanent),
        ),
      ).toEqual([])
      expect(
        (await Effect.runPromise(
          seeded.index.backlinks(seeded.ids.literature),
        )).map((entry) => entry.id),
      ).toEqual([source.id])

      unlinkSync(join(fixture.root, `${seeded.ids.literature}.md`))
      const targetRemoved = await Effect.runPromise(seeded.index.refresh())
      expect(targetRemoved.removed).toBe(1)
      expect(
        await Effect.runPromise(
          seeded.index.backlinks(seeded.ids.literature),
        ),
      ).toEqual([])

      const dbPath = join(fixture.cache, INDEX_FILENAME)
      const db = new Database(dbPath)
      try {
        expect(
          db
            .query<{ resolved: number }, [string, string]>(
              "SELECT resolved FROM links WHERE source_id = ?1 AND target_id = ?2",
            )
            .all(source.id, seeded.ids.literature),
        ).toEqual([{ resolved: 0 }])
      } finally {
        db.close()
      }

      unlinkSync(sourcePath)
      const sourceRemoved = await Effect.runPromise(seeded.index.refresh())
      expect(sourceRemoved.removed).toBe(1)
      expect(
        await Effect.runPromise(
          seeded.index.backlinks(seeded.ids.permanent),
        ),
      ).toEqual([])
      const reopened = new Database(dbPath)
      try {
        expect(
          reopened
            .query<{ count: number }, [string]>(
              "SELECT COUNT(*) AS count FROM links WHERE source_id = ?1",
            )
            .get(source.id)!.count,
        ).toBe(0)
      } finally {
        reopened.close()
      }
    } finally {
      await Effect.runPromise(seeded.index.close())
      cleanup(fixture)
    }
  })

  test("cache loss and copied notes rebuild identical backlink identities", async () => {
    const fixture = setup()
    const seeded = await seed(fixture)
    try {
      const source = await Effect.runPromise(
        seeded.repo.create({
          type: "fleeting",
          title: "Copied link source",
          content: `Reference [[${seeded.ids.permanent}]] and [[${seeded.ids.permanent}]].`,
        }),
      )
      await Effect.runPromise(seeded.index.rebuild())
      const before = await Effect.runPromise(
        seeded.index.backlinks(seeded.ids.permanent),
      )
      expect(before).toHaveLength(1)
      expect(before[0]).toMatchObject({ id: source.id, linkCount: 2 })
      await Effect.runPromise(seeded.index.close())

      rmSync(fixture.cache, { recursive: true, force: true })
      const rebuilt = await searchIndex(fixture)
      try {
        await Effect.runPromise(rebuilt.rebuild())
        expect(
          await Effect.runPromise(rebuilt.backlinks(seeded.ids.permanent)),
        ).toEqual(before)
      } finally {
        await Effect.runPromise(rebuilt.close())
      }

      const copy = setup()
      try {
        for (const name of readdirSync(fixture.root)) {
          if (name.endsWith(".md")) {
            copyFileSync(join(fixture.root, name), join(copy.root, name))
          }
        }
        const copied = await searchIndex(copy)
        try {
          const stats = await Effect.runPromise(copied.rebuild())
          expect(stats.added).toBe(4)
          const copiedBacklinks = await Effect.runPromise(
            copied.backlinks(seeded.ids.permanent),
          )
          expect(copiedBacklinks).toEqual([
            {
              id: source.id,
              path: join(copy.root, `${source.id}.md`),
              linkCount: 2,
              lines: [1],
            },
          ])
        } finally {
          await Effect.runPromise(copied.close())
        }
      } finally {
        cleanup(copy)
      }
    } finally {
      cleanup(fixture)
    }
  })

  test("derives backlinks in the bounded linear fallback", async () => {
    const fixture = setup()
    const seeded = await seed(fixture)
    try {
      const source = await Effect.runPromise(
        seeded.repo.create({
          type: "fleeting",
          title: "Linear link source",
          content: `Fallback [[${seeded.ids.permanent}]].`,
        }),
      )
      await Effect.runPromise(seeded.index.close())

      const linear = await searchIndex(fixture, true)
      try {
        const stats = await Effect.runPromise(linear.rebuild())
        expect(stats.mode).toBe("linear")
        expect(stats.links).toBe(1)
        expect(
          (await Effect.runPromise(
            linear.backlinks(seeded.ids.permanent),
          )).map((entry) => entry.id),
        ).toEqual([source.id])
      } finally {
        await Effect.runPromise(linear.close())
      }
    } finally {
      cleanup(fixture)
    }
  })

  test("refreshes an externally edited file and removes deleted files", async () => {
    const fixture = setup()
    const seeded = await seed(fixture)
    try {
      await Effect.runPromise(seeded.index.rebuild())
      const notePath = join(
        fixture.root,
        `${seeded.ids.permanent}.md`,
      )
      const original = readFileSync(notePath, "utf8")
      expect(original).toContain("server-side limit")
      writeFileSync(
        notePath,
        original.replace("server-side limit", "unbounded external edit"),
      )
      const future = new Date(Date.now() + 2_000)
      utimesSync(notePath, future, future)

      const refreshed = await Effect.runPromise(seeded.index.refresh())
      expect(refreshed.updated).toBe(1)
      expect(refreshed.mode).toBe("fts5")
      const old = await Effect.runPromise(
        seeded.index.search({ query: "limit", fields: ["content"] }),
      )
      expect(old).toHaveLength(0)
      const changed = await Effect.runPromise(
        seeded.index.search({ query: "external", fields: ["content"] }),
      )
      expect(changed.map((hit) => hit.id)).toEqual([seeded.ids.permanent])

      unlinkSync(notePath)
      const removed = await Effect.runPromise(seeded.index.refresh())
      expect(removed.removed).toBe(1)
      const snapshot = await Effect.runPromise(seeded.index.snapshot())
      expect(snapshot.map((entry) => entry.id)).not.toContain(
        seeded.ids.permanent,
      )
    } finally {
      await Effect.runPromise(seeded.index.close())
      cleanup(fixture)
    }
  })

  test("refreshes an external edit that preserves size and mtime", async () => {
    const fixture = setup()
    const seeded = await seed(fixture)
    try {
      await Effect.runPromise(seeded.index.rebuild())
      const notePath = join(fixture.root, `${seeded.ids.permanent}.md`)
      const before = statSync(notePath)
      const original = readFileSync(notePath, "utf8")
      expect(original).toContain("server-side limit")
      writeFileSync(
        notePath,
        original.replace("server-side limit", "server-wide limit"),
      )
      // Restore the exact timestamps so a stat-only refresh cannot notice.
      utimesSync(notePath, before.atime, before.mtime)

      const refreshed = await Effect.runPromise(seeded.index.refresh())
      expect(refreshed.updated).toBe(1)
      expect(refreshed.unchanged).toBe(2)

      const changed = await Effect.runPromise(
        seeded.index.search({ query: "wide", fields: ["content"] }),
      )
      expect(changed.map((hit) => hit.id)).toEqual([seeded.ids.permanent])
      const old = await Effect.runPromise(
        seeded.index.search({ query: "side", fields: ["content"] }),
      )
      expect(old.map((hit) => hit.id)).not.toContain(seeded.ids.permanent)
    } finally {
      await Effect.runPromise(seeded.index.close())
      cleanup(fixture)
    }
  })

  test("rebuilds stale FTS rows after a linear-fallback refresh", async () => {
    const fixture = setup()
    const seeded = await seed(fixture)
    try {
      await Effect.runPromise(seeded.index.rebuild())
      await Effect.runPromise(seeded.index.close())

      const linear = await searchIndex(fixture, true)
      expect(linear.mode).toBe("linear")
      const notePath = join(fixture.root, `${seeded.ids.permanent}.md`)
      writeFileSync(
        notePath,
        readFileSync(notePath, "utf8").replace(
          "server-side limit",
          "linear-only external marker",
        ),
      )
      const stats = await Effect.runPromise(linear.refresh())
      expect(stats.mode).toBe("linear")
      expect(stats.updated).toBe(1)
      await Effect.runPromise(linear.close())

      // FTS row counts still match notes, but the text is stale. Reopening in
      // normal mode must rebuild rather than trust the count.
      const reopened = await searchIndex(fixture)
      try {
        const hits = await Effect.runPromise(
          reopened.search({ query: "external", fields: ["content"] }),
        )
        expect(hits.map((hit) => hit.id)).toEqual([seeded.ids.permanent])
        const old = await Effect.runPromise(
          reopened.search({ query: "side", fields: ["content"] }),
        )
        expect(old.map((hit) => hit.id)).not.toContain(seeded.ids.permanent)
      } finally {
        await Effect.runPromise(reopened.close())
      }
    } finally {
      cleanup(fixture)
    }
  })

  test("repairs FTS text drift even when the fts meta flag says healthy", async () => {
    const fixture = setup()
    const seeded = await seed(fixture)
    try {
      await Effect.runPromise(seeded.index.rebuild())
      await Effect.runPromise(seeded.index.close())

      const dbPath = join(fixture.cache, INDEX_FILENAME)
      const db = new Database(dbPath)
      db.query("UPDATE notes SET body = ? WHERE id = ?").run(
        "content-consistency marker",
        seeded.ids.permanent,
      )
      db.close()

      const reopened = await searchIndex(fixture)
      try {
        const hits = await Effect.runPromise(
          reopened.search({ query: "consistency", fields: ["content"] }),
        )
        expect(hits.map((hit) => hit.id)).toEqual([seeded.ids.permanent])
      } finally {
        await Effect.runPromise(reopened.close())
      }
    } finally {
      cleanup(fixture)
    }
  })

  test("the bounded linear fallback returns the same notes when FTS5 is unavailable", async () => {
    const fixture = setup()
    const seeded = await seed(fixture)
    await Effect.runPromise(seeded.index.close())
    const fallback = await searchIndex(fixture, true)
    try {
      expect(fallback.mode).toBe("linear")
      const stats = await Effect.runPromise(fallback.rebuild())
      expect(stats.mode).toBe("linear")
      const hits = await Effect.runPromise(
        fallback.search({ query: "recall", topic: "agent-memory" }),
      )
      expect(hits.map((hit) => hit.id)).toEqual([seeded.ids.permanent])

      const literature = await Effect.runPromise(
        fallback.search({ query: "example", fields: ["reference"] }),
      )
      expect(literature.map((hit) => hit.id)).toEqual([seeded.ids.literature])

      const topics = await Effect.runPromise(fallback.listTopics())
      expect(topics).toEqual(
        expect.arrayContaining([
          { topic: "mcp", noteCount: 1 },
          { topic: "agent-memory", noteCount: 1 },
        ]),
      )
    } finally {
      await Effect.runPromise(fallback.close())
      cleanup(fixture)
    }
  })

  test("check consumes index fingerprints and reports drift without failing", async () => {
    const fixture = setup()
    const seeded = await seed(fixture)
    try {
      await Effect.runPromise(seeded.index.rebuild())
      const snapshot = await Effect.runPromise(seeded.index.snapshot())
      const clean = await Effect.runPromise(
        checkNoteRoot(fixture.root, { index: snapshot }),
      )
      expect(clean.ok).toBe(true)
      expect(clean.index).toEqual({ checked: true, drift: 0 })

      const notePath = join(fixture.root, `${seeded.ids.permanent}.md`)
      writeFileSync(notePath, `${readFileSync(notePath, "utf8")}\nExternal.\n`)
      const dirty = await Effect.runPromise(
        checkNoteRoot(fixture.root, { index: snapshot }),
      )
      expect(dirty.ok).toBe(true)
      expect(dirty.index.drift).toBe(1)
      expect(dirty.warnings.map((issue) => issue.code)).toContain("index-stale")

      const withExtra = await Effect.runPromise(
        checkNoteRoot(fixture.root, {
          index: [...snapshot, { id: "20261117220000-extra", contentHash: "x" }],
        }),
      )
      expect(withExtra.warnings.map((issue) => issue.code)).toContain("index-extra")
    } finally {
      await Effect.runPromise(seeded.index.close())
      cleanup(fixture)
    }
  })

  test("refuses to place the disposable index inside the note root", async () => {
    const fixture = setup()
    try {
      const error = await failure(
        makeMarkdownSearchIndex({
          root: fixture.root,
          cacheDir: join(fixture.root, "cache"),
        }),
      )
      expect(error.area).toBe("index")
      expect(error.code).toBe("index-error")
      expect(existsSync(join(fixture.root, "cache"))).toBe(false)
    } finally {
      cleanup(fixture)
    }
  })

  test("refuses a cache directory symlinked into the note root before chmod or create", async () => {
    const fixture = setup()
    try {
      chmodSync(fixture.root, 0o755)
      const linkedCache = join(fixture.base, "linked-cache")
      symlinkSync(fixture.root, linkedCache)

      const error = await failure(
        makeMarkdownSearchIndex({
          root: fixture.root,
          cacheDir: linkedCache,
        }),
      )
      expect(error.area).toBe("index")
      expect(error.code).toBe("index-error")
      expect(error.message).toContain("note root")
      expect(statSync(fixture.root).mode & 0o777).toBe(0o755)
      expect(existsSync(join(fixture.root, INDEX_FILENAME))).toBe(false)
    } finally {
      cleanup(fixture)
    }
  })

  test("resolves a cache path through an ancestor symlink before creating it", async () => {
    const fixture = setup()
    try {
      const outer = join(fixture.base, "outer-cache-link")
      symlinkSync(fixture.root, outer)

      const error = await failure(
        makeMarkdownSearchIndex({
          root: fixture.root,
          cacheDir: join(outer, "nested", "cache"),
        }),
      )
      expect(error.area).toBe("index")
      expect(error.message).toContain("symlink")
      expect(existsSync(join(fixture.root, "nested"))).toBe(false)
    } finally {
      cleanup(fixture)
    }
  })

  test("refuses a symlinked index file", async () => {
    const fixture = setup()
    try {
      mkdirSync(fixture.cache, { recursive: true })
      const realIndex = join(fixture.base, "elsewhere.sqlite")
      const db = new Database(realIndex, { create: true })
      db.close()
      symlinkSync(realIndex, join(fixture.cache, INDEX_FILENAME))

      const error = await failure(
        makeMarkdownSearchIndex({
          root: fixture.root,
          cacheDir: fixture.cache,
        }),
      )
      expect(error.area).toBe("index")
      expect(error.message).toContain("must not be a symbolic link")
    } finally {
      cleanup(fixture)
    }
  })

  test("index files are user-only and a schema bump rebuilds without migration", async () => {
    const fixture = setup()
    const seeded = await seed(fixture)
    try {
      const source = await Effect.runPromise(
        seeded.repo.create({
          type: "fleeting",
          title: "Schema bump link source",
          content: `Rebuilt [[${seeded.ids.permanent}]].`,
        }),
      )
      await Effect.runPromise(seeded.index.rebuild())
      const dbPath = join(fixture.cache, INDEX_FILENAME)
      expect(statSync(fixture.cache).mode & 0o777).toBe(0o700)
      expect(statSync(dbPath).mode & 0o777).toBe(0o600)
      await Effect.runPromise(seeded.index.close())

      // Simulate a version 1 cache: no links table and an older schema stamp.
      const db = new Database(dbPath)
      db.exec("DROP TABLE links;")
      db.query("UPDATE meta SET value = '1' WHERE key = 'schema'").run()
      db.close()

      const upgraded = await searchIndex(fixture)
      try {
        expect(
          (await Effect.runPromise(upgraded.status())).schemaVersion,
        ).toBe(INDEX_SCHEMA_VERSION)
        const stats = await Effect.runPromise(upgraded.rebuild())
        expect(stats.added).toBe(4)
        expect(stats.links).toBe(1)
        expect(
          (await Effect.runPromise(
            upgraded.backlinks(seeded.ids.permanent),
          )).map((entry) => entry.id),
        ).toEqual([source.id])
      } finally {
        await Effect.runPromise(upgraded.close())
      }
    } finally {
      cleanup(fixture)
    }
  })

  test("MarkdownNoteService adapts the repository and index to the existing NoteService", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      await Effect.runPromise(
        repo.create({
          type: "permanent",
          title: "Adapted service",
          content: "The note service reads Markdown files.",
          topics: ["adapter"],
        }),
      )

      const repoLayer = MarkdownNoteRepositoryLive({
        root: fixture.root,
        backupDir: fixture.backup,
        now: () => FIXED_NOW,
      })
      const indexLayer = MarkdownSearchIndexFromRepository({
        cacheDir: fixture.cache,
      })
      const services = Layer.provideMerge(indexLayer, repoLayer)
      const noteLayer = Layer.provide(MarkdownNoteService, services)

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const notes = yield* NoteService
          return {
            list: yield* notes.list({}),
            titles: yield* notes.listTitles({}),
            search: yield* notes.search({ query: "Markdown" }),
          }
        }).pipe(Effect.provide(noteLayer)),
      )

      expect(result.list).toHaveLength(1)
      expect(result.titles).toEqual([
        { id: result.list[0]!.id, type: "permanent", title: "Adapted service" },
      ])
      expect(result.search).toHaveLength(1)
      expect(result.search[0]!.type).toBe("permanent")
    } finally {
      cleanup(fixture)
    }
  })
})
