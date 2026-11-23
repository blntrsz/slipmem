import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
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
  utimesSync,
  writeFileSync,
} from "node:fs"
import { basename, join } from "node:path"
import { checkNoteRoot } from "./check.js"
import { MarkdownError } from "./errors.js"
import {
  makeMarkdownNoteRepository,
  type MarkdownNoteRepositoryShape,
} from "./repository.js"

const FIXTURES = join(import.meta.dir, "../../fixtures/phase0/notes")
const FIXED_NOW = Date.parse("2026-11-17T21:30:00Z")

interface Fixture {
  readonly base: string
  readonly root: string
  readonly backup: string
}

const setup = (): Fixture => {
  const base = mkdtempSync("/tmp/opencode/slipmem-repo-")
  const root = join(base, ".slipmem")
  const backup = join(base, "backups")
  mkdirSync(root, { recursive: true })
  return { base, root, backup }
}

const cleanup = (fixture: Fixture): void => {
  rmSync(fixture.base, { recursive: true, force: true })
}

const repository = (
  fixture: Fixture,
  now = () => FIXED_NOW,
): Promise<MarkdownNoteRepositoryShape> =>
  Effect.runPromise(
    makeMarkdownNoteRepository({
      root: fixture.root,
      backupDir: fixture.backup,
      now,
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

const copyFixture = (fixture: Fixture, file: string): string => {
  const target = join(fixture.root, basename(file))
  copyFileSync(join(FIXTURES, file), target)
  return target
}

describe("Markdown note repository CRUD", () => {
  test("enforces type-specific content and reference rules before writing", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)

      const missingReference = await failure(
        repo.create({
          type: "literature",
          title: "No source",
          content: "A quote without provenance.",
        }),
      )
      expect(missingReference.code).toBe("missing-reference")

      const tooLong = await failure(
        repo.create({
          type: "permanent",
          title: "Too long",
          content: "a".repeat(2001),
        }),
      )
      expect(tooLong.code).toBe("content-too-long")

      const blank = await failure(
        repo.create({ type: "fleeting", title: "   ", content: "body" }),
      )
      expect(blank.code).toBe("blank-title")

      const emptyTag = await failure(
        repo.create({
          type: "fleeting",
          title: "Tag",
          content: "body",
          tags: ["日本語"],
        }),
      )
      expect(emptyTag.code).toBe("invalid-tag")
      expect(
        readdirSync(fixture.root).filter((name) => name.endsWith(".md")),
      ).toEqual([])
    } finally {
      cleanup(fixture)
    }
  })

  test("reports out-of-range timestamps as typed failures, not defects", async () => {
    const fixture = setup()
    try {
      const maxDate = 8.64e15
      const repo = await repository(fixture)

      const created = await failure(
        repo.create({
          type: "fleeting",
          title: "Far future",
          content: "Body.",
          createdAt: maxDate + 1,
        }),
      )
      expect(created.code).toBe("timestamp-invalid")
      expect(created.field).toBe("createdAt")

      const updated = await failure(
        repo.create({
          type: "fleeting",
          title: "Far future update",
          content: "Body.",
          updatedAt: maxDate + 1,
        }),
      )
      expect(updated.code).toBe("timestamp-invalid")
      expect(updated.field).toBe("updatedAt")

      const brokenClock = await repository(fixture, () => Number.MAX_SAFE_INTEGER)
      const clockError = await failure(
        brokenClock.create({
          type: "fleeting",
          title: "Clock far future",
          content: "Body.",
        }),
      )
      expect(clockError.code).toBe("timestamp-invalid")
      expect(clockError.field).toBe("createdAt")

      expect(
        readdirSync(fixture.root).filter((name) => name.endsWith(".md")),
      ).toEqual([])

      const safe = await Effect.runPromise(
        repo.create({
          type: "fleeting",
          title: "Safe timestamp",
          content: "Original body.",
        }),
      )
      const path = join(fixture.root, safe.filename)
      const before = readFileSync(path, "utf8")
      const updateError = await failure(
        brokenClock.update({ id: safe.id, content: "Replacement body." }),
      )
      expect(updateError.code).toBe("timestamp-invalid")
      expect(updateError.field).toBe("updatedAt")
      expect(readFileSync(path, "utf8")).toBe(before)
    } finally {
      cleanup(fixture)
    }
  })

  test("updates in place, preserves unknown metadata, and writes nothing on failure", async () => {
    const fixture = setup()
    try {
      const source = copyFixture(
        fixture,
        "valid/20261117193045-agent-memory-is-bounded.md",
      )
      const repo = await repository(fixture, () =>
        Date.parse("2026-11-17T23:00:00Z"),
      )

      const updated = await Effect.runPromise(
        repo.update({
          id: "20261117193045-agent-memory-is-bounded",
          content: "A revised and shorter body.",
          tags: ["Agent Memory", "retrieval"],
        }),
      )

      expect(updated.filename).toBe("20261117193045-agent-memory-is-bounded.md")
      expect(updated.metadata.createdAt).toBe("2026-11-17T19:30:45Z")
      expect(updated.metadata.updatedAt).toBe("2026-11-17T23:00:00Z")
      expect(updated.metadata.tags).toEqual(["agent-memory", "retrieval"])
      expect(updated.unknown.reviewStatus).toBe("accepted")
      expect(updated.body).toBe("A revised and shorter body.")

      const text = readFileSync(source, "utf8")
      expect(text).toContain("reviewStatus: accepted")
      expect(text).toContain('createdAt: "2026-11-17T19:30:45Z"')

      const before = readFileSync(source, "utf8")
      const tooLong = await failure(
        repo.update({
          id: "20261117193045-agent-memory-is-bounded",
          content: "b".repeat(2001),
        }),
      )
      expect(tooLong.code).toBe("content-too-long")
      expect(readFileSync(source, "utf8")).toBe(before)
      expect(readdirSync(fixture.root).some((name) => name.endsWith(".tmp"))).toBe(
        false,
      )
    } finally {
      cleanup(fixture)
    }
  })

  test("preserves an existing restrictive file mode on update", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      const created = await Effect.runPromise(
        repo.create({
          type: "fleeting",
          title: "Private note",
          content: "Only the owner may read this.",
        }),
      )
      const path = join(fixture.root, created.filename)
      chmodSync(path, 0o600)

      await Effect.runPromise(
        repo.update({ id: created.id, content: "Still private after an update." }),
      )
      expect(statSync(path).mode & 0o777).toBe(0o600)

      chmodSync(path, 0o640)
      await Effect.runPromise(
        repo.update({ id: created.id, title: "Private note updated" }),
      )
      expect(statSync(path).mode & 0o777).toBe(0o640)

      // No temporary file is left behind with a different mode.
      expect(readdirSync(fixture.root).some((name) => name.endsWith(".tmp"))).toBe(
        false,
      )
    } finally {
      cleanup(fixture)
    }
  })

  test("reclassifies by changing only metadata and keeps the filename", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      const created = await Effect.runPromise(
        repo.create({
          type: "fleeting",
          title: "Reclassify me",
          content: "A thought that becomes durable.",
        }),
      )
      const updated = await Effect.runPromise(
        repo.update({ id: created.id, type: "permanent" }),
      )

      expect(updated.filename).toBe(created.filename)
      expect(updated.metadata.type).toBe("permanent")
      expect(
        readdirSync(fixture.root).filter((name) => name.endsWith(".md")),
      ).toEqual([created.filename])
    } finally {
      cleanup(fixture)
    }
  })

  test("rejects dangerous unknown metadata keys before writing", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      const polluted = JSON.parse('{"__proto__":{"polluted":true}}')

      const createError = await failure(
        repo.create({
          type: "fleeting",
          title: "Unsafe metadata",
          content: "This must never be written.",
          unknown: polluted,
        }),
      )
      expect(createError.area).toBe("frontmatter")
      expect(createError.code).toBe("malformed-yaml")
      expect(createError.field).toBe("__proto__")
      expect(
        ({} as Record<string, unknown>).polluted,
      ).toBeUndefined()
      expect(
        readdirSync(fixture.root).filter((name) => name.endsWith(".md")),
      ).toEqual([])

      const created = await Effect.runPromise(
        repo.create({
          type: "fleeting",
          title: "Safe metadata",
          content: "Original body.",
        }),
      )
      const path = join(fixture.root, created.filename)
      const before = readFileSync(path, "utf8")
      const updateError = await failure(
        repo.update({
          id: created.id,
          content: "Replacement body.",
          unknown: JSON.parse('{"nested":{"constructor":"polluted"}}'),
        }),
      )
      expect(updateError.code).toBe("malformed-yaml")
      expect(updateError.field).toBe("constructor")
      expect(readFileSync(path, "utf8")).toBe(before)
    } finally {
      cleanup(fixture)
    }
  })

  test("preserves compatibility metadata supplied by migration callers", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      const createdAt = Date.parse("2026-11-17T19:30:45Z")
      const created = await Effect.runPromise(
        repo.create({
          type: "permanent",
          title: "Imported note",
          content: "Preserved text.",
          legacyId: "legacy-permanent-1",
          createdAt,
          updatedAt: Date.parse("2026-11-17T20:00:00Z"),
          unknown: { scope: "work", reviewStatus: "accepted" },
        }),
      )

      expect(created.metadata.legacyId).toBe("legacy-permanent-1")
      expect(created.unknown).toEqual({
        scope: "work",
        reviewStatus: "accepted",
      })
      expect(readFileSync(join(fixture.root, created.filename), "utf8")).toContain(
        "scope: work",
      )

      const updated = await Effect.runPromise(
        repo.update({
          id: created.id,
          content: "Updated text.",
          unknown: { reviewStatus: "approved" },
        }),
      )
      expect(updated.unknown).toEqual({
        scope: "work",
        reviewStatus: "approved",
      })
    } finally {
      cleanup(fixture)
    }
  })

  test("preserves unknown nested provenance fields on update", async () => {
    const fixture = setup()
    try {
      const id = "20261117193045-model-provenance"
      const path = join(fixture.root, `${id}.md`)
      writeFileSync(
        path,
        `---\nschema: 1\nid: ${id}\ntype: fleeting\ntitle: Model provenance\ncreatedAt: "2026-11-17T19:30:45Z"\nupdatedAt: "2026-11-17T19:30:45Z"\nprovenance:\n  source: mcp\n  actor: agent:fixture\n  model: local-test-model\n  run:\n    id: run-7\n---\n\nOriginal body.\n`,
      )

      const repo = await repository(fixture, () =>
        Date.parse("2026-11-17T23:00:00Z"),
      )
      const updated = await Effect.runPromise(
        repo.update({ id, content: "Updated body." }),
      )

      const provenance = updated.metadata.provenance as
        | Record<string, unknown>
        | undefined
      expect(provenance).toMatchObject({
        source: "mcp",
        actor: "agent:fixture",
        model: "local-test-model",
        run: { id: "run-7" },
      })

      const text = readFileSync(path, "utf8")
      expect(text).toContain("model: local-test-model")
      expect(text).toContain("run:")
      expect(text).toContain("id: run-7")
      expect(text).toContain("Updated body.")
    } finally {
      cleanup(fixture)
    }
  })

  test("deletes by moving the note to a backup outside the root", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      const created = await Effect.runPromise(
        repo.create({
          type: "fleeting",
          title: "Delete me",
          content: "This file must survive in the backup.",
        }),
      )

      const result = await Effect.runPromise(repo.delete(created.id))
      expect(existsSync(join(fixture.root, created.filename))).toBe(false)
      expect(result.backupPath.startsWith(fixture.backup)).toBe(true)
      expect(result.backupPath.startsWith(fixture.root)).toBe(false)
      expect(readFileSync(result.backupPath, "utf8")).toContain(
        "must survive in the backup",
      )
      expect(
        await failure(repo.delete(created.id)),
      ).toMatchObject({ code: "not-found" })
    } finally {
      cleanup(fixture)
    }
  })
})

describe("Markdown repository path, symlink, size, and lock guards", () => {
  test("rejects traversal-shaped IDs before touching the filesystem", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      const error = await failure(repo.get("../20261117193045-escape"))
      expect(error.code).toBe("path-outside-root")
      expect(error.area).toBe("path")
    } finally {
      cleanup(fixture)
    }
  })

  test("does not read or list a symlinked note", async () => {
    const fixture = setup()
    try {
      const source = copyFixture(
        fixture,
        "valid/20261117193045-agent-memory-is-bounded.md",
      )
      const linkedId = "20261117220000-linked-note"
      symlinkSync(source, join(fixture.root, `${linkedId}.md`))
      const repo = await repository(fixture)

      const error = await failure(repo.get(linkedId))
      expect(error.code).toBe("symlink")

      const list = await Effect.runPromise(repo.list())
      expect(list.map((note) => String(note.id))).not.toContain(linkedId)
      const scan = await Effect.runPromise(repo.scan())
      expect(scan.invalid.map((issue) => issue.code)).toContain("symlink")
    } finally {
      cleanup(fixture)
    }
  })

  test("rejects a symlinked note root consistently on open and check", async () => {
    const fixture = setup()
    try {
      const real = join(fixture.base, "real-notes")
      mkdirSync(real, { recursive: true })
      const linked = join(fixture.base, "linked-notes")
      symlinkSync(real, linked)

      const error = await failure(
        makeMarkdownNoteRepository({
          root: linked,
          backupDir: fixture.backup,
        }),
      )
      expect(error.area).toBe("repository")
      expect(error.code).toBe("symlink")
      expect(error.path).toBe(linked)

      const report = await Effect.runPromise(checkNoteRoot(linked))
      expect(report.ok).toBe(false)
      expect(report.issues.map((issue) => issue.code)).toContain("symlink")
    } finally {
      cleanup(fixture)
    }
  })

  test("refuses a backup directory that is a symlink into the note root", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      const created = await Effect.runPromise(
        repo.create({
          type: "fleeting",
          title: "Keep me",
          content: "Deletion must not move this inside the note root.",
        }),
      )

      const linkedBackup = join(fixture.base, "linked-backups")
      symlinkSync(fixture.root, linkedBackup)
      const unsafe = await Effect.runPromise(
        makeMarkdownNoteRepository({
          root: fixture.root,
          backupDir: linkedBackup,
        }),
      )

      const error = await failure(unsafe.delete(created.id))
      expect(error.area).toBe("repository")
      expect(error.code).toBe("backup-failed")
      expect(
        readdirSync(fixture.root).filter((name) => name.endsWith(".md")),
      ).toEqual([created.filename])
    } finally {
      cleanup(fixture)
    }
  })

  test("resolves a backup directory through an ancestor symlink before writing", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      const created = await Effect.runPromise(
        repo.create({ type: "fleeting", title: "Ancestor", content: "Body." }),
      )

      const outer = join(fixture.base, "outer-link")
      symlinkSync(fixture.root, outer)
      const unsafe = await Effect.runPromise(
        makeMarkdownNoteRepository({
          root: fixture.root,
          backupDir: join(outer, "nested", "backups"),
        }),
      )

      const error = await failure(unsafe.delete(created.id))
      expect(error.code).toBe("backup-failed")
      expect(error.message).toContain("resolves inside the note root")
      expect(existsSync(join(fixture.root, created.filename))).toBe(true)
      expect(existsSync(join(fixture.root, "nested"))).toBe(false)
    } finally {
      cleanup(fixture)
    }
  })

  test("rejects note files larger than 1 MiB on read", async () => {
    const fixture = setup()
    try {
      const id = "20261117193045-oversized"
      writeFileSync(
        join(fixture.root, `${id}.md`),
        "x".repeat(1024 * 1024 + 1),
      )
      const repo = await repository(fixture)
      const error = await failure(repo.get(id))
      expect(error.code).toBe("file-too-large")
    } finally {
      cleanup(fixture)
    }
  })

  test("fails clearly on a live repository lock and recovers from a stale one", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      const state = join(fixture.root, ".state")
      mkdirSync(state, { recursive: true })
      const lockPath = join(state, "repository.lock")
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
          token: "held",
        }),
      )

      const locked = await failure(
        repo.create({ type: "fleeting", title: "Locked", content: "body" }),
      )
      expect(locked.code).toBe("repository-locked")

      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: 2_147_483_647,
          createdAt: new Date().toISOString(),
          token: "stale",
        }),
      )
      const old = new Date(Date.now() - 120_000)
      utimesSync(lockPath, old, old)

      const created = await Effect.runPromise(
        repo.create({ type: "fleeting", title: "Recovered", content: "body" }),
      )
      expect(created.id).toBe("recovered")
      expect(existsSync(lockPath)).toBe(false)
    } finally {
      cleanup(fixture)
    }
  })

  test("bounds list to the default and hard maximum", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      for (let index = 0; index < 12; index++) {
        await Effect.runPromise(
          repo.create({
            type: "fleeting",
            title: `List note ${index}`,
            content: `Body ${index}.`,
          }),
        )
      }

      const defaulted = await Effect.runPromise(repo.list())
      expect(defaulted).toHaveLength(10)
      const requested = await Effect.runPromise(repo.list({ limit: 999 }))
      expect(requested).toHaveLength(12)
    } finally {
      cleanup(fixture)
    }
  })
})

describe("checkNoteRoot", () => {
  test("reports invalid fixtures, unexpected files, and no writes", async () => {
    const fixture = setup()
    try {
      copyFixture(fixture, "valid/20261117193045-agent-memory-is-bounded.md")
      const invalid = copyFixture(
        fixture,
        "invalid/20261117233500-blank-title.md",
      )
      writeFileSync(join(fixture.root, "notes.txt"), "not a note\n")
      writeFileSync(join(fixture.root, "README.md"), "# Notes\n")
      const before = new Set(readdirSync(fixture.root))

      const report = await Effect.runPromise(checkNoteRoot(fixture.root))

      expect(report.ok).toBe(false)
      expect(report.noteCount).toBe(1)
      expect(report.issues.map((issue) => issue.code)).toContain("blank-title")
      expect(report.issues.find((issue) => issue.code === "blank-title")!.path).toBe(
        invalid,
      )
      expect(report.warnings.map((issue) => issue.code)).toContain("unexpected-file")
      expect(new Set(readdirSync(fixture.root))).toEqual(before)

      const clean = await Effect.runPromise(checkNoteRoot(fixture.root, {
        index: [
          {
            id: "20261117193045-agent-memory-is-bounded",
            contentHash: "stale",
          },
          { id: "20261117220000-extra", contentHash: "extra" },
        ],
      }))
      expect(clean.index.checked).toBe(true)
      expect(clean.index.drift).toBe(2)
      expect(clean.warnings.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["index-stale", "index-extra"]),
      )
    } finally {
      cleanup(fixture)
    }
  })

  test("does not report drift for numeric titles or collision suffixes", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      const numeric = await Effect.runPromise(
        repo.create({
          type: "fleeting",
          title: "Agent memory 2",
          content: "A title whose slug ends in a digit.",
        }),
      )
      const first = await Effect.runPromise(
        repo.create({
          type: "fleeting",
          title: "Same second",
          content: "First note.",
        }),
      )
      const second = await Effect.runPromise(
        repo.create({
          type: "fleeting",
          title: "Same second",
          content: "Second note with a collision suffix.",
        }),
      )

      expect(numeric.id).toBe("agent-memory-2")
      expect(second.id).toBe("same-second-2")
      expect(first.id).toBe("same-second")

      const report = await Effect.runPromise(checkNoteRoot(fixture.root))
      expect(report.ok).toBe(true)
      expect(report.warnings.map((issue) => issue.code)).not.toContain(
        "slug-drift",
      )
    } finally {
      cleanup(fixture)
    }
  })

  test("warns on slug drift but does not rename the file", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      const created = await Effect.runPromise(
        repo.create({
          type: "fleeting",
          title: "Original title",
          content: "Body.",
        }),
      )
      await Effect.runPromise(
        repo.update({ id: created.id, title: "A completely new title" }),
      )

      const report = await Effect.runPromise(checkNoteRoot(fixture.root))
      expect(report.ok).toBe(true)
      expect(report.warnings.map((issue) => issue.code)).toContain("slug-drift")
      expect(
        readdirSync(fixture.root).filter((name) => name.endsWith(".md")),
      ).toEqual([created.filename])
    } finally {
      cleanup(fixture)
    }
  })
})
