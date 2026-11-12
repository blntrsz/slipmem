import * as Cluster from "@alchemy.run/effect-cluster";
import * as Docker from "@alchemy.run/docker";
import { NoteApi } from "@slipmem/domain/note/note.api";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { fileURLToPath } from "node:url";
import { Database } from "./cluster.ts";
import { SlipMemLive } from "./note-live.ts";
import { serveStatic } from "./static-files.ts";

/** The built web app is mounted into the API container read-only. */
const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));

/**
 * The public HTTP service: the domain Api under `/api`, a health check, and
 * the built web app on every other path. The same origin means the Foldkit
 * client can call `/api` without CORS.
 */
export default class MemoryService extends Docker.Service<MemoryService>()(
  "MemoryService",
  Effect.gen(function* () {
    const database = yield* Cluster.Database.Database;
    return {
      main: import.meta.url,
      port: 3000,
      ports: [{ external: 8080, internal: 3000 }],
      networks:
        database.network?.kind === "docker" ? [{ name: database.network.name }] : undefined,
      volumes: [{ hostPath: webRoot, containerPath: "/app/web", readOnly: true }],
      environment: { WEB_ROOT: "/app/web" },
    };
  }).pipe(Effect.provide(Database)),
  Effect.gen(function* () {
    const api = yield* NoteApi;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://slipmem");
        if (url.pathname === "/health") {
          return HttpServerResponse.text("ok");
        }
        if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
          return yield* api.fetch;
        }
        return yield* serveStatic(url.pathname);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(SlipMemLive)),
) {}
