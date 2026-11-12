# slipmem

A minimal slip box: capture a prompt and its answer, then review it. The
scaffold follows Alchemy's
[project layout](https://alchemy.run/domain/project-layout/), with all
filenames and folders in kebab-case.

The whole stack runs on local Docker:

```text
packages/
  domain/   @slipmem/domain   the model: aggregate, command, view, Api and stories
  server/   @slipmem/server   hosts the model on Effect Cluster and serves the web build
  web/      @slipmem/web      the foldkit app
alchemy.run.ts                one stack: Postgres, two cluster runners, and the API
```

## Layout

```text
packages/domain/
  src/slip/slip.id.ts
  src/slip/slip.aggregate.ts
  src/slip/capture-slip.command.ts
  src/slip/review-slip.command.ts
  src/slip/slip-summary.view.ts
  src/note/                      a second subdomain (model and Api, no UI yet)
  src/slip-mem.model.ts
  src/memory-api.api.ts
  test/slip.story.test.ts
  test/note.story.test.ts
packages/server/src/
  cluster.ts                  Postgres + the two-runner SwarmPool
  slip-mem-live.ts            the domain model hosted with @alchemy.run/domain/EffectCluster
  memory-service.ts           Docker service: /api, /health, and the web build
  static-files.ts             serves packages/web/dist from the container
packages/web/src/
  app.ts                      Foldkit Model, Messages, Commands and subscriptions
  entry.ts                    runtime resources; the typed Api client over /api
```

Commands live with their events and rejections. Shared pieces get their own
file. The domain package imports only `@alchemy.run/domain` and `effect`; the
server package owns the external systems (Docker, Effect Cluster, Postgres).

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
limit is rejected with `NoteTooLong`.

## Prerequisites

- [Bun](https://bun.sh) 1.4+
- Docker with swarm mode enabled, once per machine:

  ```sh
  docker swarm init
  ```

The stack uses the active Docker context. It is intended for local Docker;
it does not deploy to a cloud provider.

## Install

```sh
bun install
```

## Verify

```sh
bun run typecheck   # every package, plus alchemy.run.ts
bun run test        # domain stories, in memory
bun run build       # production Foldkit/Vite build
```

The domain stories exercise the model without Docker. The deployed path was
also verified locally with `alchemy deploy`: capture and review both cross the
API into the Effect Cluster runners, persist in Postgres, and the live
`SlipSummary` view updates the browser.

## Run it

Two processes, so the browser gets Vite hot reload and the API gets Docker:

```sh
# terminal 1: Postgres, two runners, API on http://localhost:8080
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
`/health`, and every other path from that directory. Tear it down with:

```sh
bun run destroy
```

## What the stack deploys

`alchemy.run.ts` declares:

- `SlipMemCluster` — a Postgres service the cluster coordinates through.
- `Default` — a `ClusterDocker.SwarmPool` with two Effect Cluster runners, on
  the database's overlay network.
- `SlipMemLive` — the domain model hosted by
  `@alchemy.run/domain/EffectCluster`. Aggregate and view state persist in the
  cluster's Postgres.
- `MemoryService` — a Docker service on port 8080. It serves the Api at
  `/api`, a health check at `/health`, and the built web app from the mounted
  `dist`.

Alchemy uses local state (`.alchemy/`) for this scaffold.

## Scope and current limitations

This is a working scaffold, not a finished product:

- One demo slip, id `demo`, is wired in the web app.
- The `Note` subdomain is hosted and exposed by the Api, but has no UI yet.
- There is no authentication or authorization.
- The web build is mounted into the API container rather than baked into its
  image. That keeps local deploys fast; a remote swarm should build an image
  containing `packages/web/dist` instead.
- The Docker target is local. There is no cloud deployment implementation.
- Versions are pinned to the current beta line: Alchemy
  `2.0.0-beta.86`, `@alchemy.run/domain` `2.0.0-beta.86`, Effect `4.1.4`,
  Foldkit `0.170.0`, and Vite `8.3.8`. Expect API changes while these are in
  beta.

## Scripts

| Script              | What it does                                          |
| ------------------- | ----------------------------------------------------- |
| `bun run dev`       | Run the Docker stack with Alchemy's dev loop          |
| `bun run dev:web`   | Run the Vite dev server, proxying `/api` to port 8080 |
| `bun run deploy`    | Build the web app, then deploy the Docker stack       |
| `bun run destroy`   | Destroy the stack                                      |
| `bun run build`     | Build `packages/web`                                   |
| `bun run typecheck` | Typecheck every package and `alchemy.run.ts`           |
| `bun run test`      | Run the domain stories                                 |
