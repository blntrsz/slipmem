// Initiative records are durable planning bookkeeping, deliberately separate
// from notes. They live in a nested directory under the note root, so the note
// scanner, search index, recall, and approval queue never see them as notes.
import type { InitiativeError, InitiativeErrorCode } from "./errors.js"

export const INITIATIVE_SCHEMA = "slipmem.initiative.v1"
export const INITIATIVE_DIRECTORY = "initiatives"
export const INITIATIVE_FILE_SUFFIX = ".md"
export const INITIATIVE_RECORD_MARKER = "slipmem-initiative-record"

export const INITIATIVE_ID_PATTERN =
  /^initiative-[a-z0-9]+(?:-[a-z0-9]+)*$/
export const MILESTONE_ID_PATTERN =
  /^milestone-[a-z0-9]+(?:-[a-z0-9]+)*$/
export const ASSERTION_ID_PATTERN =
  /^assertion-[a-z0-9]+(?:-[a-z0-9]+)*$/
export const PROMOTION_ID_PATTERN =
  /^promotion-assertion-[a-z0-9]+(?:-[a-z0-9]+)*$/
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

export const MAX_INITIATIVE_BYTES = 1024 * 1024
export const MAX_SCOPE_SOURCE_BYTES = 256 * 1024
export const MAX_SCOPE_EXCERPT_CHARS = 4000
export const MAX_TITLE_CHARS = 200
export const MAX_TEXT_CHARS = 4000
export const MAX_CLAIM_CHARS = 1000
export const MAX_ID_CHARS = 120
export const MAX_MILESTONES = 50
export const MAX_ASSERTIONS_PER_MILESTONE = 100
export const MAX_EVIDENCE_PINS_PER_ASSERTION = 20
export const MAX_EVIDENCE_LINE_SPAN = 2000
export const MAX_EVIDENCE_FILE_BYTES = 2 * 1024 * 1024
export const MAX_EVIDENCE_EXCERPT_CHARS = 2000

export type EvidenceKind = "code" | "test"
export type EvidenceStance = "support" | "contradict"
export type AssertionStatus = "supported" | "contradicted" | "not-evidenced"
export type MilestoneStatus = "planned" | "active" | "landed"

export const INITIATIVE_PROJECTION_SCHEMA = "slipmem.initiative-projection.v1"
export const INITIATIVE_PROJECTION_KEY = "initiativeProjection"

/** One exact source range with both whole-file and excerpt pins. */
export interface EvidencePin {
  readonly kind: EvidenceKind
  /** POSIX-style path relative to the configured evidence/project root. */
  readonly path: string
  /** One-based inclusive line range. */
  readonly lineStart: number
  readonly lineEnd: number
  /** SHA-256 of the whole UTF-8 file at pin time. */
  readonly contentHash: string
  /** SHA-256 of the selected lines joined with `\n`, at pin time. */
  readonly excerptHash: string
  readonly note?: string
}

export interface EvidencePinInput {
  readonly kind: EvidenceKind
  readonly path: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly contentHash: string
  readonly excerptHash: string
  readonly note?: string
}

export interface EvidenceCheck {
  readonly kind: EvidenceKind
  readonly stance: EvidenceStance
  readonly path: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly valid: boolean
  /** Why the pin failed. Present only when `valid` is false. */
  readonly reason?: string
  readonly contentHash: string | null
  readonly excerptHash: string | null
  readonly excerpt: string
}

export interface InitiativeAssertionInput {
  readonly claim: string
  readonly intendedBehavior?: string
  /**
   * Evidence kinds that must each have at least one valid supporting pin.
   * An empty or omitted list only requires at least one valid support pin.
   */
  readonly requiredEvidence?: ReadonlyArray<EvidenceKind>
  readonly supports?: ReadonlyArray<EvidencePinInput>
  readonly contradicts?: ReadonlyArray<EvidencePinInput>
}

export interface InitiativeAssertion {
  readonly id: string
  readonly claim: string
  readonly intendedBehavior?: string
  readonly requiredEvidence: ReadonlyArray<EvidenceKind>
  readonly supports: ReadonlyArray<EvidencePin>
  readonly contradicts: ReadonlyArray<EvidencePin>
}

export interface InitiativeMilestoneInput {
  readonly title: string
  readonly scope?: string
  readonly intendedBehavior: string
  readonly assertions?: ReadonlyArray<InitiativeAssertionInput>
}

export interface InitiativeMilestone {
  readonly id: string
  readonly title: string
  readonly scope?: string
  readonly intendedBehavior: string
  readonly assertions: ReadonlyArray<InitiativeAssertion>
}

export interface InitiativeScopeSource {
  readonly path: string
  readonly contentHash: string
  readonly bytes: number
  readonly lineCount: number
  readonly excerpt: string
}

export interface InitiativeScopeInput {
  readonly summary: string
  readonly intendedBehavior: string
  readonly outOfScope?: ReadonlyArray<string>
  readonly constraints?: ReadonlyArray<string>
  /**
   * Optional Markdown/text file, relative to the evidence root, read at create
   * time. The record stores its hash and a bounded excerpt; it never becomes a
   * note or a search-index entry.
   */
  readonly sourcePath?: string
}

export interface InitiativeScope {
  readonly summary: string
  readonly intendedBehavior: string
  readonly outOfScope: ReadonlyArray<string>
  readonly constraints: ReadonlyArray<string>
  readonly source?: InitiativeScopeSource
}

export interface InitiativeDraftInput {
  readonly title: string
  readonly scope: InitiativeScopeInput
  readonly milestones: ReadonlyArray<InitiativeMilestoneInput>
}

export interface GitSnapshot {
  readonly branch: string | null
  readonly commit: string | null
  readonly detached: boolean
}

/**
 * A resolved, trusted source snapshot. Evidence is checked against
 * `observedCommit`, and promotion additionally requires that commit to be an
 * ancestor of `mainCommit` (reachable from the configured main ref).
 */
export interface InitiativeSnapshot {
  readonly mainRef: string
  readonly mainCommit: string | null
  readonly observedRef: string
  readonly observedCommit: string
  readonly reachableFromMain: boolean
}

export type VerificationMode = "trusted-snapshot" | "working-tree"

/** A promotion is a snapshot, not an assertion that the claim is true forever. */
export interface InitiativePromotion {
  readonly id: string
  readonly initiativeId: string
  readonly assertionId: string
  readonly milestoneId: string
  readonly promotedAt: string
  readonly verifiedAt: string
  readonly evidenceDigest: string
  readonly evidence: ReadonlyArray<EvidencePin>
  readonly git: GitSnapshot | null
  readonly snapshot: InitiativeSnapshot | null
  readonly advisory: true
}

export interface InitiativeRecordData {
  readonly schema: typeof INITIATIVE_SCHEMA
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly revision: number
  readonly scope: InitiativeScope
  readonly milestones: ReadonlyArray<InitiativeMilestone>
  readonly promotions: ReadonlyArray<InitiativePromotion>
}

export interface InitiativeRecord extends InitiativeRecordData {
  readonly path: string
  readonly contentHash: string
}

export interface InitiativeSummary {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly revision: number
  readonly milestoneCount: number
  readonly assertionCount: number
  readonly promotionCount: number
}

export interface InitiativeScopeView {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly revision: number
  readonly scope: InitiativeScope
}

export interface InitiativeScan {
  readonly initiatives: ReadonlyArray<InitiativeRecord>
  readonly invalid: ReadonlyArray<InitiativeError>
}

export interface MilestoneProgress {
  readonly milestoneId: string
  readonly title: string
  readonly status: MilestoneStatus
  readonly assertionCount: number
  readonly supportedCount: number
  readonly contradictedCount: number
  readonly notEvidencedCount: number
  readonly promotedCount: number
}

export interface AssertionVerification {
  readonly initiativeId: string
  readonly milestoneId: string
  readonly milestoneTitle: string
  readonly assertionId: string
  readonly claim: string
  readonly intendedBehavior?: string
  readonly status: AssertionStatus
  readonly requiredEvidence: ReadonlyArray<EvidenceKind>
  readonly missingRequiredKinds: ReadonlyArray<EvidenceKind>
  readonly evidence: ReadonlyArray<EvidenceCheck>
  readonly promoted: boolean
  readonly promotionId?: string
  readonly promotionStatus?: "current" | "stale" | "missing"
}

export interface InitiativeVerificationReport {
  readonly advisory: true
  readonly automaticPrVerification: false
  readonly automaticPromotion: false
  readonly operatorActionRequired: true
  readonly verificationMode: VerificationMode
  readonly initiativeId: string
  readonly title: string
  readonly path: string
  readonly verifiedAt: string
  readonly revision: number
  readonly scope: InitiativeScope
  readonly git: GitSnapshot | null
  readonly snapshot: InitiativeSnapshot | null
  readonly milestones: ReadonlyArray<MilestoneProgress>
  readonly supported: ReadonlyArray<AssertionVerification>
  readonly contradicted: ReadonlyArray<AssertionVerification>
  readonly notEvidenced: ReadonlyArray<AssertionVerification>
  readonly promotions: ReadonlyArray<InitiativePromotion>
}

export interface PromoteAssertionResult {
  readonly created: boolean
  readonly promotion: InitiativePromotion
  readonly record: InitiativeRecord
  /**
   * Projection into the flat permanent-note store. The promotion itself is
   * committed before projection, so `pending` and `failed` describe a
   * committed promotion whose note projection did not complete; `error`
   * carries the actionable cause. `skipped` with `reason: "unversioned"` means
   * no main note was written because the promotion has no trusted,
   * main-reachable snapshot.
   */
  readonly projection: InitiativeProjectionResult
}

export type InitiativeProjectionStatus =
  | "created"
  | "existing"
  | "skipped"
  /**
   * A promotion is committed but another live process owns a fresh pending
   * receipt. Retry the projection (or reconcile) once it finishes.
   */
  | "pending"
  /** A promotion is committed but the projection attempt failed. */
  | "failed"

export interface InitiativeProjectionEvidence {
  readonly kind: EvidenceKind
  readonly path: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly contentHash: string
  readonly excerptHash: string
  readonly note?: string
}

export interface InitiativeProjectionScope {
  readonly summary: string
  readonly intendedBehavior: string
  readonly outOfScope: ReadonlyArray<string>
  readonly constraints: ReadonlyArray<string>
  readonly source?: {
    readonly path: string
    readonly contentHash: string
  }
}

/** Unknown frontmatter on the projected permanent note. */
export interface InitiativeProjectionMarker {
  readonly schema: typeof INITIATIVE_PROJECTION_SCHEMA
  readonly initiativeId: string
  readonly initiativeTitle: string
  readonly assertionId: string
  readonly claim: string
  readonly milestoneId: string
  readonly milestoneTitle: string
  readonly promotionId: string
  readonly promotionDigest: string
  readonly promotedAt: string
  readonly verifiedAt: string
  readonly advisory: true
  readonly scope: InitiativeProjectionScope
  readonly snapshot: InitiativeSnapshot | null
  readonly evidence: ReadonlyArray<InitiativeProjectionEvidence>
}

export interface InitiativeProjectionFailure {
  readonly code: InitiativeErrorCode
  readonly message: string
}

export interface InitiativeProjectionResult {
  readonly status: InitiativeProjectionStatus
  readonly advisory: true
  readonly promotionId: string
  readonly initiativeId: string
  readonly assertionId: string
  readonly reason?: string
  readonly stale?: boolean
  readonly noteId?: string
  readonly notePath?: string
  readonly noteContentHash?: string
  readonly receipt?: InitiativeProjectionReceipt
  /**
   * Present when the promotion was committed but its projection did not
   * complete. `status` is `pending` for a live pending receipt owned by another
   * process, and `failed` for any other projection error.
   */
  readonly error?: InitiativeProjectionFailure
}

export type InitiativeProjectionReceiptStatus = "pending" | "projected"

/** Local atomic receipt under `.state/initiative-projections/`. */
export interface InitiativeProjectionReceipt {
  readonly schema: "slipmem.initiative-projection-receipt.v1"
  readonly promotionId: string
  readonly initiativeId: string
  readonly assertionId: string
  readonly evidenceDigest: string
  readonly status: InitiativeProjectionReceiptStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly pid: number
  readonly noteId?: string
  readonly notePath?: string
  readonly noteContentHash?: string
}

export interface InitiativeProjectionReconcileItem {
  readonly initiativeId: string
  readonly assertionId: string
  readonly promotionId: string
  readonly result: InitiativeProjectionResult
}

export interface InitiativeProjectionReconcileReport {
  readonly advisory: true
  readonly items: ReadonlyArray<InitiativeProjectionReconcileItem>
}
