import type * as Domain from "@alchemy.run/domain";
import * as DomainFoldkit from "@alchemy.run/domain/Foldkit";
import { MemoryApi } from "@slipmem/domain/memory-api.api";
import { SlipId } from "@slipmem/domain/slip/slip.id";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Subscription, type Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

type MemoryClient = Domain.Api.ClientKey<"MemoryApi">;

/** Typed Commands and live read subscriptions derived from the Api. */
export const SlipMemClient = DomainFoldkit.make(MemoryApi);

/** One demo slip is enough to exercise the whole stack. */
const slipId = SlipId.make("demo");

// MODEL

const Summary = Schema.Struct({
  prompt: Schema.NullOr(Schema.String),
  answer: Schema.NullOr(Schema.String),
  reviews: Schema.Int,
});
type Summary = typeof Summary.Type;

export const Model = Schema.Struct({
  commandIds: DomainFoldkit.CommandIds,
  prompt: Schema.String,
  answer: Schema.String,
  status: Schema.String,
  summary: Schema.Option(Schema.NullOr(Summary)),
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ChangedPrompt: { value: Schema.String },
  ChangedAnswer: { value: Schema.String },
  ClickedCapture: {},
  ClickedReview: {},
  ReceivedResult: { result: SlipMemClient.Message },
  ReceivedSummary: {
    summary: Schema.Option(Schema.NullOr(Summary)),
    cursor: Schema.Number,
  },
  FailedSummary: { reason: Schema.String },
});
export type Message = typeof Message.Type;

// COMMAND

/** Seed the view from the server on load; the subscription then keeps it live. */
const LoadSummary = Command.define("LoadSummary", {
  messages: [Message.ReceivedSummary, Message.FailedSummary],
  execute: Effect.gen(function* () {
    const client = yield* MemoryApi.Client;
    // The first read can land before the cluster wakes the view's entity, so
    // retry briefly rather than treating null as "no slip".
    const state = yield* Effect.gen(function* () {
      for (let attempt = 0; attempt < 8; attempt++) {
        const state = yield* client.SlipSummary.get(slipId);
        if (state !== null) return state;
        yield* Effect.sleep("250 millis");
      }
      return null;
    });
    return Message.ReceivedSummary({ summary: Option.fromNullishOr(state), cursor: 0 });
  }).pipe(
    Effect.catch((error) => Effect.succeed(Message.FailedSummary({ reason: error._tag }))),
  ),
});

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message, MemoryClient>>(message, {
    ChangedPrompt: ({ value }) => ({
      model: modifyFields(model, { prompt: () => value }),
    }),
    ChangedAnswer: ({ value }) => ({
      model: modifyFields(model, { answer: () => value }),
    }),
    ClickedCapture: () => {
      const { commandId, commandIds } = DomainFoldkit.next(model.commandIds);
      return {
        model: modifyFields(model, {
          commandIds: () => commandIds,
          status: () => "Capturing...",
        }),
        commands: [
          Command.mapMessage(
            SlipMemClient.CaptureSlip({
              target: slipId,
              input: { prompt: model.prompt, answer: model.answer },
              commandId,
            }),
            (result) => Message.ReceivedResult({ result }),
          ),
        ],
      };
    },
    ClickedReview: () => {
      const { commandId, commandIds } = DomainFoldkit.next(model.commandIds);
      return {
        model: modifyFields(model, {
          commandIds: () => commandIds,
          status: () => "Recording review...",
        }),
        commands: [
          Command.mapMessage(
            SlipMemClient.ReviewSlip({
              target: slipId,
              input: {},
              commandId,
            }),
            (result) => Message.ReceivedResult({ result }),
          ),
        ],
      };
    },
    ReceivedResult: ({ result }) =>
      Match.value(result).pipe(
        Match.withReturnType<Update.Return<Model, Message, MemoryClient>>(),
        Match.tag("SucceededCaptureSlip", () => ({
          model: modifyFields(model, {
            prompt: () => "",
            answer: () => "",
            status: () => "Captured.",
          }),
        })),
        Match.tag("SucceededReviewSlip", ({ reply }) => ({
          model: modifyFields(model, {
            status: () => `Reviewed ${reply.reviews} time(s).`,
          }),
        })),
        Match.tag("FailedCaptureSlip", ({ failure }) => ({
          model: modifyFields(model, { status: () => `Capture failed: ${failure._tag}` }),
        })),
        Match.tag("FailedReviewSlip", ({ failure }) => ({
          model: modifyFields(model, { status: () => `Review failed: ${failure._tag}` }),
        })),
        Match.orElse(() => ({ model })),
      ),
    ReceivedSummary: ({ summary }) => ({
      model: modifyFields(model, {
        summary: () => summary,
        status: () => (Option.isSome(summary) ? "Synced." : model.status),
      }),
    }),
    FailedSummary: ({ reason }) => ({
      model: modifyFields(model, { status: () => `Live read failed: ${reason}` }),
    }),
  });

// INIT

export const init = (): Update.Return<Model, Message, MemoryClient> => ({
  model: Model.make({
    commandIds: { session: crypto.randomUUID(), sent: 0 },
    prompt: "",
    answer: "",
    status: "Ready.",
    summary: Option.none(),
  }),
  commands: [LoadSummary()],
});

// SUBSCRIPTION

export const subscriptions = Subscription.make<Model, Message, MemoryClient>()((entry) => ({
  summary: SlipMemClient.SlipSummary.watch({
    key: () => slipId,
    toMessage: ({ state, cursor }): Message =>
      Message.ReceivedSummary({ summary: state, cursor }),
    onFailure: (error) => Message.FailedSummary({ reason: String(error._tag) }),
    onDefect: () => Message.FailedSummary({ reason: "Unexpected read defect" }),
  }),
}));

// VIEW

const summaryText = (summary: Option.Option<Summary | null>): string =>
  Option.match(summary, {
    onNone: () => "No slip captured yet.",
    onSome: (slip) =>
      slip === null
        ? "No slip captured yet."
        : `${slip.prompt} -> ${slip.answer} (${slip.reviews} reviews)`,
  });

const field = { display: "grid", gap: "0.25rem", marginBottom: "1rem" } as const;
const inputStyle = {
  border: "1px solid #aaa",
  borderRadius: "0.375rem",
  padding: "0.5rem",
  width: "100%",
} as const;

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
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
      h.p([], ["A minimal slip box hosted on local Docker with Effect Cluster."]),
      h.div(
        [h.Style(field)],
        [
          h.label([], ["Prompt"]),
          h.input([
            h.Value(model.prompt),
            h.OnInput((value) => Message.ChangedPrompt({ value })),
            h.Placeholder("What do you want to remember?"),
            h.Style(inputStyle),
          ]),
        ],
      ),
      h.div(
        [h.Style(field)],
        [
          h.label([], ["Answer"]),
          h.textarea([
            h.Value(model.answer),
            h.OnInput((value) => Message.ChangedAnswer({ value })),
            h.Placeholder("The answer to recall."),
            h.Style({ ...inputStyle, minHeight: "6rem" }),
          ]),
        ],
      ),
      h.div(
        [h.Style({ display: "flex", gap: "0.5rem", marginBottom: "1rem" })],
        [
          h.button([h.OnClick(Message.ClickedCapture())], ["Capture"]),
          h.button([h.OnClick(Message.ClickedReview())], ["Review"]),
        ],
      ),
      h.p([h.Style({ color: "#555" })], [model.status]),
      h.p([], [summaryText(model.summary)]),
      h.p([h.Style({ color: "#555", fontSize: "0.875rem" })], [
        "Run `bun run dev` for the stack and `bun run --filter @slipmem/web dev` for the UI.",
      ]),
    ],
  ),
});
