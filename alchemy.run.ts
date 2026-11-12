import * as Docker from "@alchemy.run/docker";
import MemoryService from "@slipmem/server/memory-service";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * The local stack: one API container serving `/api` and the built web app,
 * with the note state persisted in a SQLite database on a Docker volume.
 *
 * Requires a Docker daemon with swarm mode (`docker swarm init`). `bun run
 * deploy` builds `packages/web` before deploying so the mounted `dist`
 * exists; `bun run dev` runs the service under Alchemy's local dev loop.
 */
export default Alchemy.Stack(
  "SlipMem",
  {
    providers: Layer.mergeAll(Docker.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* MemoryService;
    return { url: "http://localhost:8080", service: api.name };
  }),
);
