# slipmem

A minimal slip box for notes. Capture a fleeting thought, a literature note,
or a permanent idea, then read them back in one live list. The scaffold follows
Alchemy's [project layout](https://alchemy.run/domain/project-layout/), with all
filenames and folders in kebab-case.

The API is one process. Notes are persisted in a real SQLite file through
[Drizzle ORM](https://orm.drizzle.team/); there is no Postgres, cluster, or
second runner.

```text
packages/
  domain/   @slipmem/domain   the note model, list view, Api and stories
  server/   @slipmem/server   hosts the model over SQLite and serves the web build
  web/      @slipmem/web      the foldkit app
alchemy.run.ts                one stack: the API container and its data volume
```

## Layout

```text
packages/domain/
  src/note/
    note.id.ts
    note.kind.ts
    note.rejection.ts
    note.aggregate.ts
    capture-fleeting-note.command.ts
    record-literature-note.command.ts
    write-permanent-note.command.ts
    note-list.view.ts             one collection view over every note
    note.model.ts                 the SlipMem model
    note.api.ts                   commands and reads the browser may use
  test/note.story.test.ts
packages/server/src/
  db/
    schema.ts                   Drizzle schema for Domain's storage table
    migrations.ts               ordered SQL migrations and the runner
    database.ts                 opens SQLite, enables WAL, applies migrations
    import.ts                   imports an old Postgres export
    import-cli.ts               CLI for that import
  sqlite-platform.ts            the Domain platform over SQLite and Drizzle
  note-live.ts                  the note model hosted in this process
  memory-service.ts             Docker service: /api, /health, and the web build
  static-files.ts               serves packages/web/dist from the container
packages/web/src/
  app.ts                        Foldkit Model, Messages, Commands and subscriptions
  entry.ts                      runtime resources; the typed Api client over /api
```

Commands live with their events and rejections. Shared pieces get their own
file. The domain package imports only `@alchemy.run/domain` and `effect`; the
server package owns adapters to the outside world (Docker, SQLite, Drizzle).

## Note kinds

A note's kind is fixed when it is created, and each kind has its own content
limit in characters (`NoteContentLimit` in
`packages/domain/src/note/note.kind.ts`):

| Kind       | Content limit | Required field |
| ---------- | ------------- | -------------- |
| Fleeting   | 1,000         | content       |
| Permanent  | 2,000         | title         |
| Literature | 5,000         | source        |

Limits are enforced after trimming surrounding whitespace, and a note over its
limit is rejected with `NoteTooLong`. The web form shows the active kind's
limit and blocks submission when the trimmed content would exceed it; the
aggregate enforces the same rule for every client.

## The notes list

`NoteList` is a domain `View` that folds every note's events into one state:

```ts
{ notes: ListedNote[] }
```

A domain view is read one key at a time, so this list is a singleton keyed by
the literal `"all"`. Each note event is routed to that key; the note's own
aggregate id is kept on every entry. The web app seeds it with
`NoteList.get("all")` and then follows it with a live watch.

For a personal slip box the whole list in one view is workable and preserves
event-sourced history. It is not a paged, searchable collection: a larger
collection would need a projection-backed `Query` or a dedicated store.

## Persistence

The domain remains event-sourced. `packages/server/src/sqlite-platform.ts`
hosts the model in the API process and implements Domain's object-storage
protocol over Drizzle:

- `domain_objects` has one row per `(object, key)`, with the value stored as
  JSON. An object is an aggregate instance, view key, queue, or the directory
  used for view backfills (`SlipMem.NoteAggregate/<id>`,
  `SlipMem.NoteListView/all`, and so on).
- Writes that Domain commits together run in a SQLite transaction. A process
  lock serializes those transactions because the connection is shared.
- WAL mode and `synchronous = NORMAL` keep local writes durable and fast. The
  database is a normal SQLite file, so it can be inspected with `sqlite3`.
- The schema and ordered migrations live in `packages/server/src/db/`. Migrations
  are recorded in `slipmem_migrations` and applied when the database opens.

The database path comes from `SLIPMEM_SQLITE_PATH`. Outside Docker it defaults
to `<cwd>/.slipmem/slipmem.sqlite`. In the deployed stack it is
`/app/data/slipmem.sqlite`, on the named Docker volume `slipmem-data`, so
redeploys and container restarts keep notes.

To back up a box, stop the API process and copy the database file (and any
`-wal` file next to it), or run `sqlite3 slipmem.sqlite "VACUUM INTO
'backup.sqlite'"` against a quiet database.

Live reads still work: Domain polls the owning object and streams snapshots over
`/api`, so the UI updates without WebSockets.

## Prerequisites

- [Bun](https://bun.sh) 1.4+
- Docker with swarm mode enabled, once per machine, for the deploy path:

  ```sh
  docker swarm init
  ```

The database and tests need no Docker. The stack uses the active Docker
context and is intended for local Docker; it does not deploy to a cloud
provider.

## Install

```sh
bun install
```

## Verify

```sh
bun run typecheck   # every package, plus alchemy.run.ts
bun run test        # domain stories + SQLite integration tests
bun run build       # production Foldkit/Vite build
```

The domain stories exercise the aggregate, rejections, content limits, and the
`NoteList` projection without Docker. The server tests open temporary SQLite
files, run the Api in process, and assert that notes and the list view survive
closing and reopening the database.

## Run it

Two processes, so the browser gets Vite hot reload and the API gets Docker:

```sh
# terminal 1: the API container on http://localhost:8080
bun run dev

# terminal 2: the Foldkit app, proxying /api to localhost:8080
bun run dev:web
```

Open the URL Vite prints. The API is also available directly at
`http://localhost:8080/health`.

To build the web app and deploy the whole stack in one step:

```sh
bun run deploy
# then open http://localhost:8080
```

`deploy` first runs `bun run build`, because the API container mounts
`packages/web/dist` read-only at `/app/web`. The API serves `/api` and
`/health`, and every other path from that directory. Tear the service down
with:

```sh
bun run destroy
```

`destroy` removes the service, not the `slipmem-data` volume. That keeps notes
if you redeploy later; remove the volume explicitly if you want a clean box:

```sh
docker volume rm slipmem-data
```

## What the stack deploys

`alchemy.run.ts` declares one thing: `MemoryService`, a Docker service on port
8080. It serves the Api at `/api`, a health check at `/health`, and the built
web app from the mounted `dist`, and it mounts the `slipmem-data` volume at
`/app/data` for SQLite.

Alchemy uses local state (`.alchemy/`) for this scaffold.

## Migrating notes from the old Postgres stack

The previous stack stored Domain's rows in the Effect Cluster Postgres table
`alchemy_domain_objects`, with the same object ids, keys, and JSON values that
the SQLite platform uses. An existing box can be moved by exporting that table
and importing it:

```sh
# 1. Find the old Postgres container (stop the old stack's writers first).
docker ps --filter name=SlipMemClusterPostgres

# 2. Export SlipMem's rows as one JSON object per line.
docker exec -i <postgres-container> \
  psql -U postgres -d cluster -At \
  -c "select json_build_object('object', object, 'key', key, 'value', value)
      from alchemy_domain_objects where object like 'SlipMem.%'" \
  > /tmp/slipmem-domain-objects.ndjson

# 3. Import into the SQLite file the API will use (created if absent).
SLIPMEM_SQLITE_PATH=/path/to/slipmem.sqlite \
  bun run import:postgres /tmp/slipmem-domain-objects.ndjson
```

The import upserts rows in one transaction and filters to `SlipMem.` objects.
It carries aggregate events, view snapshots, and Domain's bookkeeping. Run it
before tearing down the old stack, and point `SLIPMEM_SQLITE_PATH` at the same
file the API uses. In Docker, that is the `slipmem-data` volume mounted at
`/app/data`; the simplest path is to stop the new service, import into a copy
of the volume, then start the service again.

> **Export before you deploy.** The new stack no longer declares the old
> `SlipMemCluster` Postgres service or its data volume. Deploying it reconciles
> those resources away, so export the old table first if you need the notes.

Limitations of this migration:

- It is an offline copy. Stop writes to the old stack while exporting so the
  last events are not lost, and do not run both stacks against separate
  databases expecting them to merge.
- It copies whatever the export contains. Old `Slip` aggregate objects in the
  same table are ignored by the current model, so they stay inaccessible even
  if imported.
- There is no automatic reverse migration from SQLite to Postgres.
- The import assumes the current model and object naming
  (`SlipMem.NoteAggregate`, `SlipMem.NoteListView`). If the domain classes are
  renamed, export after the rename or migrate the object ids explicitly.

## Scope and current limitations

This is a working scaffold, not a finished product:

- Notes are create-only: there is no edit, delete, archive, or review flow.
- There are no links, backlinks, or graph view. The list is flat.
- The notes list is a singleton view; it is not paged or full-text searchable.
- SQLite is a single-writer database. The API runs one process and one
  container; do not scale `MemoryService` to multiple replicas over the same
  volume. A larger deployment would need a database server or an external
  queue for writes.
- The database is not encrypted at rest and there is no authentication or
  authorization. A local Docker volume is the security boundary.
- The Docker target is local. There is no cloud deployment implementation.
- The web build is mounted into the API container rather than baked into its
  image. That keeps local deploys fast; a remote swarm should build an image
  containing `packages/web/dist` instead.
- Versions are pinned to the current beta line: Alchemy
  `2.0.0-beta.86`, `@alchemy.run/domain` `2.0.0-beta.86`, Effect `4.1.4`,
  Foldkit `0.170.0`, Drizzle `0.45.x`, and Vite `8.3.8`. Expect API changes
  while these are in beta.

## Scripts

| Script                      | What it does                                             |
| --------------------------- | -------------------------------------------------------- |
| `bun run dev`               | Run the Docker stack with Alchemy's dev loop             |
| `bun run dev:web`           | Run the Vite dev server, proxying `/api` to port 8080    |
| `bun run deploy`            | Build the web app, then deploy the Docker stack          |
| `bun run destroy`           | Destroy the stack (the data volume stays)                |
| `bun run build`             | Build `packages/web`                                      |
| `bun run typecheck`         | Typecheck every package and `alchemy.run.ts`             |
| `bun run test`              | Run domain stories and SQLite integration tests          |
| `bun run import:postgres`   | Import an old Postgres Domain export into SQLite         |
