import {
  alarmCallbacks,
  className,
  makePlatform,
  ObjectState,
  type Host,
  type ListOptions,
  type Namespace,
  type ObjectImpl,
  type ObjectStateShape,
  type ObjectStorage,
} from "@alchemy.run/domain/DurableObjects";
import type { HostedModel } from "@alchemy.run/domain/Platform";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { and, asc, desc, eq, gt, gte, inArray, lt } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { Platform as DomainPlatform } from "@alchemy.run/domain";
import { Database, layer as databaseLayer } from "./db/database.ts";
import type { DatabaseShape } from "./db/database.ts";
import { domainObjects } from "./db/schema.ts";

const encode = (value: unknown): string => JSON.stringify(value ?? null);
const decode = <T>(text: string): T => JSON.parse(text) as T;

/**
 * Domain's storage protocol over Drizzle and SQLite. The value is JSON, as
 * Domain's events, view snapshots and queue rows are plain JSON documents.
 */
export const objectStorage = (
  database: DatabaseShape,
  object: string,
  transactions: Semaphore.Semaphore,
): ObjectStorage => {
  const { db, sqlite } = database;
  const key = domainObjects.key;
  const value = domainObjects.value;

  const putOne = (entryKey: string, entryValue: unknown) =>
    Effect.sync(() => {
      const encoded = encode(entryValue);
      db.insert(domainObjects)
        .values({ object, key: entryKey, value: encoded })
        .onConflictDoUpdate({
          target: [domainObjects.object, domainObjects.key],
          set: { value: encoded },
        })
        .run();
    });

  const runDelete = (keys: ReadonlyArray<string>) =>
    Effect.sync(() =>
      keys.length === 0
        ? 0
        : db
            .delete(domainObjects)
            .where(and(eq(domainObjects.object, object), inArray(key, [...keys])))
            .returning({ key })
            .all().length,
    );

  let savepoint = 0;

  return {
    get: <T>(entryKey: string) =>
      Effect.sync(() => {
        const row = db
          .select({ value })
          .from(domainObjects)
          .where(and(eq(domainObjects.object, object), eq(key, entryKey)))
          .limit(1)
          .all()[0];
        return row === undefined ? undefined : decode<T>(row.value);
      }),
    put: ((keyOrEntries: string | Record<string, unknown>, entryValue?: unknown) =>
      typeof keyOrEntries === "string"
        ? putOne(keyOrEntries, entryValue)
        : Effect.forEach(Object.entries(keyOrEntries), ([entryKey, entry]) =>
            putOne(entryKey, entry),
          ).pipe(Effect.asVoid)) as ObjectStorage["put"],
    delete: ((keyOrKeys: string | ReadonlyArray<string>) => {
      const keys = typeof keyOrKeys === "string" ? [keyOrKeys] : keyOrKeys;
      return runDelete(keys).pipe(
        Effect.map((deleted) => (typeof keyOrKeys === "string" ? deleted > 0 : deleted)),
      );
    }) as ObjectStorage["delete"],
    list: <T>(options: ListOptions = {}) =>
      Effect.sync(() => {
        const conditions: Array<SQL> = [eq(domainObjects.object, object)];
        if (options.prefix !== undefined) {
          // A range, not LIKE: SQLite's LIKE is case-insensitive, while
          // Domain's keys are ordered byte-for-byte.
          conditions.push(gte(key, options.prefix));
          conditions.push(lt(key, `${options.prefix}\u{10FFFF}`));
        }
        if (options.start !== undefined) conditions.push(gte(key, options.start));
        if (options.startAfter !== undefined) conditions.push(gt(key, options.startAfter));
        if (options.end !== undefined) conditions.push(lt(key, options.end));

        const rows = db
          .select({ key, value })
          .from(domainObjects)
          .where(and(...conditions))
          .orderBy(options.reverse === true ? desc(key) : asc(key))
          .limit(options.limit === undefined ? -1 : Math.max(0, options.limit))
          .all();
        return new Map(rows.map((row) => [row.key, decode<T>(row.value)]));
      }),
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          // A savepoint also works as the outermost transaction, and nests
          // correctly when Domain's backfill wraps a commit.
          const name = `slipmem_tx_${++savepoint}`;
          sqlite.exec(`SAVEPOINT ${name}`);
          return name;
        }),
        () => effect,
        (name, exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) {
              sqlite.exec(`RELEASE ${name}`);
            } else {
              sqlite.exec(`ROLLBACK TO ${name}`);
              sqlite.exec(`RELEASE ${name}`);
            }
          }),
      ).pipe(transactions.withPermits(1)),
  };
};

interface Instance {
  readonly record: Record<string, unknown>;
  readonly fire: Effect.Effect<void>;
}

interface HostState {
  readonly classes: Map<string, ObjectImpl>;
  readonly instances: Map<string, Effect.Effect<Instance>>;
  readonly declared: Map<string, Namespace>;
}

const instanceId = (cls: string, key: string) => `${cls}/${key}`;

const splitInstance = (id: string): { readonly cls: string; readonly key: string } => {
  const slash = id.indexOf("/");
  return slash < 0 ? { cls: id, key: "" } : { cls: id.slice(0, slash), key: id.slice(slash + 1) };
};

/**
 * An in-process host for Domain's object model. Every aggregate, view and
 * queue key is an object with its own SQLite-backed storage and exclusive
 * section; calls are direct Effects rather than RPC. One process owns the
 * database, so no gateway or shard routing is needed.
 */
export interface LocalHost extends Host {
  /** Run callbacks whose alarm is due, for the background sweep. */
  readonly poll: Effect.Effect<void>;
}

export const makeHost = (
  database: DatabaseShape,
  scope: Scope.Scope,
): LocalHost => {
  const state: HostState = {
    classes: new Map(),
    instances: new Map(),
    declared: new Map(),
  };
  const transactions = Semaphore.makeUnsafe(1);

  const build = (id: string): Effect.Effect<Instance> =>
    Effect.gen(function* () {
      const { cls } = splitInstance(id);
      const impl = state.classes.get(cls);
      if (impl === undefined) {
        return yield* Effect.die(new Error(`SlipMem SQLite host has no class '${cls}'.`));
      }
      const storage = objectStorage(database, id, transactions);
      const callbacks = alarmCallbacks(storage, {
        set: (at) => storage.put("~alarm", at),
        get: storage.get<number>("~alarm").pipe(Effect.map((at) => at ?? null)),
      });
      const exclusive = Semaphore.makeUnsafe(1);
      const objectState: ObjectStateShape = {
        storage,
        exclusive: (effect) => exclusive.withPermits(1)(effect),
        // Background drains outlive the call that starts them, but not the
        // process. Their durable rows remain and the alarm poll retries them.
        waitUntil: (effect) => Effect.forkIn(effect, scope).pipe(Effect.asVoid),
      };
      const runtime = RuntimeContext.of({
        Type: "SlipMem/SQLite",
        id,
        env: process.env,
        get: () => Effect.succeed(undefined),
        set: (output) => Effect.succeed(output),
        makeCallback: callbacks.makeCallback,
      });
      const record = yield* impl.pipe(
        Effect.provideService(ObjectState, objectState),
        Effect.provideService(RuntimeContext, runtime),
        Effect.provideService(Scope.Scope, scope),
      );
      return { record, fire: callbacks.fire };
    });

  const instanceFor = (id: string): Effect.Effect<Instance> => {
    let cached = state.instances.get(id);
    if (cached === undefined) {
      cached = Effect.flatMap(Effect.cached(build(id)), (instance) => instance);
      state.instances.set(id, cached);
    }
    return cached;
  };

  /** Build an instance by object id, for the alarm poll. */
  const fire = (id: string): Effect.Effect<void> =>
    instanceFor(id).pipe(Effect.flatMap((instance) => instance.fire));

  const hasClass = (id: string) => state.classes.has(splitInstance(id).cls);

  const namespace = (cls: string): Namespace =>
    state.declared.get(cls) ?? {
      getByName: (key: string) => {
        const id = instanceId(cls, key);
        return new Proxy(
          {},
          {
            get:
              (_target, method) =>
              (...args: ReadonlyArray<unknown>) =>
                Effect.flatMap(instanceFor(id), (instance) => {
                  const value = instance.record[String(method)];
                  if (typeof value !== "function") {
                    return Effect.die(
                      new Error(`SlipMem object '${id}' has no method '${String(method)}'.`),
                    );
                  }
                  const result = (value as (...args: ReadonlyArray<unknown>) => unknown)(...args);
                  return Effect.isEffect(result)
                    ? (result as Effect.Effect<unknown>)
                    : Effect.succeed(result);
                }),
          },
        );
      },
    };

  const host: Host = {
    declare: ({ modelName }: HostedModel, name: string, impl: ObjectImpl) => {
      const cls = className(modelName, name);
      state.classes.set(cls, impl);
      const declared = namespace(cls);
      state.declared.set(cls, declared);
      return Effect.succeed(declared);
    },
    lookup: ({ modelName }: HostedModel, name: string) =>
      state.declared.get(className(modelName, name)),
    // One host per process owns the database, so the claim is a single object.
    claimKey: Effect.succeed(state),
  };

  return Object.assign(host, {
    /**
     * Run callbacks whose alarm is due. Domain uses these for outbox
     * backstops, scheduled commands and backfill; normal writes drain their
     * outbox immediately, and this sweep makes the durable rows recoverable
     * after a restart.
     */
    poll: Effect.gen(function* () {
      const rows = database.db
        .select({ object: domainObjects.object, value: domainObjects.value })
        .from(domainObjects)
        .where(eq(domainObjects.key, "~alarm"))
        .all();
      const now = Date.now();
      for (const row of rows) {
        if (!hasClass(row.object)) continue;
        const at = decode<number>(row.value);
        if (at > now) continue;
        yield* fire(row.object).pipe(Effect.ignoreCause);
      }
    }),
  });
};

export type { LocalHost as SqliteHost };

/**
 * The Domain platform over a local SQLite database. A single process hosts
 * every object; live reads poll the owning object (Domain streams the
 * snapshots over HTTP), so no WebSocket gateway is required.
 */
export const layer = (options: {
  readonly filename: string;
}): Layer.Layer<DomainPlatform | SecureRandom.SecureRandom> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const database = yield* Database;
      const scope = yield* Effect.scope;
      const host = makeHost(database, scope);
      const platform = makePlatform(host);
      const poll = Layer.effectDiscard(
        Effect.forkScoped(
          Effect.forever(
            host.poll.pipe(
              Effect.catchCause((cause) => Effect.logError("SQLite callback sweep failed", cause)),
              Effect.andThen(Effect.sleep("1 second")),
            ),
          ),
        ),
      );
      return Layer.merge(platform, poll);
    }),
  ).pipe(
    Layer.provide(databaseLayer(options)),
    Layer.provideMerge(SecureRandom.layerWebCrypto),
  ) as Layer.Layer<DomainPlatform | SecureRandom.SecureRandom>;
