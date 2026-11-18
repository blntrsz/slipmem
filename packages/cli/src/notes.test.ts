import { afterEach, describe, expect, test } from "bun:test"
import {
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { makeTempBase, parseJson, runCliProcess } from "./test-support.js"

interface NoteResult {
  readonly ok: boolean
  readonly root: string
  readonly note: {
    readonly id: string
    readonly filename: string
    readonly type: string
    readonly title: string
    readonly content: string
    readonly tags: ReadonlyArray<string>
    readonly reference?: string
    readonly createdAt: string
    readonly updatedAt: string
    readonly citation: string
  }
}

interface ListResult {
  readonly ok: boolean
  readonly count: number
  readonly notes: ReadonlyArray<{ readonly id: string; readonly title: string }>
}

interface ErrorEnvelope {
  readonly ok: false
  readonly error: {
    readonly kind: string
    readonly code: string
    readonly message: string
    readonly field?: string
  }
}

const cleanup: string[] = []

afterEach(() => {
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true })
  }
})

const setup = async (): Promise<{ base: string; root: string }> => {
  const base = makeTempBase()
  cleanup.push(base)
  const root = join(base, ".slipmem")
  const init = await runCliProcess(["init", "--dir", root, "--json"])
  expect(init.code).toBe(0)
  return { base, root }
}

const writeEditor = (
  base: string,
  name: string,
  source: string,
): string => {
  const path = join(base, name)
  writeFileSync(path, source, { encoding: "utf8", mode: 0o755 })
  return path
}

const editBodyEditor = (base: string, from: string, to: string): string =>
  writeEditor(
    base,
    "edit-body.ts",
    `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs"
const path = process.argv[2]
const text = readFileSync(path, "utf8")
if (!text.includes(${JSON.stringify(from)})) {
  console.error("expected body text not found")
  process.exit(3)
}
writeFileSync(path, text.replace(${JSON.stringify(from)}, ${JSON.stringify(to)}))
`,
  )

const replacementEditor = (base: string, content: string): string =>
  writeEditor(
    base,
    "replace.ts",
    `#!/usr/bin/env bun
import { writeFileSync } from "node:fs"
writeFileSync(process.argv[2], ${JSON.stringify(content)})
`,
  )

describe("slipmem note commands", () => {
  test("creates notes from flags and stdin as flat, validated files", async () => {
    const { root } = await setup()

    const created = await runCliProcess([
      "new",
      "--dir",
      root,
      "--type",
      "permanent",
      "--title",
      "Bounded recall",
      "--content",
      "Every recall operation has a hard limit.",
      "--tag",
      "agent-memory,retrieval",
      "--json",
    ])
    expect(created.code).toBe(0)
    const permanent = parseJson<NoteResult>(created.stdout).note
    expect(permanent).toMatchObject({
      type: "permanent",
      title: "Bounded recall",
      content: "Every recall operation has a hard limit.",
    })
    expect(permanent.id).toMatch(/^\d{14}-bounded-recall$/)
    expect(permanent.filename).toBe(`${permanent.id}.md`)
    expect(permanent.tags).toEqual(["agent-memory", "retrieval"])
    expect(permanent.citation).toBe(`.slipmem/${permanent.filename}`)
    expect(readFileSync(join(root, permanent.filename), "utf8")).toContain(
      "provenance:\n  source: cli\n  actor: user",
    )

    const fromStdin = await runCliProcess(
      [
        "new",
        "--dir",
        root,
        "--type",
        "fleeting",
        "--title",
        "Inbox thought",
        "--json",
      ],
      { stdin: "A quick capture from a pipe." },
    )
    expect(fromStdin.code).toBe(0)
    expect(parseJson<NoteResult>(fromStdin.stdout).note.content).toBe(
      "A quick capture from a pipe.",
    )

    const literature = await runCliProcess([
      "new",
      "--dir",
      root,
      "--type",
      "literature",
      "--title",
      "Cited source",
      "--content",
      "A source-backed claim.",
      "--reference",
      "Book, chapter 2",
      "--json",
    ])
    expect(literature.code).toBe(0)
    expect(parseJson<NoteResult>(literature.stdout).note.reference).toBe(
      "Book, chapter 2",
    )

    // Every note is a direct child; no type directories were created.
    const directories = readdirSync(root).filter((name) =>
      ["fleeting", "permanent", "literature"].includes(name),
    )
    expect(directories).toEqual([])
  }, 30000)

  test("validates type-specific rules and empty content with typed errors", async () => {
    const { root } = await setup()

    const missingReference = await runCliProcess([
      "new",
      "--dir",
      root,
      "--type",
      "literature",
      "--title",
      "No source",
      "--content",
      "Body",
      "--json",
    ])
    expect(missingReference.code).toBe(1)
    const referenceError = parseJson<ErrorEnvelope>(missingReference.stderr)
    expect(referenceError.error).toMatchObject({
      kind: "validation",
      code: "missing-reference",
      field: "reference",
    })

    const empty = await runCliProcess(
      [
        "new",
        "--dir",
        root,
        "--type",
        "fleeting",
        "--title",
        "Nothing",
        "--json",
      ],
      { stdin: "" },
    )
    expect(empty.code).toBe(1)
    expect(parseJson<ErrorEnvelope>(empty.stderr).error.code).toBe("content-empty")

    const badType = await runCliProcess([
      "new",
      "--dir",
      root,
      "--type",
      "note",
      "--title",
      "Bad",
      "--content",
      "Body",
      "--json",
    ])
    expect(badType.code).toBe(2)
    expect(parseJson<ErrorEnvelope>(badType.stderr).error.kind).toBe("usage")
  }, 30000)

  test("lists, filters, shows, and reports missing notes", async () => {
    const { root } = await setup()

    for (const [type, title, tag] of [
      ["permanent", "Agent memory", "agent-memory"],
      ["fleeting", "Loose idea", "agent-memory"],
      ["literature", "Recall paper", "retrieval"],
    ] as const) {
      const result = await runCliProcess([
        "new",
        "--dir",
        root,
        "--type",
        type,
        "--title",
        title,
        "--content",
        `Body for ${title}.`,
        "--tag",
        tag,
        ...(type === "literature" ? ["--reference", "Paper, 2026"] : []),
        "--json",
      ])
      expect(result.code).toBe(0)
    }

    const all = await runCliProcess(["list", "--dir", root, "--json"])
    expect(all.code).toBe(0)
    expect(parseJson<ListResult>(all.stdout).count).toBe(3)

    const permanent = await runCliProcess([
      "list",
      "--dir",
      root,
      "--type",
      "permanent",
      "--json",
    ])
    const permanentList = parseJson<ListResult>(permanent.stdout)
    expect(permanentList.count).toBe(1)
    expect(permanentList.notes[0]!.title).toBe("Agent memory")

    const tag = await runCliProcess([
      "list",
      "--dir",
      root,
      "--tag",
      "agent-memory",
      "--limit",
      "1",
      "--json",
    ])
    expect(parseJson<ListResult>(tag.stdout).count).toBe(1)

    const id = permanentList.notes[0]!.id
    const shown = await runCliProcess(["show", id, "--dir", root, "--json"])
    expect(shown.code).toBe(0)
    expect(parseJson<NoteResult>(shown.stdout).note.content).toBe(
      "Body for Agent memory.",
    )

    const human = await runCliProcess(["show", id, "--dir", root])
    expect(human.code).toBe(0)
    expect(human.stdout).toContain(`  path:      .slipmem/${id}.md`)
    expect(human.stdout).toContain("  tags:      agent-memory")
    expect(human.stdout).toContain("Body for Agent memory.")

    const missing = await runCliProcess([
      "show",
      "20990101000000-missing",
      "--dir",
      root,
      "--json",
    ])
    expect(missing.code).toBe(1)
    expect(parseJson<ErrorEnvelope>(missing.stderr).error).toMatchObject({
      kind: "validation",
      code: "not-found",
    })

    const badLimit = await runCliProcess([
      "list",
      "--dir",
      root,
      "--limit",
      "51",
      "--json",
    ])
    expect(badLimit.code).toBe(2)
  }, 30000)

  test("edits through a validated temporary draft and preserves atomicity", async () => {
    const { base, root } = await setup()

    const created = await runCliProcess([
      "new",
      "--dir",
      root,
      "--type",
      "permanent",
      "--title",
      "Edit me",
      "--content",
      "Original body.",
      "--json",
    ])
    const original = parseJson<NoteResult>(created.stdout).note

    const editor = editBodyEditor(base, "Original body.", "Edited body with detail.")
    const edited = await runCliProcess(["edit", original.id, "--dir", root, "--json"], {
      env: { SLIPMEM_EDITOR: editor },
    })
    expect(edited.code).toBe(0)
    const updated = parseJson<NoteResult>(edited.stdout)
    expect(updated.note).toMatchObject({
      id: original.id,
      filename: original.filename,
      content: "Edited body with detail.",
    })
    expect(Date.parse(updated.note.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(updated.note.createdAt),
    )
    expect(
      readdirSync(root).some((name) => name.endsWith(".tmp")),
    ).toBe(false)

    const invalid = replacementEditor(base, "this is not frontmatter")
    const rejected = await runCliProcess(["edit", original.id, "--dir", root, "--json"], {
      env: { SLIPMEM_EDITOR: invalid },
    })
    expect(rejected.code).toBe(1)
    expect(parseJson<ErrorEnvelope>(rejected.stderr).error.code).toBe(
      "frontmatter-missing",
    )
    // The invalid draft never reached the real note.
    const after = await runCliProcess(["show", original.id, "--dir", root, "--json"])
    expect(parseJson<NoteResult>(after.stdout).note.content).toBe(
      "Edited body with detail.",
    )

    const noop = writeEditor(
      base,
      "noop.ts",
      `#!/usr/bin/env bun\nprocess.exit(0)\n`,
    )
    const unchanged = await runCliProcess(
      ["edit", original.id, "--dir", root, "--json"],
      { env: { SLIPMEM_EDITOR: noop } },
    )
    expect(unchanged.code).toBe(0)
    expect(parseJson<{ changed: boolean }>(unchanged.stdout).changed).toBe(false)

    const managed = writeEditor(
      base,
      "managed.ts",
      `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs"
const path = process.argv[2]
const text = readFileSync(path, "utf8")
writeFileSync(path, text.replace(/createdAt: "[^"]+"/, 'createdAt: "2020-01-01T00:00:00Z"'))
`,
    )
    const managedResult = await runCliProcess(
      ["edit", original.id, "--dir", root, "--json"],
      { env: { SLIPMEM_EDITOR: managed } },
    )
    expect(managedResult.code).toBe(1)
    expect(parseJson<ErrorEnvelope>(managedResult.stderr).error.code).toBe(
      "timestamp-mismatch",
    )
  }, 30000)

  test("refuses editor use when no editor is configured", async () => {
    const { root } = await setup()
    const created = await runCliProcess([
      "new",
      "--dir",
      root,
      "--type",
      "fleeting",
      "--title",
      "No editor",
      "--content",
      "Body",
      "--json",
    ])
    const id = parseJson<NoteResult>(created.stdout).note.id

    const result = await runCliProcess(["edit", id, "--dir", root, "--json"], {
      env: { SLIPMEM_EDITOR: "", VISUAL: "", EDITOR: "" },
    })
    expect(result.code).toBe(2)
    expect(parseJson<ErrorEnvelope>(result.stderr).error).toMatchObject({
      kind: "usage",
      message: expect.stringContaining("No editor is configured"),
    })
  }, 30000)
})
