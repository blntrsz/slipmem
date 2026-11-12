import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Api } from "@alchemy.run/domain";
import { NoteApi } from "@slipmem/domain/note/note.api";
import { noteListKey } from "@slipmem/domain/note/note-list.view";
import { NoteId } from "@slipmem/domain/note/note.id";
import { SlipMem } from "@slipmem/domain/note/note.model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "../src/db/database.ts";
import { importDomainObjects } from "../src/db/import.ts";
import { domainObjects, schemaMigrations } from "../src/db/schema.ts";
import * as SqlitePlatform from "../src/sqlite-platform.ts";

let directory: string;
let filename: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "slipmem-test-"));
  filename = join(directory, "slipmem.sqlite");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const live = () =>
  NoteApi.layerClientInProcess.pipe(
    Layer.provide(
      SlipMem.layer(Layer.empty).pipe(Layer.provide(SqlitePlatform.layer({ filename }))),
    ),
  );

type Client = Api.ClientKey<"NoteApi">;

const waitFor = (count: number) =>
  Effect.gen(function* () {
    const client = yield* NoteApi.Client;
    for (let attempt = 0; attempt < 40; attempt++) {
      const state = yield* client.NoteList.get(noteListKey);
      if (state !== null && state.notes.length >= count) return state.notes;
      yield* Effect.sleep("100 millis");
    }
    const state = yield* client.NoteList.get(noteListKey);
    return state?.notes ?? [];
  });

const run = <A, E>(effect: Effect.Effect<A, E, Client>) =>
  Effect.runPromise(effect.pipe(Effect.provide(live())));

describe("SQLite persistence", () => {
  test("applies its migrations once", () => {
    const database = open({ filename });
    const applied = database.db
      .select({ name: schemaMigrations.name })
      .from(schemaMigrations)
      .all()
      .map((row) => row.name);
    expect(applied).toEqual(["0001_domain_objects"]);

    // Opening again (and so migrating again) records nothing new.
    database.sqlite.close();
    const reopened = open({ filename });
    expect(
      reopened.db.select({ name: schemaMigrations.name }).from(schemaMigrations).all(),
    ).toHaveLength(1);
    reopened.sqlite.close();
  });

  test("stores notes and the list view in SQLite, across a restart", async () => {
    const firstId = NoteId.make("note-fleeting");
    const secondId = NoteId.make("note-literature");

    await run(
      Effect.gen(function* () {
        const client = yield* NoteApi.Client;
        yield* client.CaptureFleetingNote(
          firstId,
          { content: "  Ask Sam about spaced repetition.  " },
          { commandId: "capture-1" },
        );
        const notes = yield* waitFor(1);
        expect(notes).toEqual([
          {
            id: firstId,
            kind: "fleeting",
            title: null,
            source: null,
            content: "Ask Sam about spaced repetition.",
          },
        ]);
      }),
    );

    // The data is really in the file: a plain connection sees Domain's rows.
    const direct = open({ filename });
    const rows = direct.db.select().from(domainObjects).all();
    direct.sqlite.close();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.object === `SlipMem.NoteAggregate/${firstId}`)).toBe(true);
    expect(rows.some((row) => row.object === "SlipMem.NoteListView/all")).toBe(true);

    // A fresh process reopens the same file and keeps the note.
    await run(
      Effect.gen(function* () {
        const client = yield* NoteApi.Client;
        expect(yield* waitFor(1)).toEqual([
          {
            id: firstId,
            kind: "fleeting",
            title: null,
            source: null,
            content: "Ask Sam about spaced repetition.",
          },
        ]);

        yield* client.RecordLiteratureNote(
          secondId,
          { source: "How to Take Smart Notes", content: "Writing is thinking." },
          { commandId: "capture-2" },
        );
        expect(yield* waitFor(2)).toEqual([
          {
            id: firstId,
            kind: "fleeting",
            title: null,
            source: null,
            content: "Ask Sam about spaced repetition.",
          },
          {
            id: secondId,
            kind: "literature",
            title: null,
            source: "How to Take Smart Notes",
            content: "Writing is thinking.",
          },
        ]);
      }),
    );
  });

  test("imports a Postgres-style export into a fresh SQLite box", async () => {
    const source = join(directory, "postgres-export.sqlite");
    const target = join(directory, "imported.sqlite");
    filename = source;

    await run(
      Effect.gen(function* () {
        const client = yield* NoteApi.Client;
        yield* client.WritePermanentNote(
          NoteId.make("note-permanent"),
          { title: "Writing is thinking", content: "One idea per note." },
          { commandId: "capture-import" },
        );
        yield* waitFor(1);
      }),
    );

    const old = open({ filename: source });
    const exported = old.db
      .select()
      .from(domainObjects)
      .all()
      .map((row) => ({ object: row.object, key: row.key, value: row.value }));
    old.sqlite.close();

    const imported = open({ filename: target });
    expect(importDomainObjects(imported.db, exported, { prefix: "SlipMem." })).toBe(
      exported.length,
    );
    imported.sqlite.close();

    filename = target;
    await run(
      Effect.gen(function* () {
        expect(yield* waitFor(1)).toEqual([
          {
            id: NoteId.make("note-permanent"),
            kind: "permanent",
            title: "Writing is thinking",
            source: null,
            content: "One idea per note.",
          },
        ]);
      }),
    );
  });

  test("keeps the domain's rejections at the API boundary", async () => {
    const error = await run(
      Effect.gen(function* () {
        const client = yield* NoteApi.Client;
        return yield* client
          .CaptureFleetingNote(
            NoteId.make("empty"),
            { content: "   " },
            { commandId: "empty-1" },
          )
          .pipe(Effect.flip);
      }),
    );
    expect(error._tag).toBe("EmptyNote");
  });
});
