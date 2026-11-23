import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { makeTempBase, parseJson, runCliProcess } from "./test-support.js"

interface NoteResult {
  readonly ok: boolean
  readonly note: {
    readonly id: string
    readonly path: string
    readonly content: string
    readonly contentHash: string
  }
}

interface ErrorEnvelope {
  readonly ok: false
  readonly error: {
    readonly kind: string
    readonly code: string
    readonly message: string
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

const createNote = async (
  root: string,
  title: string,
): Promise<NoteResult["note"]> => {
  const created = await runCliProcess([
    "new",
    "--dir",
    root,
    "--type",
    "permanent",
    "--title",
    title,
    "--content",
    "Original body.",
    "--json",
  ])
  expect(created.code).toBe(0)
  return parseJson<NoteResult>(created.stdout).note
}

const writeEditor = (base: string, name: string, source: string): string => {
  const path = join(base, name)
  writeFileSync(path, source, { encoding: "utf8", mode: 0o755 })
  return path
}

const show = async (
  root: string,
  id: string,
): Promise<NoteResult["note"]> => {
  const result = await runCliProcess(["show", id, "--dir", root, "--json"])
  expect(result.code).toBe(0)
  return parseJson<NoteResult>(result.stdout).note
}

describe("stale edit protections", () => {
  test("--expect refuses an edit or delete of a version that is no longer current", async () => {
    const { base, root } = await setup()
    const note = await createNote(root, "Explicit revision")
    const marker = join(base, "editor-launched")

    const editor = writeEditor(
      base,
      "marker-editor.ts",
      `#!/usr/bin/env bun
import { writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(marker)}, "launched")
`,
    )

    const staleEdit = await runCliProcess(
      ["edit", note.id, "--dir", root, "--json", "--expect", "a".repeat(64)],
      { env: { SLIPMEM_EDITOR: editor } },
    )
    expect(staleEdit.code).toBe(1)
    expect(parseJson<ErrorEnvelope>(staleEdit.stderr).error).toMatchObject({
      kind: "validation",
      code: "stale-base",
    })
    expect(existsSync(marker)).toBe(false)

    const staleDelete = await runCliProcess([
      "delete",
      note.id,
      "--dir",
      root,
      "--yes",
      "--json",
      "--expect",
      "a".repeat(64),
    ])
    expect(staleDelete.code).toBe(1)
    expect(parseJson<ErrorEnvelope>(staleDelete.stderr).error.code).toBe(
      "stale-base",
    )
    expect(await show(root, note.id)).toMatchObject({ content: "Original body." })

    const deleted = await runCliProcess([
      "delete",
      note.id,
      "--dir",
      root,
      "--yes",
      "--json",
      "--revision",
      note.contentHash,
    ])
    expect(deleted.code).toBe(0)
    expect(
      parseJson<{ deleted: boolean }>(deleted.stdout).deleted,
    ).toBe(true)
  }, 30000)

  test("edit uses the hash read for the draft and preserves a concurrent external edit", async () => {
    const { base, root } = await setup()
    const note = await createNote(root, "Concurrent edit")

    const editor = writeEditor(
      base,
      "external-edit.ts",
      `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs"
const notePath = process.env.SLIPMEM_TEST_NOTE_PATH
if (!notePath) process.exit(4)
const external = readFileSync(notePath, "utf8").replace("Original body.", "External body.")
writeFileSync(notePath, external)
const draftPath = process.argv[2]
const draft = readFileSync(draftPath, "utf8").replace("Original body.", "Editor body.")
writeFileSync(draftPath, draft)
`,
    )

    const edited = await runCliProcess(
      ["edit", note.id, "--dir", root, "--json"],
      {
        env: {
          SLIPMEM_EDITOR: editor,
          SLIPMEM_TEST_NOTE_PATH: note.path,
        },
      },
    )
    expect(edited.code).toBe(1)
    expect(parseJson<ErrorEnvelope>(edited.stderr).error).toMatchObject({
      code: "stale-base",
      message: expect.stringContaining("Nothing was written"),
    })

    const current = await show(root, note.id)
    expect(current.content).toBe("External body.")
    expect(readFileSync(note.path, "utf8")).toContain("External body.")
  }, 30000)
})
