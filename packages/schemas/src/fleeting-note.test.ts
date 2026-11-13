import { expect, test } from "bun:test"
import { Schema } from "effect"
import { FleetingNote } from "./fleeting-note"

const decode = Schema.decodeUnknownSync(FleetingNote.Info)
const note = {
  id: "note-1",
  content: "a".repeat(1000),
  time: { created: 1, updated: 2 },
}

test("accepts a note with content up to 1000 characters", () => {
  expect(decode(note)).toEqual(note)
})

test("rejects content longer than 1000 characters", () => {
  expect(() => decode({ ...note, content: "a".repeat(1001) })).toThrow()
})

test("requires finite creation and update timestamps", () => {
  expect(() => decode({ ...note, time: { created: NaN, updated: 2 } })).toThrow()
  expect(() => decode({ ...note, time: { created: 1, updated: Infinity } })).toThrow()
})
