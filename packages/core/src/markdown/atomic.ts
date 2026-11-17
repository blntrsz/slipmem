import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
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
 * The permission bits of the file being replaced. A rename would otherwise
 * substitute the temporary file's mode and silently widen or narrow access to
 * a note that an operator or umask deliberately protected.
 */
const existingFileMode = (path: string): number | undefined => {
  try {
    const stats = lstatSync(path)
    return stats.isFile() ? stats.mode & 0o777 : undefined
  } catch {
    return undefined
  }
}

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
    // Only an overwrite can preserve a mode; a create must not inherit the
    // permissions of an unrelated file that happens to share the path.
    const preservedMode = options.overwrite ? existingFileMode(path) : undefined

    let descriptor: number | null = null
    try {
      descriptor = openSync(
        temporary,
        "wx",
        preservedMode ?? options.mode ?? 0o644,
      )
      if (preservedMode !== undefined) {
        // open(2) masks the mode with the process umask, so restore the exact
        // bits the previous file had before it is renamed into place.
        fchmodSync(descriptor, preservedMode)
      }
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
