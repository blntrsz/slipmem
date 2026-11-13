import { expect, test } from "bun:test"
import { Schema } from "effect"
import { FleetingNote } from "./fleeting-note"

const decode = Schema.decodeUnknownSync(FleetingNote.Info)
const note = {
  id: "note-1",
  content: "a".repeat(1000),
  createdAt: 1,
  updatedAt: 2,
}

test("accepts a note with content up to 1000 characters", () => {
  expect(decode(note)).toEqual(note)
})

test("rejects content longer than 1000 characters", () => {
  expect(() => decode({ ...note, content: "a".repeat(1001) })).toThrow()
})

test("requires finite creation and update timestamps", () => {
  expect(() => decode({ ...note, createdAt: NaN })).toThrow()
  expect(() => decode({ ...note, updatedAt: Infinity })).toThrow()
})

test("accepts a complete note as create and update input", () => {
  expect(Schema.decodeUnknownSync(FleetingNote.CreateInput)(note)).toEqual(note)
  expect(Schema.decodeUnknownSync(FleetingNote.UpdateInput)(note)).toEqual(note)
})

test("accepts an id for get and delete input", () => {
  expect(Schema.decodeUnknownSync(FleetingNote.GetInput)({ id: note.id })).toEqual({ id: note.id })
  expect(Schema.decodeUnknownSync(FleetingNote.DeleteInput)({ id: note.id })).toEqual({ id: note.id })
})

test("accepts an empty list input", () => {
  expect(Schema.decodeUnknownSync(FleetingNote.ListInput)({})).toEqual({})
})
