import { Markdown } from "@slipmem/schemas/markdown"
import { Effect, Semaphore } from "effect"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { atomicWriteFile } from "../markdown/atomic.js"
import { splitNoteDocument } from "../markdown/frontmatter.js"
import { withRepositoryLock } from "../markdown/lock.js"
import {
  makeMarkdownNoteRepository,
  type MarkdownNoteRepositoryShape,
} from "../markdown/repository.js"
import {
  defaultBackupDirectory,
  ensureStateSubdirectory,
  isPathInside,
} from "../markdown/root.js"
import {
  checkEvidencePin,
  evidenceDigest,
  isCommitReachable,
  makeInitiativeSnapshot,
  readGitSnapshot,
  readScopeSource,
  resolveGitCommit,
  sha256Hex,
} from "./evidence.js"
import {
  parseAssertionDraft,
  parseInitiativeDraft,
  parseMilestoneDraft,
  parseStoredInitiative,
} from "./draft.js"
import { InitiativeError, initiativeError } from "./errors.js"
import {
  findProjectionNotes,
  initiativeProjectionBody,
  initiativeProjectionMarker,
  initiativeProjectionTitle,
} from "./projection.js"
import {
  extractInitiativeRecordJson,
  renderInitiativeMarkdown,
} from "./render.js"
import {
  ASSERTION_ID_PATTERN,
  INITIATIVE_DIRECTORY,
  INITIATIVE_FILE_SUFFIX,
  INITIATIVE_ID_PATTERN,
  INITIATIVE_PROJECTION_KEY,
  INITIATIVE_SCHEMA,
  MAX_ASSERTIONS_PER_MILESTONE,
  MAX_INITIATIVE_BYTES,
  MAX_MILESTONES,
  type AssertionStatus,
  type AssertionVerification,
  type EvidenceKind,
  type InitiativeAssertion,
  type InitiativeAssertionInput,
  type InitiativeDraftInput,
  type InitiativeMilestone,
  type InitiativeMilestoneInput,
  type InitiativeProjectionReceipt,
  type InitiativeProjectionReconcileItem,
  type InitiativeProjectionReconcileReport,
  type InitiativeProjectionResult,
  type InitiativePromotion,
  type InitiativeRecord,
  type InitiativeRecordData,
  type InitiativeScan,
  type InitiativeScope,
  type InitiativeScopeView,
  type InitiativeSummary,
  type InitiativeVerificationReport,
  type PromoteAssertionResult,
} from "./types.js"

export interface InitiativeServiceConfig {
  /** The note root (`.slipmem/`); initiative records live in a nested child. */
  readonly root: string
  /**
   * Optional record directory. It must stay inside `root` and must not be the
   * flat note root itself. Defaults to `<root>/initiatives`.
   */
  readonly directory?: string
  /**
   * Project/source root for code and test evidence. Defaults to the parent of a
   * `.slipmem` note root, otherwise the note root.
   */
  readonly evidenceRoot?: string
  readonly now?: () => number
  /**
   * Optional permanent-note repository. Defaults to the canonical Markdown note
   * repository over the same root. Tests can inject a repository to assert that
   * projection never updates an existing human note.
   */
  readonly repository?: MarkdownNoteRepositoryShape
  /** Backup directory used by the default repository; must be outside root. */
  readonly backupDir?: string
  /**
   * The configured trusted main ref. When Git resolves it, evidence is read from
   * the observed commit (not the dirty working tree), and promotion requires the
   * observed commit to be an ancestor of this ref. Set to null to use the
   * working tree explicitly (the report discloses `verificationMode`).
   */
  readonly mainRef?: string | null
  /** Ref whose commit is observed for evidence and promotion. Defaults to HEAD. */
  readonly observedRef?: string
  /**
   * When true, promotion refuses when no trusted main snapshot can be resolved.
   * Defaults to false so temporary and non-Git project roots remain usable.
   */
  readonly requireMain?: boolean
}

export interface InitiativeServiceShape {
  readonly root: string
  readonly directory: string
  readonly evidenceRoot: string
  readonly scan: () => Effect.Effect<InitiativeScan, InitiativeError>
  readonly list: () => Effect.Effect<ReadonlyArray<InitiativeSummary>, InitiativeError>
  readonly get: (id: string) => Effect.Effect<InitiativeRecord, InitiativeError>
  readonly readScope: (id: string) => Effect.Effect<InitiativeScopeView, InitiativeError>
  readonly create: (
    input: InitiativeDraftInput,
  ) => Effect.Effect<InitiativeRecord, InitiativeError>
  readonly appendMilestone: (
    id: string,
    input: InitiativeMilestoneInput,
  ) => Effect.Effect<InitiativeRecord, InitiativeError>
  readonly appendAssertion: (
    id: string,
    milestoneId: string,
    input: InitiativeAssertionInput,
  ) => Effect.Effect<InitiativeRecord, InitiativeError>
  readonly verify: (
    id: string,
  ) => Effect.Effect<InitiativeVerificationReport, InitiativeError>
  readonly promote: (
    id: string,
    assertionId: string,
  ) => Effect.Effect<PromoteAssertionResult, InitiativeError>
  /**
   * Project one already-promoted assertion into a permanent note. Requires a
   * current, supported verification and a main-reachable promotion snapshot.
   */
  readonly project: (
    id: string,
    assertionId: string,
  ) => Effect.Effect<InitiativeProjectionResult, InitiativeError>
  /**
   * Idempotently project every landed promotion (or one initiative) whose
   * permanent note is missing. Existing projection notes are reused.
   */
  readonly reconcile: (
    id?: string,
  ) => Effect.Effect<InitiativeProjectionReconcileReport, InitiativeError>
}

export const defaultInitiativeDirectory = (root: string): string =>
  join(resolve(root), INITIATIVE_DIRECTORY)

export const defaultEvidenceRoot = (root: string): string => {
  const absoluteRoot = resolve(root)
  return basename(absoluteRoot) === ".slipmem" ? dirname(absoluteRoot) : absoluteRoot
}

const PROJECTION_RECEIPT_DIRECTORY = "initiative-projections"
const PROJECTION_RECEIPT_SCHEMA = "slipmem.initiative-projection-receipt.v1"
const PROJECTION_PENDING_MS = 30_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Projection is outside the initiative write lock because the Markdown
// repository takes the same repository lock. A process-local semaphore still
// serializes two same-process promote/reconcile calls before the atomic receipt
// and cross-process note lock take over.
const projectionSemaphores = new Map<string, Semaphore.Semaphore>()

const projectionSemaphoreFor = (key: string): Semaphore.Semaphore => {
  const existing = projectionSemaphores.get(key)
  if (existing !== undefined) {
    return existing
  }
  const semaphore = Semaphore.makeUnsafe(1)
  projectionSemaphores.set(key, semaphore)
  return semaphore
}

const serviceError = (
  code:
    | "invalid-id"
    | "invalid-draft"
    | "invalid-initiative"
    | "initiative-not-found"
    | "initiative-exists"
    | "initiative-file-too-large"
    | "read-failed"
    | "write-failed"
    | "unsupported-promotion"
    | "already-promoted"
    | "main-required"
    | "projection-requires-landed-main"
    | "projection-not-promoted"
    | "projection-in-progress"
    | "projection-failed",
  path: string,
  message: string,
  extra: {
    readonly field?: string
    readonly initiativeId?: string
    readonly milestoneId?: string
    readonly assertionId?: string
  } = {},
): InitiativeError =>
  initiativeError({
    code,
    path,
    message,
    ...extra,
  })

const fromMarkdown = (
  error:
    | { readonly path: string; readonly message: string; readonly code?: string }
    | InitiativeError,
): InitiativeError =>
  (error as InitiativeError)._tag === "InitiativeError"
    ? (error as InitiativeError)
    : initiativeError({
        code:
          (error as { code?: string }).code === "write-failed" ||
          (error as { code?: string }).code === "repository-locked"
            ? "write-failed"
            : "read-failed",
        path: error.path,
        message: error.message,
      })

const nowIso = (now: () => number): string => {
  const value = now()
  return Markdown.toUtcTimestamp(
    Number.isFinite(value) ? value : Date.now(),
  ).isoTimestamp
}

const latestIso = (previous: string, next: string): string =>
  next < previous ? previous : next

const allocateId = (
  prefix: string,
  label: string,
  taken: ReadonlySet<string>,
): string => {
  const base = `${prefix}-${Markdown.slugifyTitle(label)}`
  if (!taken.has(base)) {
    return base
  }
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${base}-${suffix}`
    if (!taken.has(candidate)) {
      return candidate
    }
  }
  throw new Error(`Could not allocate a unique ${prefix} ID.`)
}

const assertInitiativeId = (
  id: string,
  path: string,
): Effect.Effect<void, InitiativeError> =>
  INITIATIVE_ID_PATTERN.test(id)
    ? Effect.void
    : Effect.fail(
        serviceError(
          "invalid-id",
          path,
          `'${id}' is not an initiative ID. Expected initiative-<kebab-case>.`,
          { field: "id", initiativeId: id },
        ),
      )

const assertRoot = (root: string): Effect.Effect<void, InitiativeError> =>
  Effect.gen(function* () {
    if (!existsSync(root)) {
      return yield* Effect.fail(
        serviceError(
          "read-failed",
          root,
          `The note root does not exist. Run 'slipmem init' or create ${root}.`,
        ),
      )
    }
    let stats: ReturnType<typeof lstatSync>
    try {
      stats = lstatSync(root)
    } catch (cause) {
      return yield* Effect.fail(
        serviceError(
          "read-failed",
          root,
          `Could not inspect the note root: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      )
    }
    if (stats.isSymbolicLink()) {
      return yield* Effect.fail(
        serviceError("read-failed", root, "The note root must not be a symbolic link."),
      )
    }
    if (!stats.isDirectory()) {
      return yield* Effect.fail(
        serviceError("read-failed", root, "The note root is not a directory."),
      )
    }
  })

const ensureDirectory = (
  root: string,
  directory: string,
): Effect.Effect<void, InitiativeError> =>
  Effect.gen(function* () {
    const absoluteRoot = resolve(root)
    const absoluteDirectory = resolve(directory)
    if (
      absoluteDirectory === absoluteRoot ||
      !isPathInside(absoluteDirectory, absoluteRoot)
    ) {
      return yield* Effect.fail(
        serviceError(
          "write-failed",
          absoluteDirectory,
          "The initiative directory must be a nested directory inside the note root, never the flat note root itself.",
        ),
      )
    }

    if (existsSync(absoluteDirectory)) {
      let stats: ReturnType<typeof lstatSync>
      try {
        stats = lstatSync(absoluteDirectory)
      } catch (cause) {
        return yield* Effect.fail(
          serviceError(
            "write-failed",
            absoluteDirectory,
            `Could not inspect the initiative directory: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
        )
      }
      if (stats.isSymbolicLink()) {
        return yield* Effect.fail(
          serviceError(
            "write-failed",
            absoluteDirectory,
            "The initiative directory must not be a symbolic link.",
          ),
        )
      }
      if (!stats.isDirectory()) {
        return yield* Effect.fail(
          serviceError(
            "write-failed",
            absoluteDirectory,
            "The initiative directory path is not a directory.",
          ),
        )
      }
    } else {
      try {
        mkdirSync(absoluteDirectory, { recursive: true, mode: 0o755 })
      } catch (cause) {
        return yield* Effect.fail(
          serviceError(
            "write-failed",
            absoluteDirectory,
            `Could not create the initiative directory: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
        )
      }
    }

    try {
      const realRoot = realpathSync(absoluteRoot)
      const realDirectory = realpathSync(absoluteDirectory)
      if (!isPathInside(realDirectory, realRoot)) {
        return yield* Effect.fail(
          serviceError(
            "write-failed",
            absoluteDirectory,
            "The initiative directory resolves outside the note root through a symlink.",
          ),
        )
      }
    } catch (cause) {
      return yield* Effect.fail(
        serviceError(
          "write-failed",
          absoluteDirectory,
          `Could not resolve the initiative directory: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      )
    }
  })

const initiativeFile = (
  directory: string,
  id: string,
): Effect.Effect<string, InitiativeError> => {
  const path = join(directory, `${id}${INITIATIVE_FILE_SUFFIX}`)
  return assertInitiativeId(id, path).pipe(Effect.map(() => path))
}

const readInitiativeFile = (
  path: string,
): Effect.Effect<InitiativeRecord, InitiativeError> =>
  Effect.gen(function* () {
    if (!existsSync(path)) {
      return yield* Effect.fail(
        serviceError("initiative-not-found", path, `Initiative file '${path}' was not found.`),
      )
    }

    let stats: ReturnType<typeof lstatSync>
    try {
      stats = lstatSync(path)
    } catch (cause) {
      return yield* Effect.fail(
        serviceError(
          "read-failed",
          path,
          `Could not inspect the initiative file: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      )
    }
    if (stats.isSymbolicLink()) {
      return yield* Effect.fail(
        serviceError("read-failed", path, "Initiative files must not be symbolic links."),
      )
    }
    if (!stats.isFile()) {
      return yield* Effect.fail(
        serviceError("read-failed", path, "Initiative record must be a regular file."),
      )
    }
    if (stats.size > MAX_INITIATIVE_BYTES) {
      return yield* Effect.fail(
        serviceError(
          "initiative-file-too-large",
          path,
          `Initiative files must be ${MAX_INITIATIVE_BYTES} bytes or fewer.`,
        ),
      )
    }

    let content: string
    try {
      content = readFileSync(path, "utf8")
    } catch (cause) {
      return yield* Effect.fail(
        serviceError(
          "read-failed",
          path,
          `Could not read the initiative file: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      )
    }

    const split = yield* splitNoteDocument(path, content).pipe(
      Effect.mapError(fromMarkdown),
    )
    const json = yield* extractInitiativeRecordJson(split.body, path)
    const data = yield* parseStoredInitiative(json, path)
    const filenameId = basename(path, INITIATIVE_FILE_SUFFIX)
    if (filenameId !== data.id) {
      return yield* Effect.fail(
        serviceError(
          "read-failed",
          path,
          `Initiative filename '${filenameId}' does not match its record ID '${data.id}'.`,
          { field: "id", initiativeId: data.id },
        ),
      )
    }
    if (split.data.id !== data.id) {
      return yield* Effect.fail(
        serviceError(
          "read-failed",
          path,
          "Initiative frontmatter id must match the machine record id.",
          { field: "id", initiativeId: data.id },
        ),
      )
    }
    if (split.data.schema !== undefined && split.data.schema !== INITIATIVE_SCHEMA) {
      return yield* Effect.fail(
        serviceError(
          "read-failed",
          path,
          `Initiative frontmatter schema must be '${INITIATIVE_SCHEMA}'.`,
          { field: "schema", initiativeId: data.id },
        ),
      )
    }

    return {
      ...data,
      path,
      contentHash: sha256Hex(content),
    }
  })

const writeInitiative = (
  path: string,
  data: InitiativeRecordData,
  overwrite: boolean,
): Effect.Effect<InitiativeRecord, InitiativeError> =>
  Effect.gen(function* () {
    const content = renderInitiativeMarkdown(data)
    if (Buffer.byteLength(content, "utf8") > MAX_INITIATIVE_BYTES) {
      return yield* Effect.fail(
        serviceError(
          "initiative-file-too-large",
          path,
          `The rendered initiative record exceeds ${MAX_INITIATIVE_BYTES} bytes. Remove milestones, assertions, or evidence pins.`,
          { initiativeId: data.id },
        ),
      )
    }

    yield* atomicWriteFile(path, content, { overwrite }).pipe(
      Effect.mapError((error) =>
        serviceError(
          "write-failed",
          path,
          `Could not write the initiative record: ${error.message}`,
          { initiativeId: data.id },
        ),
      ),
    )
    return yield* readInitiativeFile(path)
  })

const summaryOf = (record: InitiativeRecord): InitiativeSummary => ({
  id: record.id,
  title: record.title,
  path: record.path,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  revision: record.revision,
  milestoneCount: record.milestones.length,
  assertionCount: record.milestones.reduce(
    (total, milestone) => total + milestone.assertions.length,
    0,
  ),
  promotionCount: record.promotions.length,
})

/** Drops read-only path/hash fields before rendering the machine record. */
const dataOf = (record: InitiativeRecordData): InitiativeRecordData => ({
  schema: record.schema,
  id: record.id,
  title: record.title,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  revision: record.revision,
  scope: record.scope,
  milestones: record.milestones,
  promotions: record.promotions,
})

const assignMilestone = (
  input: InitiativeMilestoneInput,
  takenMilestoneIds: Set<string>,
  takenAssertionIds: Set<string>,
): InitiativeMilestone => {
  const id = allocateId("milestone", input.title, takenMilestoneIds)
  takenMilestoneIds.add(id)
  const assertions: InitiativeAssertion[] = (input.assertions ?? []).map(
    (assertion) => {
      const assertionId = allocateId("assertion", assertion.claim, takenAssertionIds)
      takenAssertionIds.add(assertionId)
      return {
        id: assertionId,
        claim: assertion.claim,
        ...(assertion.intendedBehavior === undefined
          ? {}
          : { intendedBehavior: assertion.intendedBehavior }),
        requiredEvidence: assertion.requiredEvidence ?? [],
        supports: assertion.supports ?? [],
        contradicts: assertion.contradicts ?? [],
      }
    },
  )
  return {
    id,
    title: input.title,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    intendedBehavior: input.intendedBehavior,
    assertions,
  }
}

const buildScope = (
  input: InitiativeDraftInput["scope"],
  evidenceRoot: string,
): Effect.Effect<InitiativeScope, InitiativeError> =>
  Effect.gen(function* () {
    const source =
      input.sourcePath === undefined
        ? undefined
        : yield* readScopeSource(evidenceRoot, input.sourcePath)
    return {
      summary: input.summary,
      intendedBehavior: input.intendedBehavior,
      outOfScope: input.outOfScope ?? [],
      constraints: input.constraints ?? [],
      ...(source === undefined ? {} : { source }),
    }
  })

const statusCounts = (
  rows: ReadonlyArray<AssertionVerification>,
  milestoneId: string,
): {
  readonly supported: number
  readonly contradicted: number
  readonly notEvidenced: number
  readonly promoted: number
} => {
  const scoped = rows.filter((row) => row.milestoneId === milestoneId)
  return {
    supported: scoped.filter((row) => row.status === "supported").length,
    contradicted: scoped.filter((row) => row.status === "contradicted").length,
    notEvidenced: scoped.filter((row) => row.status === "not-evidenced").length,
    promoted: scoped.filter((row) => row.promoted).length,
  }
}

const verificationFor = (
  record: InitiativeRecord,
  evidenceRoot: string,
  now: () => number,
  mainRef: string | null,
  observedRef: string,
): Effect.Effect<InitiativeVerificationReport, InitiativeError> =>
  Effect.gen(function* () {
    const snapshot =
      mainRef === null
        ? null
        : makeInitiativeSnapshot(evidenceRoot, mainRef, observedRef)
    const trusted =
      snapshot === null
        ? undefined
        : { root: evidenceRoot, commit: snapshot.observedCommit }
    const rows: AssertionVerification[] = []
    const promotionsByAssertion = new Map(
      record.promotions.map((promotion) => [promotion.assertionId, promotion]),
    )

    for (const milestone of record.milestones) {
      for (const assertion of milestone.assertions) {
        const supportChecks = yield* Effect.forEach(
          assertion.supports,
          (pin) => checkEvidencePin(evidenceRoot, pin, "support", trusted),
        )
        const contradictionChecks = yield* Effect.forEach(
          assertion.contradicts,
          (pin) => checkEvidencePin(evidenceRoot, pin, "contradict", trusted),
        )
        const checks = [...supportChecks, ...contradictionChecks]
        const validSupports = supportChecks.filter((check) => check.valid)
        const validContradictions = contradictionChecks.filter((check) => check.valid)
        const invalidSupports = supportChecks.filter((check) => !check.valid)
        const missingRequiredKinds: EvidenceKind[] = (
          assertion.requiredEvidence ?? []
        ).filter(
          (kind) =>
            !validSupports.some((check) => check.kind === kind),
        )

        const status: AssertionStatus =
          validContradictions.length > 0
            ? "contradicted"
            : assertion.supports.length === 0 ||
                invalidSupports.length > 0 ||
                missingRequiredKinds.length > 0
              ? "not-evidenced"
              : "supported"

        const promotion = promotionsByAssertion.get(assertion.id)
        const currentDigest =
          status === "supported" ? evidenceDigest(assertion.supports) : undefined
        const promotionStatus =
          promotion === undefined
            ? undefined
            : status === "supported" && currentDigest === promotion.evidenceDigest
              ? ("current" as const)
              : ("stale" as const)

        rows.push({
          initiativeId: record.id,
          milestoneId: milestone.id,
          milestoneTitle: milestone.title,
          assertionId: assertion.id,
          claim: assertion.claim,
          ...(assertion.intendedBehavior === undefined
            ? {}
            : { intendedBehavior: assertion.intendedBehavior }),
          status,
          requiredEvidence: assertion.requiredEvidence ?? [],
          missingRequiredKinds,
          evidence: checks,
          promoted: promotion !== undefined,
          ...(promotion === undefined ? {} : { promotionId: promotion.id }),
          ...(promotionStatus === undefined ? {} : { promotionStatus }),
        })
      }
    }

    const milestones = record.milestones.map((milestone) => {
      const counts = statusCounts(rows, milestone.id)
      const scopedRows = rows.filter((row) => row.milestoneId === milestone.id)
      const allPromotedAndCurrent =
        scopedRows.length > 0 &&
        scopedRows.every(
          (row) =>
            row.status === "supported" &&
            row.promoted &&
            row.promotionStatus === "current",
        )
      const status =
        milestone.assertions.length === 0 || counts.promoted === 0
          ? ("planned" as const)
          : allPromotedAndCurrent
            ? ("landed" as const)
            : ("active" as const)
      return {
        milestoneId: milestone.id,
        title: milestone.title,
        status,
        assertionCount: milestone.assertions.length,
        supportedCount: counts.supported,
        contradictedCount: counts.contradicted,
        notEvidencedCount: counts.notEvidenced,
        promotedCount: counts.promoted,
      }
    })

    return {
      advisory: true,
      automaticPrVerification: false,
      automaticPromotion: false,
      operatorActionRequired: true,
      verificationMode: snapshot === null ? "working-tree" : "trusted-snapshot",
      initiativeId: record.id,
      title: record.title,
      path: record.path,
      verifiedAt: nowIso(now),
      revision: record.revision,
      scope: record.scope,
      git: readGitSnapshot(evidenceRoot),
      snapshot,
      milestones,
      supported: rows.filter((row) => row.status === "supported"),
      contradicted: rows.filter((row) => row.status === "contradicted"),
      notEvidenced: rows.filter((row) => row.status === "not-evidenced"),
      promotions: record.promotions,
    }
  })

export const makeInitiativeService = (
  config: InitiativeServiceConfig,
): Effect.Effect<InitiativeServiceShape, InitiativeError> =>
  Effect.gen(function* () {
    const root = resolve(config.root)
    const directory = resolve(
      config.directory ?? defaultInitiativeDirectory(root),
    )
    const evidenceRoot = resolve(config.evidenceRoot ?? defaultEvidenceRoot(root))
    const now = config.now ?? Date.now
    const requireMain = config.requireMain === true
    const mainRef = config.mainRef === undefined ? "main" : config.mainRef
    const observedRef = config.observedRef ?? "HEAD"

    yield* assertRoot(root)

    if (
      config.repository !== undefined &&
      resolve(config.repository.root) !== root
    ) {
      return yield* Effect.fail(
        serviceError(
          "invalid-initiative",
          root,
          "The injected permanent-note repository must use the same note root as the initiative service.",
        ),
      )
    }

    const repository =
      config.repository ??
      (yield* makeMarkdownNoteRepository({
        root,
        now,
        backupDir: config.backupDir ?? defaultBackupDirectory(root),
      }).pipe(Effect.mapError(fromMarkdown)))

    const projectionReceiptDirectory = (): Effect.Effect<string, InitiativeError> =>
      Effect.try({
        try: () => ensureStateSubdirectory(root, PROJECTION_RECEIPT_DIRECTORY),
        catch: (cause) =>
          serviceError(
            "projection-failed",
            root,
            `Could not create the projection receipt directory: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
      })

    const receiptPath = (
      directory: string,
      promotion: InitiativePromotion,
    ): string =>
      join(
        directory,
        `${sha256Hex(
          `${promotion.initiativeId}\0${promotion.assertionId}\0${promotion.id}`,
        ).slice(0, 32)}.json`,
      )

    const isReceipt = (value: unknown): value is InitiativeProjectionReceipt =>
      isRecord(value) &&
      value.schema === PROJECTION_RECEIPT_SCHEMA &&
      typeof value.promotionId === "string" &&
      typeof value.initiativeId === "string" &&
      typeof value.assertionId === "string" &&
      typeof value.evidenceDigest === "string" &&
      (value.status === "pending" || value.status === "projected") &&
      typeof value.createdAt === "string" &&
      typeof value.updatedAt === "string" &&
      typeof value.pid === "number"

    const readReceipt = (path: string): InitiativeProjectionReceipt | null => {
      if (!existsSync(path)) {
        return null
      }
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
        return isReceipt(parsed) ? parsed : null
      } catch {
        return null
      }
    }

    const removeReceipt = (path: string): Effect.Effect<void> =>
      Effect.sync(() => {
        try {
          unlinkSync(path)
        } catch {
          // Already removed or never created.
        }
      })

    const writeReceipt = (
      path: string,
      receipt: InitiativeProjectionReceipt,
      overwrite: boolean,
    ): Effect.Effect<InitiativeProjectionReceipt, InitiativeError> =>
      atomicWriteFile(path, `${JSON.stringify(receipt, null, 2)}\n`, {
        overwrite,
        mode: 0o600,
      }).pipe(
        Effect.map(() => receipt),
        Effect.mapError((error) =>
          serviceError(
            "projection-failed",
            path,
            `Could not write the projection receipt: ${error.message}`,
            {
              initiativeId: receipt.initiativeId,
              assertionId: receipt.assertionId,
            },
          ),
        ),
      )

    const newReceipt = (
      promotion: InitiativePromotion,
      status: "pending" | "projected",
    ): InitiativeProjectionReceipt => {
      const timestamp = nowIso(now)
      return {
        schema: PROJECTION_RECEIPT_SCHEMA,
        promotionId: promotion.id,
        initiativeId: promotion.initiativeId,
        assertionId: promotion.assertionId,
        evidenceDigest: promotion.evidenceDigest,
        status,
        createdAt: timestamp,
        updatedAt: timestamp,
        pid: process.pid,
      }
    }

    /**
     * A receipt is live when another process started or refreshed a pending
     * projection recently. Liveness follows `updatedAt`, not `createdAt`: a
     * takeover preserves `createdAt` while refreshing `updatedAt`, so an old
     * `createdAt` would keep an already-taken-over receipt looking stale.
     * Pending receipts have no heartbeat, so staleness is inferred from age.
     */
    const receiptIsLive = (
      receipt: InitiativeProjectionReceipt,
      timestamp: string,
    ): boolean => {
      if (receipt.status !== "pending" || receipt.pid === process.pid) {
        return false
      }
      const age = Date.parse(timestamp) - Date.parse(receipt.updatedAt)
      return Number.isFinite(age) && age < PROJECTION_PENDING_MS
    }

    const beginReceipt = (
      promotion: InitiativePromotion,
    ): Effect.Effect<
      { readonly path: string; readonly receipt: InitiativeProjectionReceipt },
      InitiativeError
    > =>
      Effect.gen(function* () {
        const directory = yield* projectionReceiptDirectory()
        const path = receiptPath(directory, promotion)
        const existing = readReceipt(path)
        const timestamp = nowIso(now)

        if (existing !== null) {
          if (receiptIsLive(existing, timestamp)) {
            return yield* Effect.fail(
              serviceError(
                "projection-in-progress",
                path,
                "Another process has a fresh pending projection receipt. Retry after it finishes, or reconcile once its receipt is stale.",
                {
                  initiativeId: promotion.initiativeId,
                  assertionId: promotion.assertionId,
                },
              ),
            )
          }
          const pending: InitiativeProjectionReceipt = {
            ...newReceipt(promotion, "pending"),
            createdAt: existing.createdAt,
            updatedAt: timestamp,
          }
          yield* writeReceipt(path, pending, true)
          return { path, receipt: pending }
        }

        const pending = newReceipt(promotion, "pending")
        const attempted = yield* atomicWriteFile(
          path,
          `${JSON.stringify(pending, null, 2)}\n`,
          { overwrite: false, mode: 0o600 },
        ).pipe(
          Effect.match({
            onFailure: (error) => ({ error, written: false as const }),
            onSuccess: () => ({ error: null, written: true as const }),
          }),
        )

        if (attempted.written) {
          return { path, receipt: pending }
        }

        const raced = readReceipt(path)
        if (raced !== null && receiptIsLive(raced, timestamp)) {
          return yield* Effect.fail(
            serviceError(
              "projection-in-progress",
              path,
              "Another process won the projection receipt race. Retry after it finishes.",
              {
                initiativeId: promotion.initiativeId,
                assertionId: promotion.assertionId,
              },
            ),
          )
        }
        if (raced !== null) {
          yield* writeReceipt(path, pending, true)
          return { path, receipt: pending }
        }
        return yield* Effect.fail(
          serviceError(
            "projection-failed",
            path,
            `Could not create the projection receipt: ${attempted.error.message}`,
            {
              initiativeId: promotion.initiativeId,
              assertionId: promotion.assertionId,
            },
          ),
        )
      })

    const recordProjectedReceipt = (
      promotion: InitiativePromotion,
      note: {
        readonly id: string
        readonly path: string
        readonly contentHash: string
      },
    ): Effect.Effect<InitiativeProjectionReceipt, InitiativeError> =>
      Effect.gen(function* () {
        const directory = yield* projectionReceiptDirectory()
        const path = receiptPath(directory, promotion)
        const existing = readReceipt(path)
        const timestamp = nowIso(now)
        const receipt: InitiativeProjectionReceipt = {
          schema: PROJECTION_RECEIPT_SCHEMA,
          promotionId: promotion.id,
          initiativeId: promotion.initiativeId,
          assertionId: promotion.assertionId,
          evidenceDigest: promotion.evidenceDigest,
          status: "projected",
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
          pid: process.pid,
          noteId: note.id,
          notePath: note.path,
          noteContentHash: note.contentHash,
        }
        yield* writeReceipt(path, receipt, true)
        return receipt
      })

    const projectionResult = (
      promotion: InitiativePromotion,
    ): Pick<
      InitiativeProjectionResult,
      "advisory" | "promotionId" | "initiativeId" | "assertionId"
    > => ({
      advisory: true,
      promotionId: promotion.id,
      initiativeId: promotion.initiativeId,
      assertionId: promotion.assertionId,
    })

    /**
     * Re-checks the stored promotion snapshot against the *current* configured
     * main ref when Git is available. A historical reachable flag is not enough
     * after a force-push or a changed main ref.
     */
    const promotionSnapshotLanded = (
      promotion: InitiativePromotion,
    ): boolean => {
      const snapshot = promotion.snapshot
      if (
        snapshot === null ||
        snapshot.mainCommit === null ||
        !snapshot.reachableFromMain
      ) {
        return false
      }
      if (mainRef === null) {
        return true
      }
      const currentMain = resolveGitCommit(evidenceRoot, mainRef)
      return (
        currentMain !== null &&
        isCommitReachable(evidenceRoot, snapshot.observedCommit, currentMain)
      )
    }

    const projectPromotion = (
      record: InitiativeRecord,
      milestone: InitiativeMilestone,
      assertion: InitiativeAssertion,
      promotion: InitiativePromotion,
      takeoverPending = false,
    ): Effect.Effect<InitiativeProjectionResult, InitiativeError> => {
      const run: Effect.Effect<InitiativeProjectionResult, InitiativeError> =
        Effect.gen(function* () {
        const identity = {
          initiativeId: record.id,
          assertionId: assertion.id,
          promotionId: promotion.id,
        }
        const scan = yield* repository.scan().pipe(Effect.mapError(fromMarkdown))
        const existing = findProjectionNotes(scan.notes, identity)[0]
        if (existing !== undefined) {
          const receipt = yield* recordProjectedReceipt(promotion, existing.note)
          return {
            ...projectionResult(promotion),
            status: "existing",
            stale: existing.marker.promotionDigest !== promotion.evidenceDigest,
            noteId: existing.note.id,
            notePath: existing.note.path,
            noteContentHash: existing.note.contentHash,
            receipt,
          }
        }

        if (promotion.snapshot === null) {
          return {
            ...projectionResult(promotion),
            status: "skipped",
            reason: "unversioned",
          }
        }
        if (!promotionSnapshotLanded(promotion)) {
          return {
            ...projectionResult(promotion),
            status: "skipped",
            reason: "not-landed-on-main",
          }
        }

        // Reconcile recovers stale receipts, but a live pending receipt belongs
        // to another process and must not be taken over. Report it as pending
        // instead of aborting the whole reconcile report.
        const begun = yield* beginReceipt(promotion).pipe(
          Effect.catch((error) =>
            takeoverPending && error.code === "projection-in-progress"
              ? Effect.succeed(null)
              : Effect.fail(error),
          ),
        )
        if (begun === null) {
          return {
            ...projectionResult(promotion),
            status: "pending",
            reason: "projection-in-progress",
          }
        }
        const rescan = yield* repository.scan().pipe(Effect.mapError(fromMarkdown))
        const raced = findProjectionNotes(rescan.notes, identity)[0]
        if (raced !== undefined) {
          const receipt = yield* recordProjectedReceipt(promotion, raced.note)
          return {
            ...projectionResult(promotion),
            status: "existing",
            stale: raced.marker.promotionDigest !== promotion.evidenceDigest,
            noteId: raced.note.id,
            notePath: raced.note.path,
            noteContentHash: raced.note.contentHash,
            receipt,
          }
        }

        const created = yield* repository.create({
          type: "permanent",
          title: initiativeProjectionTitle(record, assertion),
          content: initiativeProjectionBody(record, milestone, assertion, promotion),
          provenance: { source: "initiative", actor: "operator" },
          unknown: {
            [INITIATIVE_PROJECTION_KEY]: initiativeProjectionMarker(
              record,
              milestone,
              assertion,
              promotion,
            ),
          },
        }).pipe(
          Effect.match({
            onFailure: (error) => ({ error, note: null }),
            onSuccess: (note) => ({ error: null, note }),
          }),
        )

        if (created.error !== null) {
          yield* removeReceipt(begun.path)
          return yield* Effect.fail(
            serviceError(
              "projection-failed",
              created.error.path,
              `Could not create the permanent projection note: ${created.error.message}`,
              {
                initiativeId: record.id,
                assertionId: assertion.id,
              },
            ),
          )
        }

        const receipt = yield* recordProjectedReceipt(promotion, created.note)
        return {
          ...projectionResult(promotion),
          status: "created",
          noteId: created.note.id,
          notePath: created.note.path,
          noteContentHash: created.note.contentHash,
          receipt,
        }
      })
      return projectionSemaphoreFor(
        `${root}\0${promotion.initiativeId}\0${promotion.assertionId}`,
      ).withPermits(1)(run)
    }

    const scan = (): Effect.Effect<InitiativeScan, InitiativeError> =>
      Effect.gen(function* () {
        if (!existsSync(directory)) {
          return { initiatives: [], invalid: [] }
        }
        let stats: ReturnType<typeof lstatSync>
        try {
          stats = lstatSync(directory)
        } catch (cause) {
          return yield* Effect.fail(
            serviceError(
              "read-failed",
              directory,
              `Could not inspect the initiative directory: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
          )
        }
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          return yield* Effect.fail(
            serviceError(
              "read-failed",
              directory,
              "The initiative directory must be a real directory, not a symbolic link or file.",
            ),
          )
        }

        let names: ReadonlyArray<string>
        try {
          names = readdirSync(directory)
        } catch (cause) {
          return yield* Effect.fail(
            serviceError(
              "read-failed",
              directory,
              `Could not list the initiative directory: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
          )
        }

        const initiatives: InitiativeRecord[] = []
        const invalid: InitiativeError[] = []
        for (const name of [...names].sort()) {
          if (!name.endsWith(INITIATIVE_FILE_SUFFIX) || name.startsWith(".")) {
            continue
          }
          const result = yield* readInitiativeFile(join(directory, name)).pipe(
            Effect.match({
              onFailure: (error) => ({ error, record: null }),
              onSuccess: (record) => ({ error: null, record }),
            }),
          )
          if (result.error !== null) {
            invalid.push(result.error)
          } else if (result.record !== null) {
            initiatives.push(result.record)
          }
        }

        initiatives.sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            left.id.localeCompare(right.id),
        )
        return { initiatives, invalid }
      })

    const list = (): Effect.Effect<ReadonlyArray<InitiativeSummary>, InitiativeError> =>
      scan().pipe(Effect.map((result) => result.initiatives.map(summaryOf)))

    const get = (id: string): Effect.Effect<InitiativeRecord, InitiativeError> =>
      Effect.gen(function* () {
        const path = yield* initiativeFile(directory, id)
        if (!existsSync(path)) {
          return yield* Effect.fail(
            serviceError(
              "initiative-not-found",
              path,
              `Initiative '${id}' was not found in ${directory}.`,
              { initiativeId: id },
            ),
          )
        }
        return yield* readInitiativeFile(path)
      })

    const readScope = (
      id: string,
    ): Effect.Effect<InitiativeScopeView, InitiativeError> =>
      get(id).pipe(
        Effect.map((record) => ({
          id: record.id,
          title: record.title,
          path: record.path,
          revision: record.revision,
          scope: record.scope,
        })),
      )

    const create = (
      input: InitiativeDraftInput,
    ): Effect.Effect<InitiativeRecord, InitiativeError> =>
      Effect.gen(function* () {
        const draft = yield* parseInitiativeDraft(input)
        if (draft.milestones.length > MAX_MILESTONES) {
          return yield* Effect.fail(
            serviceError(
              "invalid-draft",
              directory,
              `An initiative may have at most ${MAX_MILESTONES} milestones.`,
            ),
          )
        }

        return yield* withRepositoryLock(
          root,
          Effect.gen(function* () {
            yield* ensureDirectory(root, directory)
            const existing = existsSync(directory) ? readdirSync(directory) : []
            const takenInitiativeIds = new Set(
              existing
                .filter((name) => name.endsWith(INITIATIVE_FILE_SUFFIX))
                .map((name) => name.slice(0, -INITIATIVE_FILE_SUFFIX.length)),
            )
            const id = allocateId("initiative", draft.title, takenInitiativeIds)
            const takenMilestoneIds = new Set<string>()
            const takenAssertionIds = new Set<string>()
            const milestones = draft.milestones.map((milestone) =>
              assignMilestone(milestone, takenMilestoneIds, takenAssertionIds),
            )
            const createdAt = nowIso(now)
            const scope = yield* buildScope(draft.scope, evidenceRoot)
            const data: InitiativeRecordData = {
              schema: INITIATIVE_SCHEMA,
              id,
              title: draft.title,
              createdAt,
              updatedAt: createdAt,
              revision: 1,
              scope,
              milestones,
              promotions: [],
            }
            const path = join(directory, `${id}${INITIATIVE_FILE_SUFFIX}`)
            return yield* writeInitiative(path, data, false)
          }),
        ).pipe(Effect.mapError(fromMarkdown))
      })

    const appendMilestone = (
      id: string,
      input: InitiativeMilestoneInput,
    ): Effect.Effect<InitiativeRecord, InitiativeError> =>
      Effect.gen(function* () {
        const milestone = yield* parseMilestoneDraft(input)
        return yield* withRepositoryLock(
          root,
          Effect.gen(function* () {
            yield* ensureDirectory(root, directory)
            const record = yield* get(id)
            if (record.milestones.length >= MAX_MILESTONES) {
              return yield* Effect.fail(
                serviceError(
                  "invalid-draft",
                  record.path,
                  `An initiative may have at most ${MAX_MILESTONES} milestones.`,
                  { initiativeId: id, field: "milestones" },
                ),
              )
            }
            const takenMilestoneIds = new Set(
              record.milestones.map((item) => item.id),
            )
            const takenAssertionIds = new Set(
              record.milestones.flatMap((item) =>
                item.assertions.map((assertion) => assertion.id),
              ),
            )
            const added = assignMilestone(
              milestone,
              takenMilestoneIds,
              takenAssertionIds,
            )
            const updatedAt = latestIso(record.updatedAt, nowIso(now))
            const data: InitiativeRecordData = dataOf({
              ...record,
              updatedAt,
              revision: record.revision + 1,
              milestones: [...record.milestones, added],
            })
            return yield* writeInitiative(record.path, data, true)
          }),
        ).pipe(Effect.mapError(fromMarkdown))
      })

    const appendAssertion = (
      id: string,
      milestoneId: string,
      input: InitiativeAssertionInput,
    ): Effect.Effect<InitiativeRecord, InitiativeError> =>
      Effect.gen(function* () {
        const assertionInput = yield* parseAssertionDraft(input)
        return yield* withRepositoryLock(
          root,
          Effect.gen(function* () {
            yield* ensureDirectory(root, directory)
            const record = yield* get(id)
            const milestone = record.milestones.find(
              (item) => item.id === milestoneId,
            )
            if (milestone === undefined) {
              return yield* Effect.fail(
                serviceError(
                  "initiative-not-found",
                  record.path,
                  `Milestone '${milestoneId}' was not found in initiative '${id}'.`,
                  { initiativeId: id, milestoneId },
                ),
              )
            }
            if (milestone.assertions.length >= MAX_ASSERTIONS_PER_MILESTONE) {
              return yield* Effect.fail(
                serviceError(
                  "invalid-draft",
                  record.path,
                  `A milestone may have at most ${MAX_ASSERTIONS_PER_MILESTONE} assertions.`,
                  { initiativeId: id, milestoneId, field: "assertions" },
                ),
              )
            }
            const takenAssertionIds = new Set(
              record.milestones.flatMap((item) =>
                item.assertions.map((candidate) => candidate.id),
              ),
            )
            const assertionId = allocateId(
              "assertion",
              assertionInput.claim,
              takenAssertionIds,
            )
            const assertion: InitiativeAssertion = {
              id: assertionId,
              claim: assertionInput.claim,
              ...(assertionInput.intendedBehavior === undefined
                ? {}
                : { intendedBehavior: assertionInput.intendedBehavior }),
              requiredEvidence: assertionInput.requiredEvidence ?? [],
              supports: assertionInput.supports ?? [],
              contradicts: assertionInput.contradicts ?? [],
            }
            const updatedAt = latestIso(record.updatedAt, nowIso(now))
            const data: InitiativeRecordData = dataOf({
              ...record,
              updatedAt,
              revision: record.revision + 1,
              milestones: record.milestones.map((item) =>
                item.id === milestoneId
                  ? {
                      ...item,
                      assertions: [...item.assertions, assertion],
                    }
                  : item,
              ),
            })
            return yield* writeInitiative(record.path, data, true)
          }),
        ).pipe(Effect.mapError(fromMarkdown))
      })

    const verify = (
      id: string,
    ): Effect.Effect<InitiativeVerificationReport, InitiativeError> =>
      get(id).pipe(
        Effect.flatMap((record) =>
          verificationFor(record, evidenceRoot, now, mainRef, observedRef),
        ),
      )

    const findAssertion = (
      record: InitiativeRecord,
      assertionId: string,
    ):
      | {
          readonly milestone: InitiativeMilestone
          readonly assertion: InitiativeAssertion
        }
      | undefined => {
      for (const milestone of record.milestones) {
        const assertion = milestone.assertions.find(
          (candidate) => candidate.id === assertionId,
        )
        if (assertion !== undefined) {
          return { milestone, assertion }
        }
      }
      return undefined
    }

    const findRow = (
      report: InitiativeVerificationReport,
      assertionId: string,
    ): AssertionVerification | undefined =>
      [...report.supported, ...report.contradicted, ...report.notEvidenced].find(
        (candidate) => candidate.assertionId === assertionId,
      )

    const promote = (
      id: string,
      assertionId: string,
    ): Effect.Effect<PromoteAssertionResult, InitiativeError> =>
      Effect.gen(function* () {
        if (!ASSERTION_ID_PATTERN.test(assertionId)) {
          return yield* Effect.fail(
            serviceError(
              "invalid-id",
              directory,
              `'${assertionId}' is not an assertion ID.`,
              { field: "assertionId", initiativeId: id, assertionId },
            ),
          )
        }

        const locked = yield* withRepositoryLock(
          root,
          Effect.gen(function* () {
            yield* ensureDirectory(root, directory)
            const record = yield* get(id)
            const milestone = record.milestones.find((item) =>
              item.assertions.some(
                (assertion) => assertion.id === assertionId,
              ),
            )
            const assertion = milestone?.assertions.find(
              (item) => item.id === assertionId,
            )
            if (milestone === undefined || assertion === undefined) {
              return yield* Effect.fail(
                serviceError(
                  "initiative-not-found",
                  record.path,
                  `Assertion '${assertionId}' was not found in initiative '${id}'.`,
                  { initiativeId: id, assertionId },
                ),
              )
            }

            const report = yield* verificationFor(
              record,
              evidenceRoot,
              now,
              mainRef,
              observedRef,
            )
            const row = findRow(report, assertionId)
            if (row === undefined) {
              return yield* Effect.fail(
                serviceError(
                  "unsupported-promotion",
                  record.path,
                  `Assertion '${assertionId}' has no verification row.`,
                  { initiativeId: id, assertionId },
                ),
              )
            }
            if (row.status !== "supported") {
              return yield* Effect.fail(
                serviceError(
                  "unsupported-promotion",
                  record.path,
                  `Assertion '${assertionId}' is ${row.status}. Promotion requires a fresh verification with all declared supporting pins valid${row.missingRequiredKinds.length === 0 ? "" : ` and missing required evidence kinds: ${row.missingRequiredKinds.join(", ")}`}.`,
                  {
                    initiativeId: id,
                    assertionId,
                    field: "status",
                  },
                ),
              )
            }
            if (
              report.snapshot !== null &&
              (report.snapshot.mainCommit === null ||
                !report.snapshot.reachableFromMain)
            ) {
              const reason =
                report.snapshot.mainCommit === null
                  ? `configured main ref '${report.snapshot.mainRef}' could not be resolved`
                  : `observed commit ${report.snapshot.observedCommit.slice(0, 12)} is not reachable from configured main ref '${report.snapshot.mainRef}'`
              return yield* Effect.fail(
                serviceError(
                  "main-required",
                  record.path,
                  `${reason}. Fetch or merge the configured main ref before promoting.`,
                  { initiativeId: id, assertionId, field: "snapshot.reachableFromMain" },
                ),
              )
            }
            if (
              requireMain &&
              (report.snapshot === null ||
                report.snapshot.mainCommit === null ||
                !report.snapshot.reachableFromMain)
            ) {
              return yield* Effect.fail(
                serviceError(
                  "main-required",
                  record.path,
                  "Promotion requires a trusted snapshot whose observed commit is reachable from the configured main ref. Fetch the main ref or pass an explicit unversioned opt-out.",
                  { initiativeId: id, assertionId, field: "snapshot" },
                ),
              )
            }

            const digest = evidenceDigest(assertion.supports)
            const existing = record.promotions.find(
              (promotion) => promotion.assertionId === assertionId,
            )
            const currentLanded =
              report.snapshot !== null &&
              report.snapshot.mainCommit !== null &&
              report.snapshot.reachableFromMain
            const existingLanded =
              existing !== undefined &&
              existing.snapshot !== null &&
              existing.snapshot.mainCommit !== null &&
              existing.snapshot.reachableFromMain
            const sameSnapshot =
              existing !== undefined &&
              ((existing.snapshot === null && report.snapshot === null) ||
                (existing.snapshot !== null &&
                  report.snapshot !== null &&
                  existing.snapshot.mainRef === report.snapshot.mainRef &&
                  existing.snapshot.observedCommit ===
                    report.snapshot.observedCommit))
            if (
              existing !== undefined &&
              existing.evidenceDigest === digest &&
              (sameSnapshot || (existingLanded && !currentLanded))
            ) {
              return {
                created: false,
                promotion: existing,
                record,
                milestone,
                assertion,
                report,
              }
            }

            const promotion: InitiativePromotion = {
              id: `promotion-${assertion.id}`,
              initiativeId: record.id,
              assertionId: assertion.id,
              milestoneId: milestone.id,
              promotedAt: report.verifiedAt,
              verifiedAt: report.verifiedAt,
              evidenceDigest: digest,
              evidence: assertion.supports,
              git: report.git,
              snapshot: report.snapshot,
              advisory: true,
            }
            const promotions =
              existing === undefined
                ? [...record.promotions, promotion]
                : record.promotions.map((item) =>
                    item.assertionId === assertionId ? promotion : item,
                  )
            const updatedAt = latestIso(record.updatedAt, nowIso(now))
            const data: InitiativeRecordData = dataOf({
              ...record,
              updatedAt,
              revision: record.revision + 1,
              promotions,
            })
            const written = yield* writeInitiative(record.path, data, true)
            return {
              created: existing === undefined,
              promotion,
              record: written,
              milestone,
              assertion,
              report,
            }
          }),
        ).pipe(Effect.mapError(fromMarkdown))

        // Note creation must happen outside the initiative write lock: the
        // Markdown repository takes the same repository lock for create.
        // The promotion is already committed here, so a projection failure is
        // reported as a distinct projection state instead of hiding the
        // committed promotion behind an error.
        const projection = yield* projectPromotion(
          locked.record,
          locked.milestone,
          locked.assertion,
          locked.promotion,
        ).pipe(
          Effect.catch(
            (error): Effect.Effect<InitiativeProjectionResult> =>
              Effect.succeed({
                ...projectionResult(locked.promotion),
                status:
                  error.code === "projection-in-progress"
                    ? ("pending" as const)
                    : ("failed" as const),
                reason: error.code,
                error: { code: error.code, message: error.message },
              }),
          ),
        )

        return {
          created: locked.created,
          promotion: locked.promotion,
          record: locked.record,
          projection,
        }
      })

    const project = (
      id: string,
      assertionId: string,
    ): Effect.Effect<InitiativeProjectionResult, InitiativeError> =>
      Effect.gen(function* () {
        if (!ASSERTION_ID_PATTERN.test(assertionId)) {
          return yield* Effect.fail(
            serviceError(
              "invalid-id",
              directory,
              `'${assertionId}' is not an assertion ID.`,
              { field: "assertionId", initiativeId: id, assertionId },
            ),
          )
        }
        const record = yield* get(id)
        const context = findAssertion(record, assertionId)
        if (context === undefined) {
          return yield* Effect.fail(
            serviceError(
              "initiative-not-found",
              record.path,
              `Assertion '${assertionId}' was not found in initiative '${id}'.`,
              { initiativeId: id, assertionId },
            ),
          )
        }
        const report = yield* verificationFor(
          record,
          evidenceRoot,
          now,
          mainRef,
          observedRef,
        )
        const row = findRow(report, assertionId)
        const promotion = record.promotions.find(
          (candidate) => candidate.assertionId === assertionId,
        )
        if (row === undefined || promotion === undefined || !row.promoted) {
          return yield* Effect.fail(
            serviceError(
              "projection-not-promoted",
              record.path,
              `Assertion '${assertionId}' has no promotion to project. Promote it explicitly first.`,
              { initiativeId: id, assertionId },
            ),
          )
        }
        if (row.status !== "supported" || row.promotionStatus !== "current") {
          return yield* Effect.fail(
            serviceError(
              "projection-not-promoted",
              record.path,
              `Assertion '${assertionId}' is not currently supported by its pinned evidence. Re-verify or add fresh pins before projecting.`,
              { initiativeId: id, assertionId, field: "status" },
            ),
          )
        }
        if (
          promotion.snapshot === null ||
          promotion.snapshot.mainCommit === null ||
          !promotion.snapshot.reachableFromMain ||
          !promotionSnapshotLanded(promotion)
        ) {
          return yield* Effect.fail(
            serviceError(
              "projection-requires-landed-main",
              record.path,
              "Projection requires a trusted promotion snapshot whose observed commit is currently reachable from the configured main ref. No unversioned note is written to the main store.",
              { initiativeId: id, assertionId, field: "snapshot" },
            ),
          )
        }
        return yield* projectPromotion(
          record,
          context.milestone,
          context.assertion,
          promotion,
        )
      })

    const reconcile = (
      id?: string,
    ): Effect.Effect<InitiativeProjectionReconcileReport, InitiativeError> =>
      Effect.gen(function* () {
        const records =
          id === undefined ? (yield* scan()).initiatives : [yield* get(id)]
        const items: InitiativeProjectionReconcileItem[] = []

        for (const record of records) {
          const report = yield* verificationFor(
            record,
            evidenceRoot,
            now,
            mainRef,
            observedRef,
          )
          for (const promotion of record.promotions) {
            const context = findAssertion(record, promotion.assertionId)
            if (context === undefined) {
              items.push({
                initiativeId: record.id,
                assertionId: promotion.assertionId,
                promotionId: promotion.id,
                result: {
                  ...projectionResult(promotion),
                  status: "skipped",
                  reason: "assertion-missing",
                },
              })
              continue
            }
            const row = findRow(report, promotion.assertionId)
            if (
              row === undefined ||
              row.status !== "supported" ||
              row.promotionStatus !== "current"
            ) {
              items.push({
                initiativeId: record.id,
                assertionId: promotion.assertionId,
                promotionId: promotion.id,
                result: {
                  ...projectionResult(promotion),
                  status: "skipped",
                  reason: "not-current",
                },
              })
              continue
            }
            const result = yield* projectPromotion(
              record,
              context.milestone,
              context.assertion,
              promotion,
              true,
            )
            items.push({
              initiativeId: record.id,
              assertionId: promotion.assertionId,
              promotionId: promotion.id,
              result,
            })
          }
        }

        return { advisory: true, items }
      })

    return {
      root,
      directory,
      evidenceRoot,
      scan,
      list,
      get,
      readScope,
      create,
      appendMilestone,
      appendAssertion,
      verify,
      promote,
      project,
      reconcile,
    }
  })
