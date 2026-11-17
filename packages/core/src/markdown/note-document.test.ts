import { describe, expect, test } from "bun:test"
import { Markdown } from "@slipmem/schemas/markdown"
import { Effect, Exit } from "effect"
import { readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { MarkdownError } from "./errors.js"
import {
  createMarkdownNoteDocument,
  parseMarkdownNote,
} from "./note-document.js"
import { splitNoteDocument } from "./frontmatter.js"

interface ValidNoteFixture {
  readonly file: string
  readonly id: string
  readonly type: Markdown.NoteType
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly topics: ReadonlyArray<string>
  readonly reference: string | null
  readonly unknownKeys: ReadonlyArray<string>
  readonly bodyIncludes: string
}

interface InvalidNoteFixture {
  readonly file: string
  readonly expected: {
    readonly area: string
    readonly code: string
  }
}

interface NotesManifest {
  readonly valid: ReadonlyArray<ValidNoteFixture>
  readonly invalid: ReadonlyArray<InvalidNoteFixture>
}

const fixtureRoot = join(import.meta.dir, "../../fixtures/phase0")
const notesRoot = join(fixtureRoot, "notes")
const manifest = JSON.parse(
  readFileSync(join(fixtureRoot, "notes.manifest.json"), "utf8"),
) as NotesManifest

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect)

const failure = async <A, E>(
  effect: Effect.Effect<A, E>,
): Promise<MarkdownError> => {
  const exit = await Effect.runPromiseExit(effect)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) {
    throw new Error("Expected a failure")
  }
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined || error._tag !== "Fail") {
    throw new Error("Expected a typed failure")
  }
  return error.error as MarkdownError
}

describe("Markdown note parser", () => {
  for (const fixture of manifest.valid) {
    test(`parses valid fixture ${basename(fixture.file)}`, async () => {
      const path = join(notesRoot, fixture.file)
      const parsed = await run(
        parseMarkdownNote({ path, content: readFileSync(path, "utf8") }),
      )

      expect(parsed.filename).toBe(basename(fixture.file))
      expect(parsed.id).toBe(fixture.id)
      expect(parsed.metadata.id).toBe(fixture.id)
      expect(parsed.metadata.type).toBe(fixture.type)
      expect(parsed.metadata.title).toBe(fixture.title)
      expect(parsed.metadata.createdAt).toBe(fixture.createdAt)
      expect(parsed.metadata.updatedAt).toBe(fixture.updatedAt)
      expect(parsed.metadata.topics ?? []).toEqual(fixture.topics)
      expect(parsed.metadata.reference ?? null).toBe(fixture.reference)
      expect(parsed.body).toContain(fixture.bodyIncludes)
      expect(parsed.info.content).toBe(parsed.body)
      expect(parsed.info.type).toBe(fixture.type)
      expect(parsed.info.createdAt).toBe(Date.parse(fixture.createdAt))
      expect(parsed.info.updatedAt).toBe(Date.parse(fixture.updatedAt))
      expect(String(parsed.info.id)).toBe(fixture.id)
      expect(parsed.contentHash).toMatch(/^[a-f0-9]{64}$/)
      expect(parsed.size).toBeGreaterThan(0)

      if (fixture.type === "literature") {
        expect(parsed.info).toMatchObject({ reference: fixture.reference })
      }
    })
  }

  test("preserves unknown frontmatter keys across a write/read round trip", async () => {
    const fixture = manifest.valid.find(
      (candidate) => candidate.unknownKeys.length > 0,
    )!
    const path = join(notesRoot, fixture.file)
    const parsed = await run(
      parseMarkdownNote({ path, content: readFileSync(path, "utf8") }),
    )

    for (const key of fixture.unknownKeys) {
      expect(parsed.unknown).toHaveProperty(key)
    }

    const rendered = await run(
      createMarkdownNoteDocument({
        path,
        metadata: parsed.metadata,
        body: parsed.body,
        unknown: parsed.unknown,
      }),
    )

    expect(rendered.metadata).toEqual(parsed.metadata)
    expect(rendered.unknown).toEqual(parsed.unknown)
    expect(rendered.body).toBe(parsed.body)
    expect(rendered.contentHash).not.toBe("")
    for (const key of fixture.unknownKeys) {
      expect(readFileSync(path, "utf8")).toContain(`${key}:`)
      expect(
        JSON.stringify({
          metadata: rendered.metadata,
          unknown: rendered.unknown,
          body: rendered.body,
        }),
      ).toContain(key)
    }
  })

  test("renders canonical frontmatter with quoted timestamps", async () => {
    const path = join(notesRoot, "valid/20261117193045-agent-memory-is-bounded.md")
    const parsed = await run(
      parseMarkdownNote({ path, content: readFileSync(path, "utf8") }),
    )
    const content = (
      await run(
        createMarkdownNoteDocument({
          path,
          metadata: parsed.metadata,
          body: parsed.body,
          unknown: parsed.unknown,
        }),
      )
    )

    expect(parsed.metadata.createdAt).toBe("2026-11-17T19:30:45Z")
    expect(content.contentHash).toBeTruthy()

    // Re-render through the pure serializer to inspect the bytes. The parsed
    // value above proves the document is valid; this assertion pins the shape.
    const { renderNoteDocument } = await import("./frontmatter.js")
    const text = renderNoteDocument({
      metadata: parsed.metadata,
      body: parsed.body,
      unknown: parsed.unknown,
    })
    expect(text).toContain('createdAt: "2026-11-17T19:30:45Z"')
    expect(text).toContain('updatedAt: "2026-11-17T19:35:02Z"')
    expect(text.startsWith("---\nschema: 1\n")).toBe(true)
    expect(text.endsWith(`${parsed.body}\n`)).toBe(true)
    expect(text).not.toMatch(/\r\n/)
  })

  test("strips the separator line but preserves internal body formatting", async () => {
    const content = `---\nschema: 1\nid: 20261117193045-formatting\ntype: fleeting\ntitle: Formatting\ncreatedAt: "2026-11-17T19:30:45Z"\nupdatedAt: "2026-11-17T19:30:45Z"\n---\n\nFirst line.\n\n- item one\n- item two\n\n`
    const path = join(notesRoot, "valid/20261117193045-formatting.md")
    const parsed = await run(parseMarkdownNote({ path, content }))

    expect(parsed.body).toBe("First line.\n\n- item one\n- item two")
  })

  test("rejects a note with no frontmatter before validating anything else", async () => {
    const path = join(notesRoot, "valid/20261117193045-no-frontmatter.md")
    const error = await failure(parseMarkdownNote({ path, content: "Just a body.\n" }))
    expect(error.code).toBe("frontmatter-missing")
    expect(error.path).toBe(path)
  })

  test("rejects files over the storage limit without reading YAML", async () => {
    const path = join(notesRoot, "valid/20261117193045-too-big.md")
    const error = await failure(
      parseMarkdownNote({ path, content: "x".repeat(Markdown.MAX_NOTE_FILE_BYTES + 1) }),
    )
    expect(error.code).toBe("file-too-large")
    expect(error.area).toBe("frontmatter")
    expect(error.path).toBe(path)
  })

  test("reports the path for a filename outside the contract", async () => {
    const path = join(notesRoot, "valid/escape.md")
    const error = await failure(parseMarkdownNote({ path, content: "" }))
    expect(error.code).toBe("filename-pattern")
    expect(error.area).toBe("filename")
    // Traversal and symlink checks belong to the repository path guard, which
    // never hands the parser a nested or escaping path.
    expect(error.path).toBe(path)
  })

  test("frontmatter splitting is exposed and keeps a body horizontal rule", async () => {
    const frontmatter = await run(
      splitNoteDocument(
        "note.md",
        `---\na: 1\n---\n\nBefore.\n\n---\n\nAfter.\n`,
      ),
    )
    expect(frontmatter.data).toEqual({ a: 1 })
    expect(frontmatter.body).toBe("Before.\n\n---\n\nAfter.")
  })
})

describe("Phase 0 invalid fixture replay", () => {
  for (const fixture of manifest.invalid) {
    test(`fails ${basename(fixture.file)} with ${fixture.expected.code}`, async () => {
      const path = join(notesRoot, fixture.file)
      const error = await failure(
        parseMarkdownNote({ path, content: readFileSync(path, "utf8") }),
      )

      expect(error.area).toBe(fixture.expected.area as never)
      expect(error.code).toBe(fixture.expected.code as never)
      expect(error.path).toBe(path)
      expect(error.message.length).toBeGreaterThan(0)
    })
  }
})
