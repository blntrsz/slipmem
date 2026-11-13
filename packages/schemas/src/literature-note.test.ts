import { expect, test } from "bun:test"
import { Schema } from "effect"
import { LiteratureNote } from "./literature-note"

const decodeInfo = Schema.decodeUnknownSync(LiteratureNote.Info)
const note = {
  id: Schema.decodeUnknownSync(LiteratureNote.ID)("note-1"),
  title: "A title",
  content: "a".repeat(5000),
  reference: "Book, chapter 2",
  createdAt: 1,
  updatedAt: 2,
}

const input = {
  title: "A title",
  content: "hello",
  reference: "Book, chapter 2",
}

test("accepts a note with content up to 5000 characters", () => {
  expect(decodeInfo(note)).toEqual(note)
})

test("rejects content longer than 5000 characters", () => {
  expect(() => decodeInfo({ ...note, content: "a".repeat(5001) })).toThrow()
  expect(() => Schema.decodeUnknownSync(LiteratureNote.CreateInput)({ ...input, content: "a".repeat(5001) })).toThrow()
  expect(() => Schema.decodeUnknownSync(LiteratureNote.UpdateInput)({ ...input, id: "note-1", content: "a".repeat(5001) })).toThrow()
})

test("requires finite creation and update timestamps", () => {
  expect(() => decodeInfo({ ...note, createdAt: NaN })).toThrow()
  expect(() => decodeInfo({ ...note, updatedAt: Infinity })).toThrow()
})

test("requires a title, content, and reference for all notes", () => {
  expect(() => decodeInfo({ ...note, title: undefined })).toThrow()
  expect(() => decodeInfo({ ...note, reference: undefined })).toThrow()
  expect(() => Schema.decodeUnknownSync(LiteratureNote.CreateInput)({ title: "A title", content: "hello" })).toThrow()
  expect(() => Schema.decodeUnknownSync(LiteratureNote.UpdateInput)({ id: "note-1", title: "A title", content: "hello" })).toThrow()
})

test("create input carries title, content, and reference", () => {
  expect(Schema.decodeUnknownSync(LiteratureNote.CreateInput)(input)).toEqual(input)
})

test("update input carries the id used to locate the note plus title, content, and reference", () => {
  expect(Schema.decodeUnknownSync(LiteratureNote.UpdateInput)({ id: note.id, ...input })).toEqual({ id: note.id, ...input })
})

test("accepts an id for get and delete input", () => {
  expect(Schema.decodeUnknownSync(LiteratureNote.GetInput)({ id: note.id })).toEqual({ id: note.id })
  expect(Schema.decodeUnknownSync(LiteratureNote.DeleteInput)({ id: note.id })).toEqual({ id: note.id })
})

test("accepts an empty list input", () => {
  expect(Schema.decodeUnknownSync(LiteratureNote.ListInput)({})).toEqual({})
})
