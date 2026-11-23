import { expect, test } from "bun:test"
import { Schema } from "effect"
import { FleetingNote } from "./fleeting-note.js"
import { LiteratureNote } from "./literature-note.js"
import { Note } from "./note.js"
import { PermanentNote } from "./permanent-note.js"

const decodes = (
  schema: Schema.ConstraintDecoder<unknown>,
  input: unknown,
): boolean => Schema.decodeUnknownOption(schema)(input)._tag === "Some"

test("the shared draft accepts an optional reference and tags", () => {
  expect(decodes(Note.Draft, { title: "Title", content: "Body" })).toBe(true)
  expect(
    decodes(Note.Draft, {
      title: "Title",
      content: "Body",
      reference: "Source",
    }),
  ).toBe(true)
  expect(
    decodes(Note.Draft, {
      title: "Title",
      content: "Body",
      tags: [],
    }),
  ).toBe(true)
  expect(
    decodes(Note.Draft, {
      title: "Title",
      content: "Body",
      tags: ["agent-memory"],
    }),
  ).toBe(true)
  expect(decodes(Note.Draft, { title: "Title" })).toBe(false)
})

test("per-kind create inputs reject blank required text", () => {
  expect(
    decodes(FleetingNote.CreateInput, { title: "   ", content: "Body" }),
  ).toBe(false)
  expect(
    decodes(PermanentNote.CreateInput, { title: "Title", content: "" }),
  ).toBe(false)
  expect(
    decodes(LiteratureNote.CreateInput, {
      title: "Title",
      content: "Body",
      reference: " ",
    }),
  ).toBe(false)
})

test("per-kind create inputs enforce the documented content limits", () => {
  expect(
    decodes(FleetingNote.CreateInput, {
      title: "Title",
      content: "a".repeat(1001),
    }),
  ).toBe(false)
  expect(
    decodes(PermanentNote.CreateInput, {
      title: "Title",
      content: "a".repeat(2001),
    }),
  ).toBe(false)
  expect(
    decodes(LiteratureNote.CreateInput, {
      title: "Title",
      content: "a".repeat(5001),
      reference: "Source",
    }),
  ).toBe(false)
})

test("list inputs accept only an optional integer bound", () => {
  expect(decodes(Note.ListInput, {})).toBe(true)
  expect(decodes(Note.ListInput, { limit: 5 })).toBe(true)
  expect(decodes(Note.ListInput, { limit: "5" })).toBe(false)
  expect(decodes(Note.ListInput, { limit: 1.5 })).toBe(false)
  expect(decodes(Note.ListTitlesInput, {})).toBe(true)
  expect(decodes(Note.ListTitlesInput, { limit: 5 })).toBe(true)
  expect(decodes(Note.ListTitlesInput, { limit: "5" })).toBe(false)
  expect(Note.DEFAULT_LIST_LIMIT).toBe(10)
  expect(Note.MAX_LIST_LIMIT).toBe(50)
})

test("the shared default search fields are the common backend capability", () => {
  expect(Note.DEFAULT_SEARCH_FIELDS).toEqual([
    "title",
    "content",
    "reference",
  ])
  // Tags stay selectable but are not part of the default: a backend without
  // tag storage cannot match them.
  expect(
    Schema.decodeUnknownSync(Note.SearchInput)({
      query: "retrieval",
      fields: ["tags"],
    }).fields,
  ).toEqual(["tags"])
})

test("Note.Info decodes each kind as its own tagged variant", () => {
  const base = { id: "note-1", title: "Title", content: "Body", createdAt: 1, updatedAt: 2 }

  expect(decodes(Note.Info, { ...base, type: "fleeting" })).toBe(true)
  expect(
    decodes(Note.Info, {
      ...base,
      type: "literature",
      reference: "Source",
    }),
  ).toBe(true)
  expect(decodes(Note.Info, { ...base, type: "permanent" })).toBe(true)
  expect(decodes(Note.Info, { ...base, type: "unknown" })).toBe(false)
})
