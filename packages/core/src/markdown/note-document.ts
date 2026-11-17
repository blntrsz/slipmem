import type { FleetingNote } from "@slipmem/schemas/fleeting-note"
import type { LiteratureNote } from "@slipmem/schemas/literature-note"
import type { Note } from "@slipmem/schemas/note"
import type { PermanentNote } from "@slipmem/schemas/permanent-note"
import { Markdown } from "@slipmem/schemas/markdown"
import { createHash } from "node:crypto"
import { basename } from "node:path"
import { Effect } from "effect"
import { MarkdownError, markdownError } from "./errors.js"
import {
  renderNoteDocument,
  splitNoteDocument,
  splitUnknownMetadata,
  type RenderNoteDocumentInput,
} from "./frontmatter.js"

const CONFLICT_MARKER = /^(?:<{7}(?: .*)?|>{7}(?: .*)?)$/m

export interface ParsedMarkdownNote {
  /** Absolute path when the repository supplies one; fixture tests pass theirs. */
  readonly path: string
  readonly filename: string
  /** Filename stem; the stable note identity. */
  readonly id: string
  readonly metadata: Markdown.NoteMetadata
  /** The existing `Note.Info` wire shape used by the SQLite services. */
  readonly info: Note.Info
  readonly body: string
  /** Frontmatter keys outside the frozen contract, preserved verbatim. */
  readonly unknown: Readonly<Record<string, unknown>>
  /** SHA-256 of the whole file, including frontmatter. */
  readonly contentHash: string
  readonly size: number
  readonly mtimeMs: number
}

export interface ParseMarkdownNoteInput {
  readonly path: string
  readonly content: string
  readonly mtimeMs?: number
}

const noteError = (
  path: string,
  area: "filename" | "frontmatter" | "metadata" | "body" | "path",
  code: Parameters<typeof markdownError>[0]["code"],
  message: string,
  field?: string,
): MarkdownError =>
  markdownError({
    area,
    code,
    path,
    message,
    ...(field === undefined ? {} : { field }),
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0

/**
 * Parses one note file into metadata, body, and the existing `Note.Info` shape.
 *
 * Validation order is intentional: filename first, then YAML, then known fields,
 * then body. The first failure is returned so a caller gets one actionable path
 * and field instead of a pile of cascading schema errors. No write happens here.
 */
export const parseMarkdownNote = (
  input: ParseMarkdownNoteInput,
): Effect.Effect<ParsedMarkdownNote, MarkdownError> =>
  Effect.gen(function* () {
    const { path, content } = input
    const filename = basename(path)

    if (!Markdown.isNoteFilename(filename)) {
      return yield* Effect.fail(
        noteError(
          path,
          "filename",
          "filename-pattern",
          "Note filenames must match YYYYMMDDHHmmss-<kebab-slug>.md.",
        ),
      )
    }

    if (Buffer.byteLength(content, "utf8") > Markdown.MAX_NOTE_FILE_BYTES) {
      return yield* Effect.fail(
        noteError(
          path,
          "frontmatter",
          "file-too-large",
          `Note files must be ${Markdown.MAX_NOTE_FILE_BYTES} bytes or fewer.`,
        ),
      )
    }

    const id = Markdown.noteIdFromFilename(filename)!
    const { data, body } = yield* splitNoteDocument(path, content)
    const type = data.type

    if (typeof type !== "string" || !Markdown.NOTE_TYPES.includes(type as Markdown.NoteType)) {
      return yield* Effect.fail(
        noteError(
          path,
          "metadata",
          "unknown-type",
          `Note type must be one of ${Markdown.NOTE_TYPES.join(", ")}.`,
          "type",
        ),
      )
    }
    const noteType = type as Markdown.NoteType

    if (data.schema !== Markdown.SCHEMA_VERSION) {
      return yield* Effect.fail(
        noteError(
          path,
          "metadata",
          data.schema === undefined ? "invalid-field" : "unknown-schema",
          `Frontmatter schema must be ${Markdown.SCHEMA_VERSION}.`,
          "schema",
        ),
      )
    }

    if (data.id !== id) {
      return yield* Effect.fail(
        noteError(
          path,
          "metadata",
          "id-mismatch",
          `Frontmatter id '${String(data.id ?? "")}' must equal the filename stem '${id}'.`,
          "id",
        ),
      )
    }

    const title = data.title
    if (!isNonEmptyString(title)) {
      return yield* Effect.fail(
        noteError(
          path,
          "metadata",
          "blank-title",
          "Title must be a non-whitespace string.",
          "title",
        ),
      )
    }

    const createdAt = yield* parseContractTimestamp(path, data.createdAt, "createdAt")
    const updatedAt = yield* parseContractTimestamp(path, data.updatedAt, "updatedAt")

    const prefix = id.slice(0, 14)
    if (Markdown.toUtcTimestamp(createdAt).filenamePrefix !== prefix) {
      return yield* Effect.fail(
        noteError(
          path,
          "metadata",
          "timestamp-mismatch",
          `createdAt must agree with the filename timestamp prefix '${prefix}'.`,
          "createdAt",
        ),
      )
    }

    if (updatedAt < createdAt) {
      return yield* Effect.fail(
        noteError(
          path,
          "metadata",
          "timestamp-order",
          "updatedAt must be at least createdAt.",
          "updatedAt",
        ),
      )
    }

    const topics = yield* parseTopics(path, data.topics)
    const reference = yield* parseReference(path, data.reference, noteType)
    const provenance = yield* parseProvenance(path, data.provenance)
    const legacyId = yield* parseOptionalString(path, data.legacyId, "legacyId")
    const aliases = yield* parseOptionalStringArray(path, data.aliases, "aliases")

    if (CONFLICT_MARKER.test(body)) {
      return yield* Effect.fail(
        noteError(
          path,
          "body",
          "conflict-markers",
          "The note body contains unresolved Git conflict markers.",
        ),
      )
    }

    if (body.length === 0) {
      return yield* Effect.fail(
        noteError(path, "body", "content-empty", "Note body must not be empty.", "content"),
      )
    }

    if (body.length > Markdown.CONTENT_LIMITS[noteType]) {
      return yield* Effect.fail(
        noteError(
          path,
          "body",
          "content-too-long",
          `A ${noteType} note body must be ${Markdown.CONTENT_LIMITS[noteType]} characters or fewer.`,
          "content",
        ),
      )
    }

    const createdAtIso = Markdown.toUtcTimestamp(createdAt).isoTimestamp
    const updatedAtIso = Markdown.toUtcTimestamp(updatedAt).isoTimestamp

    const metadata: Markdown.NoteMetadata = {
      schema: Markdown.SCHEMA_VERSION,
      id,
      type: noteType,
      title,
      createdAt: createdAtIso,
      updatedAt: updatedAtIso,
      ...(topics === undefined ? {} : { topics }),
      ...(reference === undefined ? {} : { reference }),
      ...(provenance === undefined ? {} : { provenance }),
      ...(legacyId === undefined ? {} : { legacyId }),
      ...(aliases === undefined ? {} : { aliases }),
    }

    return {
      path,
      filename,
      id,
      metadata,
      info: toNoteInfo(metadata, body, createdAt, updatedAt),
      body,
      unknown: splitUnknownMetadata(data),
      contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
      size: Buffer.byteLength(content, "utf8"),
      mtimeMs: input.mtimeMs ?? 0,
    }
  })

const parseContractTimestamp = (
  path: string,
  value: unknown,
  field: "createdAt" | "updatedAt",
): Effect.Effect<number, MarkdownError> =>
  Effect.gen(function* () {
    if (typeof value !== "string" || !Markdown.UTC_TIMESTAMP_PATTERN.test(value)) {
      return yield* Effect.fail(
        noteError(
          path,
          "metadata",
          "timestamp-invalid",
          `${field} must be an ISO 8601 UTC timestamp with whole seconds.`,
          field,
        ),
      )
    }

    const millis = Date.parse(value)
    if (
      !Number.isFinite(millis) ||
      Markdown.toUtcTimestamp(millis).isoTimestamp !== value
    ) {
      return yield* Effect.fail(
        noteError(
          path,
          "metadata",
          "timestamp-invalid",
          `${field} must be a real UTC date.`,
          field,
        ),
      )
    }

    return millis
  })

const parseTopics = (
  path: string,
  value: unknown,
): Effect.Effect<ReadonlyArray<string> | undefined, MarkdownError> =>
  Effect.gen(function* () {
    if (value === undefined || value === null) {
      return undefined
    }
    if (!Array.isArray(value)) {
      return yield* Effect.fail(
        noteError(path, "metadata", "invalid-field", "topics must be an array.", "topics"),
      )
    }

    const topics: string[] = []
    for (const topic of value) {
      if (typeof topic !== "string" || !Markdown.isTopicSlug(topic)) {
        return yield* Effect.fail(
          noteError(
            path,
            "metadata",
            "invalid-topic",
            `Topic '${String(topic)}' must be lowercase kebab-case.`,
            "topics",
          ),
        )
      }
      if (!topics.includes(topic)) {
        topics.push(topic)
      }
    }

    return topics
  })

const parseReference = (
  path: string,
  value: unknown,
  type: Markdown.NoteType,
): Effect.Effect<string | undefined, MarkdownError> =>
  Effect.gen(function* () {
    if (value !== undefined && value !== null && typeof value !== "string") {
      return yield* Effect.fail(
        noteError(path, "metadata", "invalid-field", "reference must be a string.", "reference"),
      )
    }

    const reference = typeof value === "string" ? value.trim() : ""
    if (type === "literature" && reference.length === 0) {
      return yield* Effect.fail(
        noteError(
          path,
          "metadata",
          "missing-reference",
          "Literature notes require a non-whitespace reference.",
          "reference",
        ),
      )
    }

    return reference.length === 0 ? undefined : reference
  })

const parseProvenance = (
  path: string,
  value: unknown,
): Effect.Effect<Markdown.Provenance | undefined, MarkdownError> =>
  Effect.gen(function* () {
    if (value === undefined || value === null) {
      return undefined
    }
    if (!isRecord(value)) {
      return yield* Effect.fail(
        noteError(path, "metadata", "invalid-field", "provenance must be a mapping.", "provenance"),
      )
    }

    const source = value.source
    const actor = value.actor
    if (source !== undefined && typeof source !== "string") {
      return yield* Effect.fail(
        noteError(
          path,
          "metadata",
          "invalid-field",
          "provenance.source must be a string.",
          "provenance.source",
        ),
      )
    }
    if (actor !== undefined && typeof actor !== "string") {
      return yield* Effect.fail(
        noteError(
          path,
          "metadata",
          "invalid-field",
          "provenance.actor must be a string.",
          "provenance.actor",
        ),
      )
    }

    if (source === undefined && actor === undefined) {
      return {}
    }

    return {
      ...(source === undefined ? {} : { source }),
      ...(actor === undefined ? {} : { actor }),
    }
  })

const parseOptionalString = (
  path: string,
  value: unknown,
  field: string,
): Effect.Effect<string | undefined, MarkdownError> =>
  Effect.gen(function* () {
    if (value === undefined || value === null) {
      return undefined
    }
    if (typeof value !== "string") {
      return yield* Effect.fail(
        noteError(path, "metadata", "invalid-field", `${field} must be a string.`, field),
      )
    }
    return value
  })

const parseOptionalStringArray = (
  path: string,
  value: unknown,
  field: string,
): Effect.Effect<ReadonlyArray<string> | undefined, MarkdownError> =>
  Effect.gen(function* () {
    if (value === undefined || value === null) {
      return undefined
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      return yield* Effect.fail(
        noteError(
          path,
          "metadata",
          "invalid-field",
          `${field} must be an array of strings.`,
          field,
        ),
      )
    }
    return value as ReadonlyArray<string>
  })

const toNoteInfo = (
  metadata: Markdown.NoteMetadata,
  body: string,
  createdAt: number,
  updatedAt: number,
): Note.Info => {
  switch (metadata.type) {
    case "fleeting":
      return {
        type: "fleeting",
        id: metadata.id as FleetingNote.ID,
        title: metadata.title,
        content: body,
        createdAt,
        updatedAt,
      }
    case "literature":
      return {
        type: "literature",
        id: metadata.id as LiteratureNote.ID,
        title: metadata.title,
        content: body,
        reference: metadata.reference ?? "",
        createdAt,
        updatedAt,
      }
    case "permanent":
      return {
        type: "permanent",
        id: metadata.id as PermanentNote.ID,
        title: metadata.title,
        content: body,
        createdAt,
        updatedAt,
      }
  }
}

/**
 * Renders a note and immediately parses it back, so a caller can never write a
 * file that its own reader would reject. The parse result is the authoritative
 * value returned to the caller.
 */
export const createMarkdownNoteDocument = (
  input: RenderNoteDocumentInput & { readonly path: string },
): Effect.Effect<ParsedMarkdownNote, MarkdownError> => {
  const content = renderNoteDocument(input)
  return parseMarkdownNote({
    path: input.path,
    content,
    mtimeMs: 0,
  })
}
