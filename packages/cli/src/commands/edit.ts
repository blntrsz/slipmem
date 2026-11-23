import {
  markdownError,
  type MarkdownError,
  type ParsedMarkdownNote,
} from "@slipmem/core"
import { Effect, Option } from "effect"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stringOption } from "../args.js"
import { openRepository, resolveRoot } from "../context.js"
import { ensureEditor, parseDraft, readDraft, withTempDraft } from "../editor.js"
import { usageError, type CliUsageError } from "../errors.js"
import { noteToJson } from "../note-values.js"
import { writeJson, writeLine } from "../output.js"
import {
  assertExpectedRevision,
  expectedRevisionOption,
} from "../stale-note.js"
import type { CommandDefinition } from "./command.js"

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

const assertManagedMetadata = (
  current: ParsedMarkdownNote,
  edited: ParsedMarkdownNote,
): Effect.Effect<void, CliUsageError> =>
  Effect.gen(function* () {
    if (edited.metadata.createdAt !== current.metadata.createdAt) {
      return yield* Effect.fail(
        usageError(
          "createdAt is managed by slipmem and cannot be edited directly.",
          "edit",
        ),
      )
    }
    if (edited.metadata.updatedAt !== current.metadata.updatedAt) {
      return yield* Effect.fail(
        usageError(
          "updatedAt is managed by slipmem and cannot be edited directly.",
          "edit",
        ),
      )
    }
    if (!same(edited.unknown, current.unknown)) {
      return yield* Effect.fail(
        usageError(
          "Unknown frontmatter keys cannot be edited through the CLI yet; they are preserved from the current file.",
          "edit",
        ),
      )
    }
    if (edited.metadata.legacyId !== current.metadata.legacyId) {
      return yield* Effect.fail(
        usageError("legacyId is import metadata and cannot be edited.", "edit"),
      )
    }
    if (!same(edited.metadata.aliases ?? [], current.metadata.aliases ?? [])) {
      return yield* Effect.fail(
        usageError("aliases are reserved metadata and cannot be edited.", "edit"),
      )
    }
    if (
      edited.metadata.provenance === undefined &&
      current.metadata.provenance !== undefined
    ) {
      return yield* Effect.fail(
        usageError(
          "provenance cannot be removed from an existing note.",
          "edit",
        ),
      )
    }
  })

const readCurrentContent = (
  note: ParsedMarkdownNote,
): Effect.Effect<string, MarkdownError> =>
  Effect.try({
    try: () => readFileSync(note.path, "utf8"),
    catch: (cause) =>
      markdownError({
        area: "repository",
        code: "not-found",
        path: note.path,
        message: `Could not read the note for editing: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })

/**
 * The raw draft is the version the user edits, so its hash (not a hash from an
 * earlier repository read) is the base for the compare-and-swap. The repository
 * re-reads the file under its lock and compares this value before writing.
 */
const contentHashOf = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex")

export const editCommand: CommandDefinition = {
  name: "edit",
  summary: "Edit a note in $EDITOR and save it atomically after validation",
  usage: "edit <id> [--expect <hash>] [--json]",
  details: [
    "The draft is a full note in a temporary directory outside the repository.",
    "Saving validates the filename, frontmatter, type rules, and body limits",
    "before the repository writes the file atomically. Invalid drafts are",
    "reported and the original note is left untouched.",
    "The write is conditional on the version read for the draft. Pass --expect",
    "with the contentHash from an earlier show to also refuse a version that",
    "changed before the editor opened.",
  ],
  minPositionals: 1,
  maxPositionals: 1,
  options: {
    expect: { type: "string", valueName: "hash" },
    revision: { type: "string", valueName: "hash" },
  },
  run: (parsed, context) =>
    Effect.gen(function* () {
      const id = parsed.positionals[0]!
      const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
      const repository = yield* openRepository(context, resolved.root)
      const current = yield* repository.get(id)

      if (Option.isNone(current)) {
        return yield* Effect.fail(
          markdownError({
            area: "repository",
            code: "not-found",
            path: join(resolved.root, `${id}.md`),
            message: `Note '${id}' was not found in ${resolved.root}.`,
          }),
        )
      }

      const note = current.value
      const expected = expectedRevisionOption(parsed, "edit")
      yield* assertExpectedRevision(note, expected, "edit")
      yield* ensureEditor(context)
      const original = yield* readCurrentContent(note)
      const draftHash = contentHashOf(original)

      const result = yield* withTempDraft(note.filename, original, context, (draftPath) =>
        Effect.gen(function* () {
          const content = yield* readDraft(draftPath)
          if (content === original) {
            return { note, changed: false as const }
          }

          const edited = yield* parseDraft(draftPath, content, note.path)
          yield* assertManagedMetadata(note, edited)

          const saved = yield* repository.update({
            id: note.id,
            type: edited.metadata.type,
            title: edited.metadata.title,
            content: edited.body,
            tags: edited.metadata.tags ?? [],
            reference: edited.metadata.reference ?? null,
            ...(edited.metadata.provenance === undefined
              ? {}
              : { provenance: edited.metadata.provenance }),
            // The hash read for the draft is the base for the compare-and-swap.
            // An explicit --expect was already checked above; both forms make
            // an external edit during the editor session a stale-base failure.
            expectedContentHash: expected ?? draftHash,
          })

          return { note: saved, changed: true as const }
        }),
      )

      if (parsed.options.json === true) {
        writeJson(context.io, {
          ok: true,
          root: resolved.root,
          changed: result.changed,
          note: noteToJson(resolved.root, result.note),
        })
      } else if (result.changed) {
        writeLine(context.io, `Updated note ${result.note.id}`)
        writeLine(context.io, `  ${result.note.path}`)
      } else {
        writeLine(context.io, `No changes to ${result.note.id}.`)
      }

      return 0
    }),
}
