import { MemoryApi } from "@slipmem/domain/memory-api.api";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { Runtime } from "foldkit";
import { init, Model, subscriptions, update, view } from "./app.ts";

/**
 * In production the API serves this build on the same origin, so `/api` is
 * enough. Vite's dev server proxies `/api` to the Docker API on port 8080.
 */
const Resources = MemoryApi.layerClientHttp("/api").pipe(Layer.provide(FetchHttpClient.layer));

Runtime.run(
  Runtime.makeApplication({
    Model,
    init,
    update,
    view,
    subscriptions,
    resources: Resources,
    container: document.getElementById("root"),
  }),
);
