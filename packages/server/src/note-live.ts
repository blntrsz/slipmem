import { SlipMem } from "@slipmem/domain/note/note.model";
import * as Layer from "effect/Layer";
import { defaultFilename } from "./db/database.ts";
import * as SqlitePlatform from "./sqlite-platform.ts";

/**
 * Hosts the domain model in this process over SQLite. The model's aggregate
 * instances, view keys and durable queues are objects in one database file;
 * there is no cluster, gateway or second process to coordinate with.
 */
export const SlipMemLive = SlipMem.layer(Layer.empty).pipe(
  Layer.provide(SqlitePlatform.layer({ filename: defaultFilename() })),
);
