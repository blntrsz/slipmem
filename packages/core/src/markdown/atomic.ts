import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"
import { MarkdownError, markdownError } from "./errors.js"

const writeError = (path: string, message: string): MarkdownError =>
  markdownError({
    area: "repository",
    code: "write-failed",
    path,
    message,
  })

export interface AtomicWriteOptions {
  /** Rename over an existing file. Creates must pass `false`. */
  readonly overwrite: boolean
  /** File mode; notes are ordinary readable files. */
  readonly mode?: number
}

export interface AtomicWriteResult {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
}

const isAlreadyExists = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { code?: unknown }).code === "EEXIST"

/**
 * Writes a note through a same-directory temporary file, fsync, and rename (or
 * link for create-only writes). A failed validation or failed write leaves the
 * previous file untouched and removes the temporary file.
 */
export const atomicWriteFile = (
  path: string,
  content: string,
  options: AtomicWriteOptions,
): Effect.Effect<AtomicWriteResult, MarkdownError> =>
  Effect.gen(function* () {
    const directory = dirname(path)
    const temporary = join(
      directory,
      `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
    )

    let descriptor: number | null = null
    try {
      descriptor = openSync(temporary, "wx", options.mode ?? 0o644)
      const bytes = Buffer.from(content, "utf8")
      let offset = 0
      while (offset < bytes.length) {
        offset += writeSync(descriptor, bytes, offset, bytes.length - offset)
      }
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = null

      if (options.overwrite) {
        renameSync(temporary, path)
      } else {
        // link(2) is an atomic create: unlike rename it fails when the target
        // already exists, so a cross-process race cannot overwrite a note.
        linkSync(temporary, path)
        unlinkSync(temporary)
      }

      // Persist the directory entry as well as the file contents. Some
      // filesystems do not permit fsync on a directory; that is not a reason to
      // report a successful write as failed.
      try {
        const directoryDescriptor = openSync(directory, "r")
        try {
          fsyncSync(directoryDescriptor)
        } finally {
          closeSync(directoryDescriptor)
        }
      } catch {
        // Best effort.
      }

      const stats = statSync(path)
      return { path, size: stats.size, mtimeMs: stats.mtimeMs }
    } catch (cause) {
      if (descriptor !== null) {
        try {
          closeSync(descriptor)
        } catch {
          // Ignore cleanup failure.
        }
      }
      try {
        unlinkSync(temporary)
      } catch {
        // The temporary file may never have been created.
      }

      if (!options.overwrite && isAlreadyExists(cause)) {
        return yield* Effect.fail(
          markdownError({
            area: "repository",
            code: "write-failed",
            path,
            message: "A note with this filename already exists.",
          }),
        )
      }

      return yield* Effect.fail(
        writeError(
          path,
          `Could not write the note atomically: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      )
    }
  })
