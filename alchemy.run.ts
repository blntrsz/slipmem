import * as Cluster from "@alchemy.run/effect-cluster";
import * as Docker from "@alchemy.run/docker";
import MemoryService from "@slipmem/server/memory-service";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * The local stack: a Postgres database, two Effect Cluster runners, and the
 * API container that serves `/api` and the built web app together.
 *
 * Requires a Docker daemon in swarm mode (`docker swarm init`). `bun run
 * deploy` builds `packages/web` before deploying so the mounted `dist`
 * exists; `bun run dev` runs the stack under Alchemy's local dev loop.
 */
export default Alchemy.Stack(
  "SlipMem",
  {
    providers: Layer.mergeAll(Docker.providers(), Cluster.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* MemoryService;
    return { url: "http://localhost:8080", service: api.name };
  }),
);
