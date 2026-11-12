import * as Schema from "effect/Schema";

/** The three kinds of note a Zettelkasten keeps at different stages. */
export const NoteKind = Schema.Literals(["fleeting", "literature", "permanent"]);
export type NoteKind = typeof NoteKind.Type;

/**
 * The most content a note of each kind may carry, in characters.
 *
 * A fleeting note is a quick capture, so it stays short enough to write
 * without stopping to organize. A literature note summarizes one passage from
 * a source and needs room to keep its context. A permanent note holds exactly
 * one idea in the writer's own words; a longer note should be split into
 * separate permanent notes rather than expanded.
 *
 * Current limits: fleeting 1,000, permanent 2,000, literature 5,000.
 */
export const NoteContentLimit = {
  fleeting: 1_000,
  literature: 5_000,
  permanent: 2_000,
} as const satisfies Record<NoteKind, number>;
