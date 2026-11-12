import * as ClusterDocker from "@alchemy.run/effect-cluster/Docker";
import * as Layer from "effect/Layer";

/** Postgres the runners coordinate through. Requires Docker swarm mode. */
export const Database = ClusterDocker.Database("SlipMemCluster");

/** The runners that host `SlipMemLive`. */
export const Default = ClusterDocker.SwarmPool("Default", { replicas: 2 }).pipe(
  Layer.provide(Database),
);
