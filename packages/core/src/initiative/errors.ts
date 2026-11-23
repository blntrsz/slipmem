import { Data } from "effect"

/**
 * Initiative state is durable project bookkeeping, but it is still local data
 * that an agent or person can edit. One typed failure keeps every CLI/report
 * surface actionable without leaking a nested parser union.
 */
export type InitiativeErrorCode =
  | "invalid-initiative"
  | "invalid-draft"
  | "invalid-id"
  | "initiative-not-found"
  | "initiative-exists"
  | "initiative-file-too-large"
  | "evidence-outside-root"
  | "evidence-unreadable"
  | "evidence-invalid"
  | "scope-read-failed"
  | "unsupported-promotion"
  | "already-promoted"
  | "main-required"
  | "projection-requires-landed-main"
  | "projection-not-promoted"
  | "projection-in-progress"
  | "projection-failed"
  | "read-failed"
  | "write-failed"

export interface InitiativeErrorFields {
  readonly code: InitiativeErrorCode
  readonly message: string
  readonly path?: string
  readonly field?: string
  readonly initiativeId?: string
  readonly milestoneId?: string
  readonly assertionId?: string
}

export class InitiativeError extends Data.TaggedError("InitiativeError")<InitiativeErrorFields> {}

export const initiativeError = (
  fields: InitiativeErrorFields,
): InitiativeError => new InitiativeError(fields)
