import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { NoteKind } from "./note.kind.ts";

/** The field of a note that failed validation. */
export const NoteField = Schema.Literals(["content", "title", "source"]);
export type NoteField = typeof NoteField.Type;

/** A note aggregate holds one note; it can only be created once. */
export class NoteAlreadyExists extends Domain.Rejection("NoteAlreadyExists") {}

/** A required note field was blank. */
export class EmptyNote extends Domain.Rejection("EmptyNote", {
  field: NoteField,
}) {}

/** The note's content is longer than its kind allows. */
export class NoteTooLong extends Domain.Rejection("NoteTooLong", {
  kind: NoteKind,
  field: NoteField,
  maxLength: Schema.Int,
  actualLength: Schema.Int,
}) {}
