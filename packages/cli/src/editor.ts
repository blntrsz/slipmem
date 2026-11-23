import {
  markdownError,
  parseMarkdownNote,
  type MarkdownError,
  type ParsedMarkdownNote,
} from "@slipmem/core"
import { Effect } from "effect"
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CliContext } from "./context.js"
import { hasEditor } from "./context.js"
import { usageError, type CliFailure } from "./errors.js"

const temporaryBase = (): string => tmpdir()

export const ensureEditor = (context: CliContext): Effect.Effect<void, CliFailure> =>
  hasEditor(context.env)
    ? Effect.void
    : Effect.fail(
        usageError(
          "No editor is configured. Set SLIPMEM_EDITOR, VISUAL, or EDITOR, or pass --content / pipe content on stdin.",
        ),
      )

/**
 * Creates a temporary draft outside the note root, opens it, and always removes
 * it. The draft directory is a scoped resource, so cleanup runs on success,
 * typed failure, defects, and interruption; yielding in a generator `finally`
 * would skip every typed failure and interruption. The editor also receives
 * the effect's abort signal so interrupting the command terminates the child.
 * Validation and the repository write happen in `run`, never in the draft.
 */
export const withTempDraft = <A>(
  filename: string,
  initial: string,
  context: CliContext,
  run: (path: string) => Effect.Effect<A, MarkdownError | CliFailure>,
): Effect.Effect<A, MarkdownError | CliFailure> =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(temporaryBase(), "slipmem-draft-"))),
        (created) =>
          Effect.sync(() => {
            rmSync(created, { recursive: true, force: true })
          }),
      )
      const path = join(directory, filename)

      yield* Effect.sync(() => {
        writeFileSync(path, initial, { encoding: "utf8", mode: 0o600 })
      })

      const status = yield* Effect.tryPromise({
        try: (signal) => context.openEditor(path, signal),
        catch: (cause) =>
          usageError(
            `Could not start the editor: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
      })
      if (status !== 0) {
        return yield* Effect.fail(
          usageError(
            status === -1
              ? "No editor is configured. Set SLIPMEM_EDITOR, VISUAL, or EDITOR."
              : `The editor exited with status ${status}; no note was written.`,
          ),
        )
      }

      return yield* run(path)
    }),
  )

export const readDraft = (path: string): Effect.Effect<string, MarkdownError> =>
  Effect.try({
    try: () => readFileSync(path, "utf8"),
    catch: (cause) =>
      markdownError({
        area: "repository",
        code: "not-found",
        path,
        message: `Could not read the editor draft: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })

/** Parses a draft with the real note contract and reports the real note path. */
export const parseDraft = (
  draftPath: string,
  content: string,
  notePath: string,
): Effect.Effect<ParsedMarkdownNote, MarkdownError> =>
  parseMarkdownNote({ path: draftPath, content }).pipe(
    Effect.mapError((error) =>
      markdownError({
        area: error.area,
        code: error.code,
        path: notePath,
        field: error.field,
        message: error.message,
      }),
    ),
  )
