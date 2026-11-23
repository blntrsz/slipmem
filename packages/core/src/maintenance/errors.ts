import { Data } from "effect"

export type MaintenanceErrorCode =
  | "invalid-config"
  | "provider-failed"
  | "output-invalid"
  | "repository-failure"

export interface MaintenanceErrorFields {
  readonly code: MaintenanceErrorCode
  readonly message: string
  readonly path?: string
  readonly field?: string
}

/**
 * A typed permanent-maintenance failure. Provider and output failures happen
 * before any write; per-note repository failures are reported in the run result
 * so a periodic runner can continue and retry later.
 */
export class MaintenanceError extends Data.TaggedError("MaintenanceError")<
  MaintenanceErrorFields
> {}

export const maintenanceError = (
  fields: MaintenanceErrorFields,
): MaintenanceError => new MaintenanceError(fields)
