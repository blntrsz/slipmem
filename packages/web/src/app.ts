import type * as Domain from "@alchemy.run/domain";
import * as DomainFoldkit from "@alchemy.run/domain/Foldkit";
import { NoteApi } from "@slipmem/domain/note/note.api";
import { noteListKey } from "@slipmem/domain/note/note-list.view";
import { NoteId } from "@slipmem/domain/note/note.id";
import { NoteContentLimit, NoteKind } from "@slipmem/domain/note/note.kind";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Subscription, type Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

type MemoryClient = Domain.Api.ClientKey<"NoteApi">;
type Kind = typeof NoteKind.Type;

/** Typed Commands and live read subscriptions derived from the Api. */
export const SlipMemClient = DomainFoldkit.make(NoteApi);

const isNoteKind = (value: string): value is Kind =>
  value === "fleeting" || value === "literature" || value === "permanent";

// MODEL

const Note = Schema.Struct({
  id: Schema.String,
  kind: NoteKind,
  title: Schema.NullOr(Schema.String),
  source: Schema.NullOr(Schema.String),
  content: Schema.String,
});
type Note = typeof Note.Type;

export const Model = Schema.Struct({
  commandIds: DomainFoldkit.CommandIds,
  kind: NoteKind,
  title: Schema.String,
  source: Schema.String,
  content: Schema.String,
  status: Schema.String,
  notes: Schema.Array(Note),
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ChangedKind: { value: NoteKind },
  ChangedTitle: { value: Schema.String },
  ChangedSource: { value: Schema.String },
  ChangedContent: { value: Schema.String },
  ClickedSave: {},
  ReceivedResult: { result: SlipMemClient.Message },
  ReceivedNotes: { notes: Schema.Array(Note) },
  FailedNotes: { reason: Schema.String },
});
export type Message = typeof Message.Type;

// COMMAND

/** Seed the list from the server on load; the subscription then keeps it live. */
const LoadNotes = Command.define("LoadNotes", {
  messages: [Message.ReceivedNotes, Message.FailedNotes],
  execute: Effect.gen(function* () {
    const client = yield* NoteApi.Client;
    // The first read can land before the cluster wakes the view's entity, so
    // retry briefly rather than treating null as "no notes".
    const state = yield* Effect.gen(function* () {
      for (let attempt = 0; attempt < 8; attempt++) {
        const state = yield* client.NoteList.get(noteListKey);
        if (state !== null) return state;
        yield* Effect.sleep("250 millis");
      }
      return null;
    });
    return Message.ReceivedNotes({ notes: state?.notes ?? [] });
  }).pipe(
    Effect.catch((error) => Effect.succeed(Message.FailedNotes({ reason: error._tag }))),
  ),
});

type CommandResult = (typeof SlipMemClient.Message)["Type"];

const saveCommand = (model: Model, commandId: string) => {
  const target = NoteId.make(crypto.randomUUID());
  const toMessage = (result: CommandResult) => Message.ReceivedResult({ result });
  const command =
    model.kind === "fleeting"
      ? Command.mapMessage(
          SlipMemClient.CaptureFleetingNote({
            target,
            input: { content: model.content },
            commandId,
          }),
          toMessage,
        )
      : model.kind === "literature"
        ? Command.mapMessage(
            SlipMemClient.RecordLiteratureNote({
              target,
              input: { source: model.source, content: model.content },
              commandId,
            }),
            toMessage,
          )
        : Command.mapMessage(
            SlipMemClient.WritePermanentNote({
              target,
              input: { title: model.title, content: model.content },
              commandId,
            }),
            toMessage,
          );
  return command;
};

const failureText = (
  action: string,
  failure: { readonly _tag: string; readonly rejection?: { readonly _tag: string } },
): string =>
  failure._tag === "Rejected" && failure.rejection !== undefined
    ? `${action} failed: ${failure.rejection._tag}`
    : `${action} failed: ${failure._tag}`;

const saved = (model: Model, label: string) => ({
  model: modifyFields(model, {
    title: () => "",
    source: () => "",
    content: () => "",
    status: () => `${label} saved.`,
  }),
});

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message, MemoryClient>>(message, {
    ChangedKind: ({ value }) => ({
      model: modifyFields(model, { kind: () => value }),
    }),
    ChangedTitle: ({ value }) => ({
      model: modifyFields(model, { title: () => value }),
    }),
    ChangedSource: ({ value }) => ({
      model: modifyFields(model, { source: () => value }),
    }),
    ChangedContent: ({ value }) => ({
      model: modifyFields(model, { content: () => value }),
    }),
    ClickedSave: () => {
      const { commandId, commandIds } = DomainFoldkit.next(model.commandIds);
      return {
        model: modifyFields(model, {
          commandIds: () => commandIds,
          status: () => "Saving...",
        }),
        commands: [
          saveCommand(model, commandId),
        ],
      };
    },
    ReceivedResult: ({ result }) =>
      Match.value(result).pipe(
        Match.withReturnType<Update.Return<Model, Message, MemoryClient>>(),
        Match.tag("SucceededCaptureFleetingNote", () => saved(model, "Fleeting note")),
        Match.tag("SucceededRecordLiteratureNote", () => saved(model, "Literature note")),
        Match.tag("SucceededWritePermanentNote", () => saved(model, "Permanent note")),
        Match.tag("FailedCaptureFleetingNote", ({ failure }) => ({
          model: modifyFields(model, {
            status: () => failureText("Fleeting note", failure),
          }),
        })),
        Match.tag("FailedRecordLiteratureNote", ({ failure }) => ({
          model: modifyFields(model, {
            status: () => failureText("Literature note", failure),
          }),
        })),
        Match.tag("FailedWritePermanentNote", ({ failure }) => ({
          model: modifyFields(model, {
            status: () => failureText("Permanent note", failure),
          }),
        })),
        Match.orElse(() => ({ model })),
      ),
    ReceivedNotes: ({ notes }) => ({
      model: modifyFields(model, {
        notes: () => notes,
        status: () => (model.status === "Loading notes..." ? "Ready." : model.status),
      }),
    }),
    FailedNotes: ({ reason }) => ({
      model: modifyFields(model, { status: () => `Live read failed: ${reason}` }),
    }),
  });

// INIT

export const init = (): Update.Return<Model, Message, MemoryClient> => ({
  model: Model.make({
    commandIds: { session: crypto.randomUUID(), sent: 0 },
    kind: "fleeting",
    title: "",
    source: "",
    content: "",
    status: "Loading notes...",
    notes: [],
  }),
  commands: [LoadNotes()],
});

// SUBSCRIPTION

export const subscriptions = Subscription.make<Model, Message, MemoryClient>()((entry) => ({
  notes: SlipMemClient.NoteList.watch({
    key: () => noteListKey,
    toMessage: ({ state }): Message =>
      Message.ReceivedNotes({
        notes: Option.match(state, {
          onNone: () => [],
          onSome: (list) => list.notes,
        }),
      }),
    onFailure: (error) => Message.FailedNotes({ reason: String(error._tag) }),
    onDefect: () => Message.FailedNotes({ reason: "Unexpected read defect" }),
  }),
}));

// VIEW

const kindLabel: Record<Kind, string> = {
  fleeting: "Fleeting",
  literature: "Literature",
  permanent: "Permanent",
};

const kindHelp: Record<Kind, string> = {
  fleeting: "A quick thought, captured before it is lost.",
  literature: "A passage from a source, in your own words.",
  permanent: "One durable idea, stated in your own words.",
};

const contentPlaceholder: Record<Kind, string> = {
  fleeting: "What do you want to remember?",
  literature: "What does the source say?",
  permanent: "State the one idea in full sentences.",
};

const footnoteStyle = {
  color: "#555",
  fontSize: "0.875rem",
  marginBottom: "1rem",
} as const;
const field = { display: "grid", gap: "0.25rem", marginBottom: "1rem" } as const;
const inputStyle = {
  border: "1px solid #aaa",
  borderRadius: "0.375rem",
  padding: "0.5rem",
  width: "100%",
  boxSizing: "border-box",
} as const;
const listStyle = {
  display: "grid",
  gap: "0.75rem",
  listStyle: "none",
  margin: "0",
  padding: "0",
} as const;
const cardStyle = {
  border: "1px solid #ddd",
  borderRadius: "0.5rem",
  padding: "1rem",
} as const;

const canSave = (model: Model): boolean => {
  const content = model.content.trim();
  return (
    content !== "" &&
    content.length <= NoteContentLimit[model.kind] &&
    (model.kind !== "literature" || model.source.trim() !== "") &&
    (model.kind !== "permanent" || model.title.trim() !== "")
  );
};

const noteHeading = (note: Note): string =>
  note.kind === "permanent"
    ? (note.title ?? "Permanent note")
    : note.kind === "literature"
      ? (note.source ?? "Literature note")
      : "Fleeting note";

const noteCard = (note: Note, h: HtmlBuilder<Message>) =>
  h.li(
    [h.Style(cardStyle)],
    [
      h.div(
        [h.Style({ display: "flex", justifyContent: "space-between", gap: "1rem" })],
        [
          h.strong([], [noteHeading(note)]),
          h.span([h.Style({ color: "#666", fontSize: "0.75rem" })], [kindLabel[note.kind]]),
        ],
      ),
      h.p([h.Style({ whiteSpace: "pre-wrap", margin: "0.5rem 0" })], [note.content]),
      h.code([h.Style({ color: "#888", fontSize: "0.75rem" })], [note.id]),
    ],
  );

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const limit = NoteContentLimit[model.kind];
  const contentLength = model.content.trim().length;

  return {
    title: "slipmem",
    body: h.main(
      [
        h.Style({
          fontFamily: "system-ui, sans-serif",
          margin: "0 auto",
          maxWidth: "42rem",
          padding: "2rem",
        }),
      ],
      [
        h.h1([], ["slipmem"]),
        h.p([], ["A minimal slip box for fleeting, literature, and permanent notes."]),
        h.div(
          [h.Style(field)],
          [
            h.label([], ["Kind"]),
            h.select(
              [
                h.Value(model.kind),
                h.OnChange((value) =>
                  Message.ChangedKind({ value: isNoteKind(value) ? value : "fleeting" }),
                ),
                h.Style(inputStyle),
              ],
              [
                h.option([h.Value("fleeting"), h.Selected(model.kind === "fleeting")], [
                  "Fleeting",
                ]),
                h.option([h.Value("literature"), h.Selected(model.kind === "literature")], [
                  "Literature",
                ]),
                h.option([h.Value("permanent"), h.Selected(model.kind === "permanent")], [
                  "Permanent",
                ]),
              ],
            ),
            h.small([h.Style({ color: "#555" })], [kindHelp[model.kind]]),
          ],
        ),
        model.kind === "permanent"
          ? h.div(
              [h.Style(field)],
              [
                h.label([], ["Title"]),
                h.input([
                  h.Value(model.title),
                  h.OnInput((value) => Message.ChangedTitle({ value })),
                  h.Placeholder("Name the one idea."),
                  h.Style(inputStyle),
                ]),
              ],
            )
          : null,
        model.kind === "literature"
          ? h.div(
              [h.Style(field)],
              [
                h.label([], ["Source"]),
                h.input([
                  h.Value(model.source),
                  h.OnInput((value) => Message.ChangedSource({ value })),
                  h.Placeholder("Book, article, or conversation."),
                  h.Style(inputStyle),
                ]),
              ],
            )
          : null,
        h.div(
          [h.Style(field)],
          [
            h.label([], ["Content"]),
            h.textarea([
              h.Value(model.content),
              h.OnInput((value) => Message.ChangedContent({ value })),
              h.Placeholder(contentPlaceholder[model.kind]),
              h.Style({ ...inputStyle, minHeight: "6rem" }),
            ]),
            h.small(
              [h.Style({ color: contentLength > limit ? "#b00020" : "#555" })],
              [`${contentLength} / ${limit} characters`],
            ),
          ],
        ),
        h.div(
          [h.Style({ display: "flex", gap: "0.5rem", marginBottom: "1rem" })],
          [
            h.button(
              [h.Disabled(!canSave(model)), h.OnClick(Message.ClickedSave())],
              ["Save note"],
            ),
          ],
        ),
        h.p([h.Style({ color: "#555" })], [model.status]),
        h.section(
          [],
          [
            h.h2([], [`Notes (${model.notes.length})`]),
            model.notes.length === 0
              ? h.p([h.Style({ color: "#555" })], ["No notes yet."])
              : h.ul([h.Style(listStyle)], [...model.notes].reverse().map((note) => noteCard(note, h))),
          ],
        ),
        h.p([h.Style(footnoteStyle)], [
          "Run `bun run dev` for the stack and `bun run --filter @slipmem/web dev` for the UI.",
        ]),
      ].filter((child) => child !== null),
    ),
  };
};
