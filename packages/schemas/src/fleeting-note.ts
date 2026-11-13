export * as FleetingNote from "./fleeting-note.js"

import { Schema } from "effect"

export const ID = Schema.String.pipe(
  Schema.brand("FleetingNote.ID"),
  Schema.annotate({ identifier: "FleetingNote.ID" }),
)
export type ID = typeof ID.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  content: Schema.String.check(Schema.isMaxLength(1000)),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}).annotate({ identifier: "FleetingNote.Info" })
