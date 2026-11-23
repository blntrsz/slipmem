import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { checkNoteRoot, extractInternalMarkdownLinks } from "./check.js"
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
  const base = mkdtempSync(join(tmpdir(), "slipmem-link-check-"))
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

const copyFixture = (fixture: Fixture, file: string): string => {
  const target = join(fixture.root, basename(file))
  copyFileSync(join(FIXTURES, file), target)
  return target
}

describe("extractInternalMarkdownLinks", () => {
  test("ignores code, comments, anchors, external URLs, and escaped links", () => {
    const body = [
      "[[20261117193045-target]]",
      "[[20261117193045-target#heading|alias]]",
      "[direct](20261117193045-target.md#heading)",
      "[anchor](#local-heading)",
      "[external](https://example.com/20261117193045-target.md)",
      "[mail](mailto:person@example.com)",
      "<https://example.com/20261117193045-target.md>",
      "`[[inline-missing]]` and `[inline](missing.md)`",
      "```md",
      "[[fenced-missing]]",
      "[fenced](missing.md)",
      "```",
      "\\[[escaped-wikilink]] and \\[escaped](missing.md)",
      "<!-- [[comment-missing]] [comment](missing.md) -->",
      "[ref]: 20261117193045-target.md",
    ].join("\n")

    expect(extractInternalMarkdownLinks(body)).toEqual([
      {
        kind: "wikilink",
        line: 1,
        raw: "[[20261117193045-target]]",
        target: "20261117193045-target",
        status: "candidate",
      },
      {
        kind: "wikilink",
        line: 2,
        raw: "[[20261117193045-target#heading|alias]]",
        target: "20261117193045-target",
        status: "candidate",
      },
      {
        kind: "markdown",
        line: 3,
        raw: "[direct](20261117193045-target.md#heading)",
        target: "20261117193045-target.md",
        status: "candidate",
      },
      {
        kind: "markdown",
        line: 15,
        raw: "[ref]: 20261117193045-target.md",
        target: "20261117193045-target.md",
        status: "candidate",
      },
    ])
  })
})

describe("checkNoteRoot link validation", () => {
  test("accepts aliases, anchors, direct .md links, and external URLs", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      const target = await Effect.runPromise(
        repo.create({
          type: "fleeting",
          title: "Target note",
          content: "The target note.",
        }),
      )
      const source = await Effect.runPromise(
        repo.create({
          type: "fleeting",
          title: "Source note",
          content: [
            "# Links",
            "",
            `- [[${target.id}]]`,
            `- [[${target.id}|a display alias]]`,
            `- [[${target.id}#heading]]`,
            `- [[${target.id}.md|a stem with a Markdown suffix]]`,
            `- [direct](${target.filename})`,
            `- [dot](./${target.filename})`,
            `- [anchor](${target.filename}#heading)`,
            `- [query](${target.filename}?view=1)`,
            "- [reference style][target-ref]",
            `[target-ref]: ${target.filename}`,
            `- [external](https://example.com/${target.filename})`,
            `- [mail](mailto:person@example.com)`,
            "",
            "`[[inline-missing]]` and `[inline](missing.md)`",
            "",
            "```md",
            "[[fenced-missing]] and [fenced](missing.md)",
            "```",
            "",
            "\\[[escaped-wikilink]] and \\[escaped](missing.md)",
            "",
            "<!-- [[comment-missing]] [comment](missing.md) -->",
          ].join("\n"),
        }),
      )
      const before = readFileSync(source.path)

      const report = await Effect.runPromise(checkNoteRoot(fixture.root))

      expect(report.ok).toBe(true)
      expect(report.issues).toEqual([])
      expect(report.links.checked).toBe(9)
      expect(report.links.broken).toBe(0)
      expect(report.links.backlinks).toEqual([
        { id: target.id, sources: [source.id] },
      ])
      expect(readFileSync(source.path)).toEqual(before)
    } finally {
      cleanup(fixture)
    }
  })

  test("reports broken, malformed, and path-injection links with source lines", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      const source = await Effect.runPromise(
        repo.create({
          type: "fleeting",
          title: "Broken links",
          content: [
            "[[missing-note]]",
            "[broken](missing.md)",
            "[nested](sub/other.md)",
            "[[../escape]]",
            "[traversal](../secret.md)",
            "[[ ]]",
            "[encoded](%2e%2e/secret.md)",
            "[absolute](/etc/note.md)",
            "[windows](notes\\escape.md)",
          ].join("\n"),
        }),
      )

      const report = await Effect.runPromise(checkNoteRoot(fixture.root))

      expect(report.ok).toBe(false)
      expect(report.links.checked).toBe(9)
      expect(report.links.broken).toBe(9)
      expect(report.links.backlinks).toEqual([])
      expect(report.issues.map((issue) => issue.code)).toEqual([
        "broken-link",
        "broken-link",
        "unsafe-link",
        "unsafe-link",
        "unsafe-link",
        "malformed-link",
        "unsafe-link",
        "unsafe-link",
        "unsafe-link",
      ])
      for (const issue of report.issues) {
        expect(issue.severity).toBe("error")
        expect(issue.area).toBe("body")
        expect(issue.field).toBe("body")
        expect(issue.path).toBe(source.path)
        expect(issue.message).toMatch(/\(line \d+\)$/)
      }
      expect(report.issues[0]!.message).toContain("missing-note")
      expect(report.issues[2]!.message).toContain("sub/other.md")
      expect(report.issues[5]!.message).toContain("target is empty")
    } finally {
      cleanup(fixture)
    }
  })

  test("derives sorted backlinks from multiple source notes without self-links", async () => {
    const fixture = setup()
    try {
      const repo = await repository(fixture)
      const target = await Effect.runPromise(
        repo.create({
          type: "fleeting",
          title: "Backlink target",
          content: "The target note.",
        }),
      )
      const second = await Effect.runPromise(
        repo.create({
          type: "fleeting",
          title: "Second source",
          content: `See [[${target.id}]].`,
        }),
      )
      const first = await Effect.runPromise(
        repo.create({
          type: "fleeting",
          title: "First source",
          content: `See [the target](${target.filename}).`,
        }),
      )
      await Effect.runPromise(
        repo.update({
          id: target.id,
          content: `Self-links are not backlinks: [[${target.id}]].`,
        }),
      )

      const report = await Effect.runPromise(checkNoteRoot(fixture.root))

      expect(report.ok).toBe(true)
      expect(report.links.backlinks).toEqual([
        {
          id: target.id,
          sources: [first.id, second.id].sort(),
        },
      ])
    } finally {
      cleanup(fixture)
    }
  })

  test("reports conflict markers and preserves every note byte-for-byte", async () => {
    const fixture = setup()
    try {
      const valid = copyFixture(
        fixture,
        "valid/20261117193045-agent-memory-is-bounded.md",
      )
      const conflict = copyFixture(
        fixture,
        "invalid/20261117233100-conflict-markers.md",
      )
      const before = new Map([
        [valid, readFileSync(valid)],
        [conflict, readFileSync(conflict)],
      ])
      const entries = readdirSync(fixture.root).sort()

      const report = await Effect.runPromise(checkNoteRoot(fixture.root))

      expect(report.ok).toBe(false)
      expect(report.issues.map((issue) => issue.code)).toContain(
        "conflict-markers",
      )
      expect(readdirSync(fixture.root).sort()).toEqual(entries)
      for (const [path, bytes] of before) {
        expect(readFileSync(path)).toEqual(bytes)
      }
    } finally {
      cleanup(fixture)
    }
  })
})
