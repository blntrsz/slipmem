import { Markdown } from "@slipmem/schemas/markdown"
import { createHash } from "node:crypto"
import type { ParsedMarkdownNote } from "../markdown/note-document.js"

/**
 * Maintenance state lives in ordinary unknown frontmatter, so every run can
 * restart from the durable note files. There is no sidecar journal and no dual
 * write: the generated permanent is the only record of which source revisions
 * it has consumed.
 */
export const MAINTENANCE_METADATA_KEY = "maintenance"
export const MAINTENANCE_METADATA_VERSION = 2
/** Version 1 markers predate typed relations and stay readable. */
export const MAINTENANCE_METADATA_VERSION_V1 = 1
export const MAINTENANCE_PROVENANCE_SOURCE = "maintenance"
export const MAINTENANCE_ACTOR = "slipmem-maintenance"

/** A bounded number of source references per generated permanent. */
export const MAX_TRACKED_SOURCES = 200

/**
 * Relations the maintenance worker may generate from a validated provider
 * plan. `derived_from` is not stored here: it is projected automatically from
 * `sources`, which already carry the version hash of the evidence.
 */
export const MAINTENANCE_PLANNED_RELATION_KINDS = [
  "supersedes",
  "contradicts",
] as const
/**
 * Read-only relation kind used by neighbouring tooling such as an initiative
 * index. The worker never generates it, but it is parsed and preserved so a
 * note written by another owner is not silently damaged.
 */
export const MAINTENANCE_FOREIGN_RELATION_KINDS = ["implements"] as const
export const MAINTENANCE_RELATION_KINDS = [
  ...MAINTENANCE_PLANNED_RELATION_KINDS,
  ...MAINTENANCE_FOREIGN_RELATION_KINDS,
] as const

/** A small, bounded set of typed relations per generated permanent. */
export const MAX_MAINTENANCE_RELATIONS = 32
export const MAX_RELATION_EVIDENCE = 32

export type MaintenancePlannedRelationKind =
  (typeof MAINTENANCE_PLANNED_RELATION_KINDS)[number]
export type MaintenanceForeignRelationKind =
  (typeof MAINTENANCE_FOREIGN_RELATION_KINDS)[number]
export type MaintenanceRelationKind =
  (typeof MAINTENANCE_RELATION_KINDS)[number]

const SHA256_PATTERN = /^[0-9a-f]{64}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && SHA256_PATTERN.test(value)

export interface MaintenanceSourceRef {
  readonly id: string
  /** SHA-256 of the whole source note file at the time it was consolidated. */
  readonly contentHash: string
}

/**
 * A typed, evidence-backed edge stored on the derived note. The target is
 * pinned to the whole-file hash seen when the plan was validated, so a later
 * edit is visible as `stale` instead of silently reinterpreting the relation.
 */
export interface MaintenanceRelation {
  readonly kind: MaintenanceRelationKind
  readonly target: string
  /** SHA-256 of the target note file when the relation was validated. */
  readonly targetHash: string
  /** Current source revisions that justify the relation. */
  readonly evidence: ReadonlyArray<MaintenanceSourceRef>
}

export interface PermanentMaintenanceMetadata {
  readonly version:
    | typeof MAINTENANCE_METADATA_VERSION
    | typeof MAINTENANCE_METADATA_VERSION_V1
  /** Contract timestamp for the last successful maintenance write. */
  readonly generatedAt: string
  /** Hash of the managed title, body, tags, source set, and relations. */
  readonly stateHash: string
  readonly sources: ReadonlyArray<MaintenanceSourceRef>
  /** Empty for version 1 markers; never inferred from Markdown links. */
  readonly relations: ReadonlyArray<MaintenanceRelation>
}

export interface ManagedStateInput {
  readonly title: string
  readonly content: string
  readonly tags: ReadonlyArray<string>
  readonly sources: ReadonlyArray<MaintenanceSourceRef>
  readonly relations?: ReadonlyArray<MaintenanceRelation>
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

/** Stable source order keeps the state hash independent of YAML list order. */
export const canonicalSourceRefs = (
  sources: ReadonlyArray<MaintenanceSourceRef>,
): ReadonlyArray<MaintenanceSourceRef> =>
  [...sources].sort((left, right) => compareText(left.id, right.id))

export const canonicalRelations = (
  relations: ReadonlyArray<MaintenanceRelation>,
): ReadonlyArray<MaintenanceRelation> =>
  relations
    .map((relation) => ({
      ...relation,
      evidence: canonicalSourceRefs(relation.evidence),
    }))
    .sort(
      (left, right) =>
        compareText(left.kind, right.kind) ||
        compareText(left.target, right.target),
    )

/**
 * Hashes only fields the maintenance worker owns. Whole-file hashes cannot be
 * stored inside the file that they hash, so this canonical state hash is what
 * distinguishes the last generated version from a later human edit.
 *
 * Version 1 markers had no relations. Omitting the key when the list is empty
 * keeps their hash byte-for-byte compatible, so an existing generated note
 * remains model-owned until it is next written as version 2.
 */
export const managedStateHash = (input: ManagedStateInput): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        title: input.title.trim(),
        content: input.content.trim(),
        tags: input.tags,
        sources: canonicalSourceRefs(input.sources),
        ...((input.relations ?? []).length === 0
          ? {}
          : { relations: canonicalRelations(input.relations ?? []) }),
      }),
      "utf8",
    )
    .digest("hex")

const parseSourceRefs = (
  value: unknown,
  bounds: { readonly minimum: number; readonly maximum: number },
): ReadonlyArray<MaintenanceSourceRef> | null => {
  if (
    !Array.isArray(value) ||
    value.length < bounds.minimum ||
    value.length > bounds.maximum
  ) {
    return null
  }

  const refs: MaintenanceSourceRef[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !Markdown.isNoteId(item.id) ||
      !isSha256(item.contentHash) ||
      seen.has(item.id)
    ) {
      return null
    }
    seen.add(item.id)
    refs.push({ id: item.id, contentHash: item.contentHash })
  }

  return canonicalSourceRefs(refs)
}

const isRelationKind = (value: unknown): value is MaintenanceRelationKind =>
  typeof value === "string" &&
  (MAINTENANCE_RELATION_KINDS as ReadonlyArray<string>).includes(value)

/**
 * Parses the durable relation list. A malformed list makes the whole marker
 * untrusted, matching how a malformed source list is handled: the worker then
 * treats the note as not model-owned instead of guessing at a repair.
 */
const parseRelations = (
  value: unknown,
): ReadonlyArray<MaintenanceRelation> | null => {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value) || value.length > MAX_MAINTENANCE_RELATIONS) {
    return null
  }

  const relations: MaintenanceRelation[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isRecord(item) || !isRelationKind(item.kind)) {
      return null
    }
    if (
      typeof item.target !== "string" ||
      !Markdown.isNoteId(item.target) ||
      !isSha256(item.targetHash)
    ) {
      return null
    }
    const key = `${item.kind}\u0000${item.target}`
    if (seen.has(key)) {
      return null
    }

    const evidence =
      item.evidence === undefined && item.kind === "implements"
        ? []
        : parseSourceRefs(item.evidence, {
            minimum: item.kind === "implements" ? 0 : 1,
            maximum: MAX_RELATION_EVIDENCE,
          })
    if (evidence === null) {
      return null
    }

    seen.add(key)
    relations.push({
      kind: item.kind,
      target: item.target,
      targetHash: item.targetHash,
      evidence,
    })
  }

  return canonicalRelations(relations)
}

/**
 * Reads the maintenance marker without trusting it to mean the note is still
 * model-owned. A malformed marker is treated as absent; the worker never
 * repairs or overwrites a note whose marker it cannot understand.
 */
export const readMaintenanceMetadata = (input: {
  readonly unknown: Readonly<Record<string, unknown>>
}): PermanentMaintenanceMetadata | null => {
  const raw = input.unknown[MAINTENANCE_METADATA_KEY]
  if (
    !isRecord(raw) ||
    (raw.version !== MAINTENANCE_METADATA_VERSION &&
      raw.version !== MAINTENANCE_METADATA_VERSION_V1) ||
    typeof raw.generatedAt !== "string" ||
    !Markdown.isUtcTimestamp(raw.generatedAt) ||
    !isSha256(raw.stateHash)
  ) {
    return null
  }

  const sources = parseSourceRefs(raw.sources, {
    minimum: 1,
    maximum: MAX_TRACKED_SOURCES,
  })
  if (sources === null) {
    return null
  }

  // Version 1 had no relation key. Ignore one if a hand-edited file added it:
  // it was not covered by that version's state hash, so trusting it as current
  // would widen what an old marker means.
  const relations =
    raw.version === MAINTENANCE_METADATA_VERSION_V1
      ? []
      : parseRelations(raw.relations)
  if (relations === null) {
    return null
  }

  return {
    version: raw.version,
    generatedAt: raw.generatedAt,
    stateHash: raw.stateHash,
    sources,
    relations,
  }
}

export const managedStateForNote = (
  note: Pick<ParsedMarkdownNote, "metadata" | "body">,
  metadata: PermanentMaintenanceMetadata,
): ManagedStateInput => ({
  title: note.metadata.title,
  content: note.body,
  tags: note.metadata.tags ?? [],
  sources: metadata.sources,
  relations: metadata.relations,
})

/**
 * Returns the marker only when the note is still model-owned: the marker is
 * valid and its managed fields match the hash recorded at generation time. A
 * manual title, body, tag, or source edit makes the note ineligible for
 * automatic updates while its source revisions stay recorded for deduplication.
 */
export const managedPermanentMetadata = (
  note: Pick<ParsedMarkdownNote, "metadata" | "body" | "unknown">,
): PermanentMaintenanceMetadata | null => {
  const metadata = readMaintenanceMetadata(note)
  if (metadata === null) {
    return null
  }
  return metadata.stateHash ===
    managedStateHash(managedStateForNote(note, metadata))
    ? metadata
    : null
}

export const maintenanceMetadata = (
  input: ManagedStateInput & { readonly generatedAt: string },
): PermanentMaintenanceMetadata => ({
  version: MAINTENANCE_METADATA_VERSION,
  generatedAt: input.generatedAt,
  stateHash: managedStateHash(input),
  sources: canonicalSourceRefs(input.sources),
  relations: canonicalRelations(input.relations ?? []),
})

/** Preserves every other unknown frontmatter key while replacing the marker. */
export const maintenanceUnknown = (
  current: Readonly<Record<string, unknown>>,
  metadata: PermanentMaintenanceMetadata,
): Readonly<Record<string, unknown>> => ({
  ...current,
  [MAINTENANCE_METADATA_KEY]: metadata,
})
