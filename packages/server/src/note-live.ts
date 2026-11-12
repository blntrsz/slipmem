import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
import { SlipMem } from "@slipmem/domain/note/note.model";
import * as Layer from "effect/Layer";
import { Default } from "./cluster.ts";

/**
 * Hosts the domain model on Effect Cluster. The pool's runners load this
 * module and the exported `SlipMemLive` layer; the API container gets the
 * same layer, where it binds the model through the pool's gateway.
 */
export const SlipMemLive = SlipMem.layer(Layer.empty).pipe(
  Layer.provide(
    DomainCluster.layerEntities({
      name: "SlipMem",
      main: import.meta.url,
      handler: "SlipMemLive",
      pool: Default,
    }),
  ),
);
