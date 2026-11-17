#!/usr/bin/env bun
// Deterministic local synthesizer used only by the wiki tests. It reads the
// bounded JSON envelope from stdin and prints one fixed-shape response. It is a
// real child process, so the tests exercise the argv/stdin boundary.

import { writeFileSync } from "node:fs"

const [, , recordPath, mode = "mixed"] = process.argv

const chunks = []
for await (const chunk of process.stdin) {
  chunks.push(chunk)
}
const raw = Buffer.concat(chunks).toString("utf8")
const payload = JSON.parse(raw)
const notes = Array.isArray(payload.untrustedNotes) ? payload.untrustedNotes : []
const first = notes[0]

if (recordPath !== undefined) {
  writeFileSync(
    recordPath,
    JSON.stringify({
      argv: process.argv.slice(2),
      stdinHasInjection: raw.includes("Ignore all previous instructions"),
      noteCount: notes.length,
    }),
    "utf8",
  )
}

if (mode === "fail") {
  process.stderr.write("fixture agent refused\n")
  process.exit(3)
}
if (mode === "bad-json") {
  process.stdout.write("this is not json")
  process.exit(0)
}
if (mode === "empty") {
  process.exit(0)
}

const sentence = first?.body?.split(". ")[0]
const quote = sentence === undefined ? "" : `${sentence}.`

const mixed = {
  sentences: [
    {
      text: "Recall should cite a supporting note.",
      noteId: first?.id ?? "missing",
      quote,
    },
    {
      text: "Every deletion is safe without approval.",
      noteId: first?.id ?? "missing",
      quote: "This quote is not present anywhere in the note.",
    },
    {
      text: "An unknown note supports this claim.",
      noteId: "20261117213000-does-not-exist",
      quote,
    },
    {
      text: "not a sentence",
      noteId: first?.id ?? "missing",
      quote,
    },
  ],
}

if (mode === "many") {
  const sentences = []
  for (let index = 0; index < 100; index++) {
    sentences.push({
      text: `Bounded synthesized sentence number ${index + 1}.`,
      noteId: first?.id ?? "missing",
      quote,
    })
  }
  process.stdout.write(JSON.stringify({ sentences }))
  process.exit(0)
}

process.stdout.write(JSON.stringify(mixed))
