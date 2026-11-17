import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * A private, consistent snapshot of a SQLite source database.
 *
 * Opening a WAL database read-only can create or modify a `-shm` file next to
 * the source, and it fails when the source directory is not writable. Both are
 * unacceptable for planning: a dry run must not write beside the source, and a
 * copied database plus WAL without `-shm` must still be readable.
 *
 * The snapshot copies the main database and its `-wal`/`-journal` sidecars into
 * a private temporary directory, verifies each copy against the source hash,
 * re-checks the source fingerprints, and only then lets the caller open the
 * copy. The temporary directory is always removed afterwards. The original
 * source is never opened by SQLite and is never written to.
 */

export type MigrationSourceErrorCode =
  | "missing"
  | "not-a-file"
  | "unreadable"
  | "changed"

/** Raised when the source cannot be read safely or changed during copying. */
export class MigrationSourceError extends Error {
  readonly code: MigrationSourceErrorCode
  readonly cause: unknown

  constructor(
    code: MigrationSourceErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message)
    this.name = "MigrationSourceError"
    this.code = code
    this.cause = cause
  }
}

export type MigrationSourceSidecar = "" | "-wal" | "-journal"

export interface MigrationSourceFile {
  /** Original source path. */
  readonly path: string
  readonly sidecar: MigrationSourceSidecar
  readonly exists: boolean
  readonly bytes: number
  readonly sha256: string | null
}

export interface MigrationSourceFingerprints {
  readonly main: MigrationSourceFile
  readonly wal: MigrationSourceFile
  readonly journal: MigrationSourceFile
  readonly files: ReadonlyArray<MigrationSourceFile>
}

export interface MigrationSourceSnapshot extends MigrationSourceFingerprints {
  readonly sourcePath: string
  /** Copy of the main database inside `directory`. */
  readonly databasePath: string
  /** Private temporary directory. Removed when the callback returns. */
  readonly directory: string
}

const sha256File = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex")

const fileFingerprint = (
  databasePath: string,
  sidecar: MigrationSourceSidecar,
): MigrationSourceFile => {
  const path = `${databasePath}${sidecar}`
  try {
    const stats = statSync(path, { throwIfNoEntry: false })
    if (stats === undefined) {
      return { path, sidecar, exists: false, bytes: 0, sha256: null }
    }
    if (!stats.isFile()) {
      return { path, sidecar, exists: false, bytes: 0, sha256: null }
    }
    return {
      path,
      sidecar,
      exists: true,
      bytes: stats.size,
      sha256: sha256File(path),
    }
  } catch (cause) {
    throw new MigrationSourceError(
      "unreadable",
      `The migration source file "${path}" could not be read.`,
      cause,
    )
  }
}

/** Fingerprints the source database and its WAL/journal sidecars. */
export const fingerprintSourceFiles = (
  databasePath: string,
): MigrationSourceFingerprints => {
  const main = fileFingerprint(databasePath, "")
  if (!main.exists) {
    throw new MigrationSourceError(
      "missing",
      `The migration source "${databasePath}" does not exist or is not a regular file.`,
    )
  }

  const wal = fileFingerprint(databasePath, "-wal")
  const journal = fileFingerprint(databasePath, "-journal")
  return { main, wal, journal, files: [main, wal, journal] }
}

const sameFiles = (
  left: MigrationSourceFingerprints,
  right: MigrationSourceFingerprints,
): boolean =>
  left.files.every((file, index) => {
    const other = right.files[index]
    return (
      other !== undefined &&
      file.exists === other.exists &&
      file.bytes === other.bytes &&
      file.sha256 === other.sha256
    )
  })

const assertReadableMain = (databasePath: string): void => {
  let stats
  try {
    stats = statSync(databasePath)
  } catch (cause) {
    throw new MigrationSourceError(
      "missing",
      `The migration source "${databasePath}" does not exist or cannot be read.`,
      cause,
    )
  }

  if (!stats.isFile()) {
    throw new MigrationSourceError(
      "not-a-file",
      `The migration source "${databasePath}" is not a regular file.`,
    )
  }
}

const copySidecar = (
  databasePath: string,
  stagedPath: string,
  file: MigrationSourceFile,
): void => {
  if (!file.exists) return

  const target = `${stagedPath}${file.sidecar}`
  try {
    copyFileSync(file.path, target)
    // `copyFileSync` can preserve a read-only mode; the staged copy must remain
    // writable so SQLite can create its WAL index there.
    chmodSync(target, 0o600)
  } catch (cause) {
    throw new MigrationSourceError(
      "unreadable",
      `The migration source file "${file.path}" could not be copied.`,
      cause,
    )
  }

  const copied = fileFingerprint(stagedPath, file.sidecar)
  if (
    !copied.exists ||
    copied.bytes !== file.bytes ||
    copied.sha256 !== file.sha256
  ) {
    throw new MigrationSourceError(
      "changed",
      `The migration source file "${file.path}" changed while it was being copied; no plan was produced.`,
    )
  }
}

const temporarySnapshotDirectory = (): string =>
  mkdtempSync(join(tmpdir(), "slipmem-migration-source-"))

/**
 * Copies the source database and sidecars into a private temporary directory,
 * invokes `use` with the staged copy, and verifies that the source did not
 * change while the callback ran. The staged directory is always deleted.
 */
export const withMigrationSourceSnapshot = <A>(
  databasePath: string,
  use: (snapshot: MigrationSourceSnapshot) => A,
): A => {
  assertReadableMain(databasePath)

  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = fingerprintSourceFiles(databasePath)
    const directory = temporarySnapshotDirectory()
    const stagedPath = join(directory, "source.db")

    try {
      copySidecar(databasePath, stagedPath, before.main)
      copySidecar(databasePath, stagedPath, before.wal)
      copySidecar(databasePath, stagedPath, before.journal)

      const afterCopy = fingerprintSourceFiles(databasePath)
      if (!sameFiles(before, afterCopy)) {
        if (attempt === 3) {
          throw new MigrationSourceError(
            "changed",
            `The migration source "${databasePath}" changed while it was being copied; no plan was produced.`,
          )
        }
        continue
      }

      const snapshot: MigrationSourceSnapshot = {
        ...before,
        sourcePath: databasePath,
        // Preserve the source basename shape inside the private directory for
        // diagnostics, but never expose it as the source path in a plan.
        databasePath: stagedPath,
        directory,
      }

      const value = use(snapshot)

      let afterUse: MigrationSourceFingerprints
      try {
        afterUse = fingerprintSourceFiles(databasePath)
      } catch (cause) {
        throw new MigrationSourceError(
          "changed",
          `The migration source "${databasePath}" disappeared or became unreadable while it was being read; no plan was produced.`,
          cause,
        )
      }
      if (!sameFiles(before, afterUse)) {
        throw new MigrationSourceError(
          "changed",
          `The migration source "${databasePath}" changed while it was being read; no plan was produced.`,
        )
      }

      return value
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  throw new MigrationSourceError(
    "changed",
    `The migration source "${databasePath}" changed while it was being copied; no plan was produced.`,
  )
}
