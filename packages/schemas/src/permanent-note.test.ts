import { expect, test } from "bun:test"
import { Schema } from "effect"
import { PermanentNote } from "./permanent-note"

const decodeInfo = Schema.decodeUnknownSync(PermanentNote.Info)
const note = {
  id: Schema.decodeUnknownSync(PermanentNote.ID)("note-1"),
  title: "A title",
  content: "a".repeat(2000),
  createdAt: 1,
  updatedAt: 2,
}

const input = {
  title: "A title",
  content: "hello",
}

test("accepts a note with content up to 2000 characters", () => {
  expect(decodeInfo(note)).toEqual(note)
})

test("rejects content longer than 2000 characters", () => {
  expect(() => decodeInfo({ ...note, content: "a".repeat(2001) })).toThrow()
  expect(() => Schema.decodeUnknownSync(PermanentNote.CreateInput)({ ...input, content: "a".repeat(2001) })).toThrow()
  expect(() => Schema.decodeUnknownSync(PermanentNote.UpdateInput)({ ...input, id: "note-1", content: "a".repeat(2001) })).toThrow()
})

test("requires finite creation and update timestamps", () => {
  expect(() => decodeInfo({ ...note, createdAt: NaN })).toThrow()
  expect(() => decodeInfo({ ...note, updatedAt: Infinity })).toThrow()
})

test("requires a title and content for all notes", () => {
  expect(() => decodeInfo({ ...note, title: undefined })).toThrow()
  expect(() => Schema.decodeUnknownSync(PermanentNote.CreateInput)({ content: "hello" })).toThrow()
  expect(() => Schema.decodeUnknownSync(PermanentNote.UpdateInput)({ id: "note-1", content: "hello" })).toThrow()
})

test("create input only carries title and content", () => {
  expect(Schema.decodeUnknownSync(PermanentNote.CreateInput)(input)).toEqual(input)
})

test("update input carries the id used to locate the note plus title and content", () => {
  expect(Schema.decodeUnknownSync(PermanentNote.UpdateInput)({ id: note.id, ...input })).toEqual({ id: note.id, ...input })
})

test("accepts an id for get and delete input", () => {
  expect(Schema.decodeUnknownSync(PermanentNote.GetInput)({ id: note.id })).toEqual({ id: note.id })
  expect(Schema.decodeUnknownSync(PermanentNote.DeleteInput)({ id: note.id })).toEqual({ id: note.id })
})

test("accepts an empty list input", () => {
  expect(Schema.decodeUnknownSync(PermanentNote.ListInput)({})).toEqual({})
})
