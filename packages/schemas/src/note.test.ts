import { expect, test } from "bun:test"
import { Schema } from "effect"
import { FleetingNote } from "./fleeting-note"
import { LiteratureNote } from "./literature-note"
import { Note } from "./note"
import { PermanentNote } from "./permanent-note"

const decodeInfo = Schema.decodeUnknownSync(Note.Info)

const fleetingNote = {
  type: "fleeting",
  id: Schema.decodeUnknownSync(FleetingNote.ID)("fleeting-1"),
  title: "A fleeting thought",
  content: "a".repeat(1000),
  createdAt: 1,
  updatedAt: 2,
} as const

const literatureNote = {
  type: "literature",
  id: Schema.decodeUnknownSync(LiteratureNote.ID)("literature-1"),
  title: "A source",
  content: "a quote",
  reference: "Book, chapter 2",
  createdAt: 3,
  updatedAt: 4,
} as const

const permanentNote = {
  type: "permanent",
  id: Schema.decodeUnknownSync(PermanentNote.ID)("permanent-1"),
  title: "An idea",
  content: "a lasting idea",
  createdAt: 5,
  updatedAt: 6,
} as const

test("accepts every note kind with its type discriminant", () => {
  expect(decodeInfo(fleetingNote)).toEqual(fleetingNote)
  expect(decodeInfo(literatureNote)).toEqual(literatureNote)
  expect(decodeInfo(permanentNote)).toEqual(permanentNote)
})

test("rejects notes with an unknown type", () => {
  expect(() => decodeInfo({ ...permanentNote, type: "unknown" })).toThrow()
  expect(() => decodeInfo({ ...permanentNote, type: undefined })).toThrow()
})

test("enforces the constraints of each note kind", () => {
  // Fleeting content is limited to 1000 characters, permanent content to 2000.
  expect(() => decodeInfo({ ...fleetingNote, content: "a".repeat(1001) })).toThrow()
  expect(() => decodeInfo({ ...permanentNote, content: "a".repeat(2001) })).toThrow()
  // Literature notes require a reference.
  const { reference: _reference, ...withoutReference } = literatureNote
  expect(() => decodeInfo(withoutReference)).toThrow()
})

test("requires the fields shared by all note kinds", () => {
  for (const note of [fleetingNote, literatureNote, permanentNote]) {
    expect(() => decodeInfo({ ...note, id: undefined })).toThrow()
    expect(() => decodeInfo({ ...note, title: undefined })).toThrow()
    expect(() => decodeInfo({ ...note, createdAt: NaN })).toThrow()
  }
})

test("exposes match and guards for the type discriminant", () => {
  const label = Note.Info.match(fleetingNote, {
    fleeting: () => "fleeting",
    literature: () => "literature",
    permanent: () => "permanent",
  })

  expect(label).toBe("fleeting")
  expect(Note.Info.guards.literature(literatureNote)).toBe(true)
  expect(Note.Info.guards.permanent(literatureNote)).toBe(false)
  expect(Note.Info.isAnyOf(["fleeting", "permanent"])(permanentNote)).toBe(true)
  expect(Note.Kind.literals).toEqual(["fleeting", "literature", "permanent"])
})

test("accepts an empty list input", () => {
  expect(Schema.decodeUnknownSync(Note.ListInput)({})).toEqual({})
})
