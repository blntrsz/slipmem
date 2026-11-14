export * as Provenance from "./provenance.js"

import { Schema } from "effect"

/**
 * Where a note came from.
 *
 * Provenance describes the writing surface and, optionally, the actor or
 * external record behind it. It is metadata, not authorization and not a
 * confidence score. `source` is a free-form, lower-case identifier so new
 * transports can be added without changing the persisted schema; the
 * constants below are the values written by the built-in surfaces.
 */
export const Source = Schema.String.check(
  Schema.isMinLength(1, { message: "Provenance source must not be empty." }),
  Schema.isMaxLength(120, {
    message: "Provenance source must be 120 characters or fewer.",
  }),
)

const OptionalText = Schema.String.check(
  Schema.isMaxLength(200, {
    message: "Provenance fields must be 200 characters or fewer.",
  }),
)

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  /** The surface that authored the note, such as `api`, `mcp`, or `import`. */
  source: Source,
  /** The user, agent, or session that authored the note, when known. */
  actor: Schema.optionalKey(OptionalText),
  /** A stable identifier in the source system, when one exists. */
  externalId: Schema.optionalKey(OptionalText),
}).annotate({ identifier: "Provenance.Info" })

export const API: Info = { source: "api" }
export const MCP: Info = { source: "mcp" }
export const IMPORT: Info = { source: "import" }
export const LEGACY: Info = { source: "legacy" }
export const UNKNOWN: Info = { source: "unknown" }

// Provenance is stored as JSON text so optional fields can grow without a
// column per attribute. The schema is the single encoder/decoder pair used by
// the SQLite row mapping and by migration defaults.
export const Json = Schema.fromJsonString(Info)

const encodeJson = Schema.encodeSync(Json)

/**
 * Encodes a provenance value, omitting optional keys that are explicitly
 * `undefined`. Direct service callers can produce `{ source, actor: undefined }`
 * even though JSON and decoded inputs cannot; the database should still store
 * a compact, valid envelope.
 */
export const encode = (provenance: Info): string =>
  encodeJson({
    source: provenance.source,
    ...(provenance.actor === undefined ? {} : { actor: provenance.actor }),
    ...(provenance.externalId === undefined
      ? {}
      : { externalId: provenance.externalId }),
  })

export const decode = Schema.decodeUnknownSync(Json)

export const LEGACY_JSON = encode(LEGACY)
