import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import {
  checkNoteRoot,
  FleetingNoteService,
  LiteratureNoteService,
  PermanentNoteService,
  readNoteFile,
} from "@slipmem/core"
import {
  getLegacyNote,
  importMigration,
  listLegacyNotes,
} from "@slipmem/core/legacy/migration"
import { Markdown } from "@slipmem/schemas/markdown"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeDatabaseLayer } from "./database.js"

const fixtureRoot = join(
  import.meta.dir,
  "../../core/fixtures/phase0/migration",
)
const temporaryDirectories: Array<string> = []
const FIXED_NOW = 1794943845000

const fixtureSql = (name: string): string =>
  readFileSync(join(fixtureRoot, name), "utf8")

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "slipmem-current-migration-"))
  temporaryDirectories.push(directory)
  return directory
}

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex")

const count = (databasePath: string, table: string): number => {
  const database = new Database(databasePath, { readonly: true })
  try {
    return Number(
      database
        .query<{ readonly count: number }, []>(
          `SELECT COUNT(*) AS count FROM "${table}"`,
        )
        .get()?.count ?? 0,
    )
  } finally {
    database.close()
  }
}

const realStartup = (databasePath: string) =>
  makeDatabaseLayer(databasePath)

describe("migration against the real startup database", () => {
  test(
    "imports notes seeded through the SQLite note services after runMigrations",
    async () => {
      const directory = temporaryDirectory()
      const databasePath = join(directory, "slipmem.db")
      const target = join(directory, "notes")

      const seeded = await Effect.runPromise(
        Effect.gen(function* () {
          const fleeting = yield* FleetingNoteService
          const permanent = yield* PermanentNoteService
          const literature = yield* LiteratureNoteService

          const fleetingCreated = yield* fleeting.create({
            title: "Real fleeting — cutover",
            content: "First line.\nSecond line with 'quotes' and emoji 🧠.",
          })
          const permanentCreated = yield* permanent.create({
            title: "Real permanent",
            content: "A lasting idea from the running store.",
          })
          const literatureCreated = yield* literature.create({
            title: "Real literature",
            content: "A source-backed quote.",
            reference: "Book, chapter 2",
          })

          // Exercise the real update path so createdAt and updatedAt differ.
          yield* Effect.promise(() => Bun.sleep(5))
          const fleetingUpdated = yield* fleeting.update({
            id: fleetingCreated.id,
            title: fleetingCreated.title,
            content: fleetingCreated.content,
          })

          return {
            fleeting: fleetingUpdated,
            permanent: permanentCreated,
            literature: literatureCreated,
          }
        }).pipe(Effect.provide(realStartup(databasePath))),
      )

      // The source was created by the same startup layer the servers use:
      // runMigrations through the checked-in Drizzle folder, not hand-built SQL.
      expect(count(databasePath, "__drizzle_migrations")).toBe(1)
      expect(count(databasePath, "fleeting_note")).toBe(1)
      expect(count(databasePath, "permanent_note")).toBe(1)
      expect(count(databasePath, "literature_note")).toBe(1)

      const before = readFileSync(databasePath)
      const sourceHash = sha256(before)

      const report = importMigration({
        databasePath,
        noteRoot: target,
        now: () => FIXED_NOW,
      })

      expect(report.status).toBe("imported")
      expect(report.ok).toBe(true)
      expect(report.plan.source.shape).toBe("bootstrap")
      expect(report.counts).toMatchObject({
        sourceRows: 3,
        plannedNotes: 3,
        writtenNotes: 3,
        malformedRows: 0,
        quarantinedRows: 0,
      })
      expect(report.sourceCheck.unchanged).toBe(true)
      expect(report.sourceCheck.before.sha256).toBe(sourceHash)
      expect(report.sourceCheck.after.sha256).toBe(sourceHash)
      expect(sha256(readFileSync(databasePath))).toBe(sourceHash)
      expect(report.verification).toMatchObject({
        verified: true,
        ok: true,
        writtenNotes: 3,
        missing: [],
        mismatched: [],
        unexpected: [],
      })

      const imported = new Map(
        report.notes.map((note) => [note.legacyId, note]),
      )
      expect(imported.size).toBe(3)

      const verify = (
        source: {
          readonly id: string
          readonly title: string
          readonly content: string
          readonly createdAt: number
          readonly updatedAt: number
        },
        type: "fleeting" | "permanent" | "literature",
        reference?: string,
      ) => {
        const note = imported.get(source.id)
        expect(note).toBeDefined()
        expect(note!.type).toBe(type)
        expect(note!.sourceRowHash).toMatch(/^[0-9a-f]{64}$/)
        expect(note!.plannedContentHash).toMatch(/^[0-9a-f]{64}$/)

        const file = readFileSync(join(target, note!.filename))
        const fileHash = sha256(file)
        expect(note!.actualFileHash).toBe(fileHash)
        expect(note!.expectedFileHash).toBe(fileHash)
        expect(
          report.verification.notes.find(
            (entry) => entry.legacyId === source.id,
          )?.actualFileHash,
        ).toBe(fileHash)

        const parsed = Effect.runSync(
          readNoteFile(target, note!.filename.slice(0, -".md".length)),
        )
        expect(parsed).not.toBeNull()
        expect(parsed?.metadata).toMatchObject({
          type,
          title: source.title,
          createdAt: Markdown.toUtcTimestamp(source.createdAt).isoTimestamp,
          updatedAt: Markdown.toUtcTimestamp(source.updatedAt).isoTimestamp,
          legacyId: source.id,
          provenance: { source: "import" },
        })
        expect(parsed?.body).toBe(source.content)
        if (reference === undefined) {
          expect(parsed?.metadata.reference).toBeUndefined()
        } else {
          expect(parsed?.metadata.reference).toBe(reference)
        }
        expect(parsed?.unknown["scope"]).toBe("global")
      }

      verify(seeded.fleeting, "fleeting")
      verify(seeded.permanent, "permanent")
      verify(seeded.literature, "literature", "Book, chapter 2")

      const check = Effect.runSync(checkNoteRoot(target))
      expect(check.ok).toBe(true)
      expect(check.noteCount).toBe(3)

      // The same compatibility reader sees the rows before they are archived,
      // and it must agree with the importer without writing anything.
      const listed = listLegacyNotes({ databasePath, limit: 10 })
      expect(listed.readOnly).toBe(true)
      expect(listed.total).toBe(3)
      expect(listed.rows.every((row) => row.valid)).toBe(true)
      expect(
        listed.rows.map((row) => [row.type, row.legacyId]),
      ).toEqual(
        expect.arrayContaining([
          ["fleeting", seeded.fleeting.id],
          ["permanent", seeded.permanent.id],
          ["literature", seeded.literature.id],
        ]),
      )
      const fetched = getLegacyNote({
        databasePath,
        type: "literature",
        legacyId: seeded.literature.id,
      })
      expect(fetched.row?.note).toMatchObject({
        title: seeded.literature.title,
        body: seeded.literature.content,
        reference: "Book, chapter 2",
        createdAt: seeded.literature.createdAt,
        updatedAt: seeded.literature.updatedAt,
      })
      expect(sha256(readFileSync(databasePath))).toBe(sourceHash)
    },
  )

  test("adopts the existing legacy bootstrap shape before importing", async () => {
    const directory = temporaryDirectory()
    const databasePath = join(directory, "slipmem.db")
    const bootstrap = new Database(databasePath)
    try {
      bootstrap.exec(fixtureSql("legacy.sql"))
    } finally {
      bootstrap.close()
    }
    const target = join(directory, "notes")

    // The real startup migrator validates and adopts the frozen handwritten
    // bootstrap shape rather than recreating or rewriting its tables.
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* FleetingNoteService
        yield* PermanentNoteService
        yield* LiteratureNoteService
      }).pipe(Effect.provide(realStartup(databasePath))),
    )
    expect(count(databasePath, "__drizzle_migrations")).toBe(1)
    expect(count(databasePath, "fleeting_note")).toBe(1)
    expect(count(databasePath, "permanent_note")).toBe(1)
    expect(count(databasePath, "literature_note")).toBe(1)

    const before = readFileSync(databasePath)
    const sourceHash = sha256(before)
    const report = importMigration({
      databasePath,
      noteRoot: target,
      now: () => FIXED_NOW,
    })

    expect(report.status).toBe("imported")
    expect(report.plan.source.shape).toBe("bootstrap")
    expect(report.counts.writtenNotes).toBe(3)
    expect(report.sourceCheck.unchanged).toBe(true)
    expect(sha256(readFileSync(databasePath))).toBe(sourceHash)

    const verify = (
      legacyId: string,
      type: "fleeting" | "permanent" | "literature",
      title: string,
      body: string,
      createdAt: number,
      updatedAt: number,
      reference?: string,
    ) => {
      const note = report.notes.find((entry) => entry.legacyId === legacyId)
      expect(note).toBeDefined()
      expect(note!.type).toBe(type)
      const parsed = Effect.runSync(
        readNoteFile(target, note!.filename.slice(0, -".md".length)),
      )
      expect(parsed?.metadata).toMatchObject({
        type,
        title,
        createdAt: Markdown.toUtcTimestamp(createdAt).isoTimestamp,
        updatedAt: Markdown.toUtcTimestamp(updatedAt).isoTimestamp,
        legacyId,
        provenance: { source: "import" },
      })
      expect(parsed?.body).toBe(body)
      if (reference === undefined) {
        expect(parsed?.metadata.reference).toBeUndefined()
      } else {
        expect(parsed?.metadata.reference).toBe(reference)
      }
    }

    verify(
      "legacy-fleeting",
      "fleeting",
      "Legacy fleeting",
      "Old inbox thought.",
      1794943845000,
      1794943902000,
    )
    verify(
      "legacy-permanent",
      "permanent",
      "Legacy permanent",
      "Old lasting idea.",
      1794951000000,
      1794951060000,
    )
    verify(
      "legacy-literature",
      "literature",
      "Legacy literature",
      "Old source-backed quote.",
      1794946500000,
      1794946560000,
      "Legacy book",
    )
  })
})
