import type { ParsedMarkdownNote } from "@slipmem/core"
import type { CliIo } from "./output.js"
import { citationPath } from "./note-values.js"
import { pad } from "./output.js"

export const writeNoteHuman = (
  io: CliIo,
  root: string,
  note: ParsedMarkdownNote,
): void => {
  const metadata = note.metadata
  const lines = [
    `${metadata.id}`,
    `  type:      ${metadata.type}`,
    `  title:     ${metadata.title}`,
    `  createdAt: ${metadata.createdAt}`,
    `  updatedAt: ${metadata.updatedAt}`,
    `  path:      ${citationPath(root, note.filename)}`,
  ]
  if (metadata.tags !== undefined && metadata.tags.length > 0) {
    lines.push(`  tags:      ${metadata.tags.join(", ")}`)
  }
  if (metadata.reference !== undefined) {
    lines.push(`  reference: ${metadata.reference}`)
  }
  if (metadata.provenance !== undefined) {
    const source = metadata.provenance.source ?? "unknown"
    const actor = metadata.provenance.actor
    lines.push(`  provenance: ${source}${actor === undefined ? "" : ` (${actor})`}`)
  }
  lines.push("---", note.body)
  io.out(`${lines.join("\n")}\n`)
}

export const writeNoteListHuman = (
  io: CliIo,
  root: string,
  notes: ReadonlyArray<ParsedMarkdownNote>,
): void => {
  if (notes.length === 0) {
    io.out("No notes.\n")
    return
  }

  const rows = notes.map((note) => ({
    id: note.id,
    type: note.metadata.type,
    updatedAt: note.metadata.updatedAt,
    title: note.metadata.title,
  }))
  const idWidth = Math.max(2, ...rows.map((row) => row.id.length))
  const typeWidth = Math.max(4, ...rows.map((row) => row.type.length))
  const dateWidth = 19

  const header = `${pad("ID", idWidth)}  ${pad("TYPE", typeWidth)}  ${pad("UPDATED", dateWidth)}  TITLE`
  io.out(`${header}\n`)
  for (const row of rows) {
    io.out(
      `${pad(row.id, idWidth)}  ${pad(row.type, typeWidth)}  ${pad(row.updatedAt, dateWidth)}  ${row.title}\n`,
    )
  }
  io.out(`\n${notes.length} note${notes.length === 1 ? "" : "s"} in ${root}\n`)
}
