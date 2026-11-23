import { Markdown } from "@slipmem/schemas/markdown"
import type { ParsedMarkdownNote } from "../markdown/note-document.js"
import {
  INITIATIVE_PROJECTION_KEY,
  INITIATIVE_PROJECTION_SCHEMA,
  type EvidencePin,
  type InitiativeAssertion,
  type InitiativeMilestone,
  type InitiativeProjectionEvidence,
  type InitiativeProjectionMarker,
  type InitiativeProjectionScope,
  type InitiativePromotion,
  type InitiativeRecord,
  type InitiativeScope,
} from "./types.js"

const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`

const singleLine = (value: string): string => value.replace(/\s+/g, " ").trim()

const projectionScope = (scope: InitiativeScope): InitiativeProjectionScope => ({
  summary: clip(scope.summary, 4000),
  intendedBehavior: clip(scope.intendedBehavior, 4000),
  outOfScope: scope.outOfScope
    .slice(0, 20)
    .map((item) => clip(item, 500)),
  constraints: scope.constraints
    .slice(0, 20)
    .map((item) => clip(item, 500)),
  ...(scope.source === undefined
    ? {}
    : {
        source: {
          path: clip(scope.source.path, 300),
          contentHash: scope.source.contentHash,
        },
      }),
})

const projectionEvidence = (
  pins: ReadonlyArray<EvidencePin>,
): ReadonlyArray<InitiativeProjectionEvidence> =>
  pins.map((pin) => ({
    kind: pin.kind,
    path: clip(pin.path, 300),
    lineStart: pin.lineStart,
    lineEnd: pin.lineEnd,
    contentHash: pin.contentHash,
    excerptHash: pin.excerptHash,
    ...(pin.note === undefined ? {} : { note: clip(pin.note, 500) }),
  }))

/** Human-facing title for the projected permanent note. */
export const initiativeProjectionTitle = (
  record: InitiativeRecord,
  assertion: InitiativeAssertion,
): string =>
  clip(
    `${singleLine(record.title)}: ${singleLine(assertion.claim)}`,
    200,
  ) || `Initiative ${record.id}`

/**
 * Builds the permanent-note body. It is deliberately bounded to the permanent
 * note content limit; the full supporting evidence and scope live in the
 * preserved unknown frontmatter marker.
 */
export const initiativeProjectionBody = (
  record: InitiativeRecord,
  milestone: InitiativeMilestone,
  assertion: InitiativeAssertion,
  promotion: InitiativePromotion,
): string => {
  const details = [
    `Initiative: ${record.title} (${record.id})`,
    `Milestone: ${milestone.title} (${milestone.id})`,
    `Assertion: ${assertion.claim}`,
    ...(assertion.intendedBehavior === undefined
      ? []
      : [`Intended assertion behavior: ${assertion.intendedBehavior}`]),
    `Scope: ${record.scope.summary}`,
    `Intended initiative behavior: ${record.scope.intendedBehavior}`,
    `Verification: advisory supported; promoted at ${promotion.promotedAt}.`,
    ...(promotion.snapshot === null
      ? ["Snapshot: not available (no projection is written without a landed snapshot)."]
      : [
          `Trusted snapshot: ${promotion.snapshot.mainRef} contains ${promotion.snapshot.observedCommit}.`,
        ]),
    "Evidence:",
    ...assertion.supports.map(
      (pin) =>
        `- ${pin.kind}: ${pin.path}:${pin.lineStart}-${pin.lineEnd} (excerpt ${pin.excerptHash.slice(0, 12)})`,
    ),
  ]
  const body = details.join("\n")
  return clip(
    body.replace(/^(?:<{7}|>{7})/gm, "conflict-marker "),
    Markdown.CONTENT_LIMITS.permanent,
  )
}

/**
 * The marker is the deterministic projection identity. Re-scanning for these
 * IDs is what makes a retry return an existing note instead of creating a
 * duplicate, even after a crash between note creation and receipt update.
 */
export const initiativeProjectionMarker = (
  record: InitiativeRecord,
  milestone: InitiativeMilestone,
  assertion: InitiativeAssertion,
  promotion: InitiativePromotion,
): InitiativeProjectionMarker => ({
  schema: INITIATIVE_PROJECTION_SCHEMA,
  initiativeId: record.id,
  initiativeTitle: clip(record.title, 200),
  assertionId: assertion.id,
  claim: clip(assertion.claim, 1000),
  milestoneId: milestone.id,
  milestoneTitle: clip(milestone.title, 200),
  promotionId: promotion.id,
  promotionDigest: promotion.evidenceDigest,
  promotedAt: promotion.promotedAt,
  verifiedAt: promotion.verifiedAt,
  advisory: true,
  scope: projectionScope(record.scope),
  snapshot: promotion.snapshot,
  evidence: projectionEvidence(assertion.supports),
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const markerMatches = (
  marker: Record<string, unknown>,
  identity: {
    readonly initiativeId: string
    readonly assertionId: string
    readonly promotionId: string
  },
): boolean =>
  marker.schema === INITIATIVE_PROJECTION_SCHEMA &&
  marker.initiativeId === identity.initiativeId &&
  marker.assertionId === identity.assertionId &&
  marker.promotionId === identity.promotionId

export interface ProjectionIdentity {
  readonly initiativeId: string
  readonly assertionId: string
  readonly promotionId: string
}

export interface ProjectionNoteMatch {
  readonly note: ParsedMarkdownNote
  readonly marker: InitiativeProjectionMarker
}

/**
 * Finds projection notes by marker identity. The result is sorted by note ID so
 * callers choose the same note across retries if more than one ever exists.
 */
export const findProjectionNotes = (
  notes: ReadonlyArray<ParsedMarkdownNote>,
  identity: ProjectionIdentity,
): ReadonlyArray<ProjectionNoteMatch> =>
  notes
    .filter((note) => note.metadata.type === "permanent")
    .flatMap((note) => {
      const marker = note.unknown[INITIATIVE_PROJECTION_KEY]
      return isRecord(marker) && markerMatches(marker, identity)
        ? [
            {
              note,
              marker: marker as unknown as InitiativeProjectionMarker,
            },
          ]
        : []
    })
    .sort((left, right) =>
      left.note.id < right.note.id ? -1 : left.note.id > right.note.id ? 1 : 0,
    )
