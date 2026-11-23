import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MarkdownError } from "./errors.js"
import {
  makeMarkdownNoteRepository,
  type MarkdownNoteRepositoryShape,
} from "./repository.js"

const FIXED_NOW = Date.parse("2026-11-17T21:30:00Z")

interface Fixture {
  readonly base: string
  readonly root: string
  readonly backup: string
}

const setup = (): Fixture => {
  const base = mkdtempSync(join(tmpdir(), "slipmem-exact-id-"))
  const root = join(base, ".slipmem")
  const backup = join(base, "backups")
  mkdirSync(root, { recursive: true })
  return { base, root, backup }
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

const noteFiles = (root: string): ReadonlyArray<string> =>
  readdirSync(root).filter((name) => name.endsWith(".md"))

describe("exact-ID note creation", () => {
  test("writes the requested ID instead of allocating a title suffix", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      const created = await Effect.runPromise(
        repo.create({
          id: "reserved-note",
          type: "permanent",
          title: "A Different Title",
          content: "Exact ID body.",
          tags: ["Exact Tag"],
          unknown: { custom: "preserved" },
        }),
      )

      expect(created.id).toBe("reserved-note")
      expect(created.filename).toBe("reserved-note.md")
      expect(created.metadata.title).toBe("A Different Title")
      expect(created.unknown).toEqual({ custom: "preserved" })
      expect(noteFiles(fixture.root)).toEqual(["reserved-note.md"])

      const stored = await Effect.runPromise(repo.get("reserved-note"))
      expect(stored._tag).toBe("Some")
      if (stored._tag === "Some") {
        expect(stored.value.contentHash).toBe(created.contentHash)
        expect(stored.value.body).toBe("Exact ID body.")
      }
    } finally {
      cleanup(fixture)
    }
  })

  test("fails with target-exists and leaves the existing note byte-identical", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      const first = await Effect.runPromise(
        repo.create({
          id: "taken-id",
          type: "fleeting",
          title: "First occupant",
          content: "Original body.",
        }),
      )

      const error = await failure(
        repo.create({
          id: "taken-id",
          type: "fleeting",
          title: "Second occupant",
          content: "Replacement body.",
        }),
      )

      expect(error.code).toBe("target-exists")
      expect(noteFiles(fixture.root)).toEqual(["taken-id.md"])
      const stored = await Effect.runPromise(repo.get("taken-id"))
      expect(stored._tag).toBe("Some")
      if (stored._tag === "Some") {
        expect(stored.value.contentHash).toBe(first.contentHash)
        expect(stored.value.body).toBe("Original body.")
      }
    } finally {
      cleanup(fixture)
    }
  })

  test("serializes concurrent exact-ID creates under the repository lock", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      const results = await Promise.allSettled([
        Effect.runPromise(
          repo.create({
            id: "one-winner",
            type: "fleeting",
            title: "First",
            content: "First body.",
          }),
        ),
        Effect.runPromise(
          repo.create({
            id: "one-winner",
            type: "fleeting",
            title: "Second",
            content: "Second body.",
          }),
        ),
      ])

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      )
      expect(rejected).toHaveLength(1)
      const reason = rejected[0]!.reason
      expect(reason).toBeInstanceOf(MarkdownError)
      expect((reason as MarkdownError).code).toBe("target-exists")
      expect(noteFiles(fixture.root)).toEqual(["one-winner.md"])
    } finally {
      cleanup(fixture)
    }
  })

  test("rejects a non-note ID before writing anything", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      const error = await failure(
        repo.create({
          id: "../escape",
          type: "fleeting",
          title: "Escape",
          content: "Body.",
        }),
      )

      expect(error.code).toBe("path-outside-root")
      expect(noteFiles(fixture.root)).toEqual([])
      expect(existsSync(join(fixture.base, "escape.md"))).toBe(false)
    } finally {
      cleanup(fixture)
    }
  })
})
