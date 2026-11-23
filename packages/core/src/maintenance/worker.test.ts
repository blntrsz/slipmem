import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  makeMarkdownNoteRepository,
  type MarkdownNoteRepositoryShape,
} from "../markdown/repository.js"
import {
  MAINTENANCE_ACTOR,
  MAINTENANCE_PROVENANCE_SOURCE,
  MAX_TRACKED_SOURCES,
  maintenanceMetadata,
  maintenanceUnknown,
  makePermanentMaintenanceWorker,
  readMaintenanceMetadata,
  type MaintenanceProvider,
  type MaintenanceRequest,
  type PermanentMaintenanceWorkerShape,
} from "./index.js"

const FIXED_NOW = Date.parse("2026-11-20T09:00:00Z")

interface Fixture {
  readonly base: string
  readonly root: string
  readonly repository: MarkdownNoteRepositoryShape
  readonly clock: { value: number }
}

const createFixture = async (): Promise<Fixture> => {
  const base = mkdtempSync(join(tmpdir(), "slipmem-maintenance-"))
  const root = join(base, ".slipmem")
  mkdirSync(root, { recursive: true })
  const clock = { value: FIXED_NOW }
  const repository = await Effect.runPromise(
    makeMarkdownNoteRepository({
      root,
      backupDir: join(base, "backups"),
      now: () => clock.value,
    }),
  )
  return { base, root, repository, clock }
}

const cleanup = (fixture: Fixture): void => {
  rmSync(fixture.base, { recursive: true, force: true })
}

const nextSecond = (fixture: Fixture): void => {
  fixture.clock.value += 1000
}

const createNote = async (
  fixture: Fixture,
  type: "fleeting" | "permanent" | "literature",
  title: string,
  content: string,
) => {
  nextSecond(fixture)
  return Effect.runPromise(
    fixture.repository.create({ type, title, content }),
  )
}

const makeWorker = (
  fixture: Fixture,
  provider: MaintenanceProvider,
  config: {
    readonly sourceLimit?: number
    readonly candidateLimit?: number
  } = {},
): Promise<PermanentMaintenanceWorkerShape> =>
  Effect.runPromise(
    makePermanentMaintenanceWorker(fixture.repository, {
      provider,
      now: () => fixture.clock.value,
      ...config,
    }),
  )

const createOnly = (sourceId: string, title: string, content: string): MaintenanceProvider =>
  () =>
    Effect.succeed({
      operations: [
        {
          operation: "create",
          title,
          content,
          tags: ["consolidated"],
          sourceIds: [sourceId],
        },
      ],
    })

const createSaturatedPermanent = async (
  fixture: Fixture,
): Promise<{ readonly id: string; readonly content: string }> => {
  const title = "Saturated memory"
  const content = "A permanent that already tracks the source limit."
  const sources = Array.from({ length: MAX_TRACKED_SOURCES }, (_, index) => ({
    id: `tracked-${index}`,
    contentHash: "a".repeat(64),
  }))
  const note = await Effect.runPromise(
    fixture.repository.create({
      type: "permanent",
      title,
      content,
      unknown: maintenanceUnknown(
        {},
        maintenanceMetadata({
          title,
          content,
          tags: [],
          sources,
          generatedAt: "2026-11-20T09:00:00Z",
        }),
      ),
    }),
  )
  return { id: note.id, content }
}

const getNote = async (fixture: Fixture, id: string) =>
  Effect.runPromise(fixture.repository.get(id))

const noteBody = async (fixture: Fixture, id: string): Promise<string> => {
  const note = await getNote(fixture, id)
  if (Option.isNone(note)) {
    throw new Error(`Missing note ${id}`)
  }
  return note.value.body
}

const maintenanceMarker = async (fixture: Fixture, id: string) => {
  const note = await getNote(fixture, id)
  if (Option.isNone(note)) {
    throw new Error(`Missing note ${id}`)
  }
  return note.value.unknown.maintenance as {
    readonly version: number
    readonly generatedAt: string
    readonly stateHash: string
    readonly sources: ReadonlyArray<{ readonly id: string; readonly contentHash: string }>
    readonly relations?: ReadonlyArray<{
      readonly kind: string
      readonly target: string
      readonly targetHash: string
      readonly evidence: ReadonlyArray<{
        readonly id: string
        readonly contentHash: string
      }>
    }>
  }
}

describe("permanent maintenance worker", () => {
  test("creates a model-owned permanent and makes the run restart-safe", async () => {
    const fixture = await createFixture()
    try {
      const source = await createNote(
        fixture,
        "fleeting",
        "Inbox thought",
        "A captured thought that should become durable memory.",
      )
      const worker = await makeWorker(
        fixture,
        createOnly(
          source.id,
          "Durable memory",
          "A captured thought can become durable, self-contained memory.",
        ),
      )

      const first = await Effect.runPromise(worker.run())
      expect(first.status).toBe("applied")
      expect(first.providerCalled).toBe(true)
      expect(first.writes).toHaveLength(1)
      expect(first.writes[0]).toMatchObject({
        operation: "create",
        sourceIds: [source.id],
      })

      const permanentId = first.writes[0]!.noteId
      const permanent = await getNote(fixture, permanentId)
      expect(Option.isSome(permanent)).toBe(true)
      if (Option.isSome(permanent)) {
        expect(permanent.value.metadata.type).toBe("permanent")
        expect(permanent.value.metadata.provenance).toMatchObject({
          source: MAINTENANCE_PROVENANCE_SOURCE,
          actor: MAINTENANCE_ACTOR,
        })
        expect(permanent.value.metadata.tags).toEqual(["consolidated"])
      }

      const marker = await maintenanceMarker(fixture, permanentId)
      expect(marker.version).toBe(2)
      expect(marker.relations).toEqual([])
      expect(marker.sources).toEqual([
        { id: source.id, contentHash: source.contentHash },
      ])
      expect(marker.stateHash).toMatch(/^[0-9a-f]{64}$/)

      // A fresh worker instance must read the source tracking from the note file
      // and not need any sidecar state. It also does not call the provider.
      let providerCalled = false
      const restarted = await makeWorker(fixture, () => {
        providerCalled = true
        return Effect.fail(new Error("must not be called"))
      })
      const second = await Effect.runPromise(restarted.run())
      expect(second).toMatchObject({
        status: "no-op",
        pendingSourceCount: 0,
        providerCalled: false,
        writes: [],
      })
      expect(providerCalled).toBe(false)

      const sourceAfter = await getNote(fixture, source.id)
      expect(Option.isSome(sourceAfter)).toBe(true)
      if (Option.isSome(sourceAfter)) {
        expect(sourceAfter.value.metadata.type).toBe("fleeting")
      }
    } finally {
      cleanup(fixture)
    }
  })

  test("updates a managed permanent when a source revision changes", async () => {
    const fixture = await createFixture()
    try {
      const source = await createNote(
        fixture,
        "fleeting",
        "First capture",
        "Bounded recall keeps context small.",
      )
      const initial = await makeWorker(
        fixture,
        createOnly(
          source.id,
          "Bounded recall",
          "Recall is bounded so context stays small.",
        ),
      )
      const first = await Effect.runPromise(initial.run())
      const permanentId = first.writes[0]!.noteId
      const before = await maintenanceMarker(fixture, permanentId)

      nextSecond(fixture)
      const updatedSource = await Effect.runPromise(
        fixture.repository.update({
          id: source.id,
          content: "Bounded recall also rejects unbounded context.",
        }),
      )

      const provider: MaintenanceProvider = (request) => {
        expect(request.candidates.map((candidate) => candidate.id)).toContain(
          permanentId,
        )
        return Effect.succeed({
          operations: [
            {
              operation: "update",
              candidateId: permanentId,
              title: "Bounded recall",
              content:
                "Recall is bounded so context stays small and unbounded context is rejected.",
              tags: ["consolidated"],
              sourceIds: [source.id],
            },
          ],
        })
      }
      const worker = await makeWorker(fixture, provider)
      const second = await Effect.runPromise(worker.run())

      expect(second.status).toBe("applied")
      expect(second.writes).toEqual([
        {
          operation: "update",
          noteId: permanentId,
          candidateId: permanentId,
          sourceIds: [source.id],
        },
      ])
      expect(await noteBody(fixture, permanentId)).toBe(
        "Recall is bounded so context stays small and unbounded context is rejected.",
      )
      const after = await maintenanceMarker(fixture, permanentId)
      expect(after.sources).toEqual([
        { id: source.id, contentHash: updatedSource.contentHash },
      ])
      expect(after.stateHash).not.toBe(before.stateHash)

      // Updating a source is not reclassification or deletion.
      const sourceAfter = await getNote(fixture, source.id)
      expect(Option.isSome(sourceAfter)).toBe(true)
      if (Option.isSome(sourceAfter)) {
        expect(sourceAfter.value.metadata.type).toBe("fleeting")
      }
    } finally {
      cleanup(fixture)
    }
  })

  test("reuses an existing managed owner instead of creating a duplicate", async () => {
    const fixture = await createFixture()
    try {
      const source = await createNote(
        fixture,
        "fleeting",
        "Owned capture",
        "The first revision of an owned source.",
      )
      const initial = await makeWorker(
        fixture,
        createOnly(source.id, "Owned memory", "The original permanent."),
      )
      const first = await Effect.runPromise(initial.run())
      const permanentId = first.writes[0]!.noteId

      nextSecond(fixture)
      await Effect.runPromise(
        fixture.repository.update({
          id: source.id,
          content: "The second revision of an owned source.",
        }),
      )

      const worker = await makeWorker(fixture, () =>
        Effect.succeed({
          operations: [
            {
              operation: "create",
              title: "Duplicate memory",
              content: "A duplicate that must not be created.",
              sourceIds: [source.id],
            },
          ],
        }),
      )
      const second = await Effect.runPromise(worker.run())

      expect(second.writes).toEqual([])
      expect(
        second.skips.some((skip) => skip.reason.includes("creating a duplicate")),
      ).toBe(true)
      expect(await noteBody(fixture, permanentId)).toBe(
        "The original permanent.",
      )
    } finally {
      cleanup(fixture)
    }
  })

  test("never overwrites a manually edited permanent", async () => {
    const fixture = await createFixture()
    try {
      const source = await createNote(
        fixture,
        "fleeting",
        "Editable capture",
        "Original source text.",
      )
      const initial = await makeWorker(
        fixture,
        createOnly(source.id, "Editable memory", "Original generated text."),
      )
      const first = await Effect.runPromise(initial.run())
      const permanentId = first.writes[0]!.noteId

      nextSecond(fixture)
      await Effect.runPromise(
        fixture.repository.update({
          id: permanentId,
          content: "A human deliberately rewrote this permanent.",
        }),
      )

      nextSecond(fixture)
      await Effect.runPromise(
        fixture.repository.update({
          id: source.id,
          content: "A newly changed source revision.",
        }),
      )

      let received: MaintenanceRequest | undefined
      const provider: MaintenanceProvider = (request) => {
        received = request
        return Effect.succeed({
          operations: [
            {
              operation: "update",
              candidateId: permanentId,
              title: "Editable memory",
              content: "The worker must not write this.",
              sourceIds: [source.id],
            },
          ],
        })
      }
      const worker = await makeWorker(fixture, provider)
      const second = await Effect.runPromise(worker.run())

      expect(received?.candidates.map((candidate) => candidate.id)).not.toContain(
        permanentId,
      )
      expect(second.writes).toEqual([])
      expect(second.skips.some((skip) => skip.candidateId === permanentId)).toBe(
        true,
      )
      expect(await noteBody(fixture, permanentId)).toBe(
        "A human deliberately rewrote this permanent.",
      )
    } finally {
      cleanup(fixture)
    }
  })

  test("a manual edit during the model call wins over the stale compare-and-swap", async () => {
    const fixture = await createFixture()
    try {
      const source = await createNote(
        fixture,
        "fleeting",
        "Race capture",
        "The first source revision.",
      )
      const initial = await makeWorker(
        fixture,
        createOnly(source.id, "Race memory", "The first generated revision."),
      )
      const first = await Effect.runPromise(initial.run())
      const permanentId = first.writes[0]!.noteId

      nextSecond(fixture)
      await Effect.runPromise(
        fixture.repository.update({
          id: source.id,
          content: "The second source revision.",
        }),
      )

      const provider: MaintenanceProvider = () =>
        Effect.gen(function* () {
          yield* fixture.repository.update({
            id: permanentId,
            content: "A human edit landed while the model was thinking.",
          })
          return {
            operations: [
              {
                operation: "update",
                candidateId: permanentId,
                title: "Race memory",
                content: "The model wants to replace the human edit.",
                sourceIds: [source.id],
              },
            ],
          }
        })

      const worker = await makeWorker(fixture, provider)
      const result = await Effect.runPromise(worker.run())

      expect(result.writes).toEqual([])
      expect(result.skips.some((skip) => skip.candidateId === permanentId)).toBe(
        true,
      )
      expect(await noteBody(fixture, permanentId)).toBe(
        "A human edit landed while the model was thinking.",
      )
      expect(readFileSync(join(fixture.root, `${permanentId}.md`), "utf8")).toContain(
        "A human edit landed while the model was thinking.",
      )
    } finally {
      cleanup(fixture)
    }
  })

  test("bounds the inbox and records each processed source revision", async () => {
    const fixture = await createFixture()
    try {
      const firstSource = await createNote(
        fixture,
        "fleeting",
        "First inbox note",
        "First source fact.",
      )
      const secondSource = await createNote(
        fixture,
        "fleeting",
        "Second inbox note",
        "Second source fact.",
      )
      const thirdSource = await createNote(
        fixture,
        "fleeting",
        "Third inbox note",
        "Third source fact.",
      )

      const provider: MaintenanceProvider = (request) => {
        expect(request.sources).toHaveLength(2)
        expect(request.omittedSourceCount).toBe(1)
        return Effect.succeed({
          operations: request.sources.map((source) => ({
            operation: "create",
            title: `Memory ${source.id}`,
            content: `Consolidated from ${source.title}.`,
            sourceIds: [source.id],
          })),
        })
      }
      const worker = await makeWorker(fixture, provider, { sourceLimit: 2 })
      const first = await Effect.runPromise(worker.run())
      expect(first.selectedSourceIds).toEqual([
        firstSource.id,
        secondSource.id,
      ])
      expect(first.examinedSources).toEqual([
        { id: firstSource.id, contentHash: firstSource.contentHash },
        { id: secondSource.id, contentHash: secondSource.contentHash },
      ])
      expect(first.omittedSourceCount).toBe(1)
      expect(first.writes).toHaveLength(2)

      const restarted = await makeWorker(
        fixture,
        () =>
          Effect.succeed({
            operations: [
              {
                operation: "create",
                title: "Remaining memory",
                content: `Consolidated from ${thirdSource.metadata.title}.`,
                sourceIds: [thirdSource.id],
              },
            ],
          }),
        { sourceLimit: 2 },
      )
      const second = await Effect.runPromise(restarted.run())
      expect(second.selectedSourceIds).toEqual([thirdSource.id])
      expect(second.omittedSourceCount).toBe(0)
      expect(second.writes).toHaveLength(1)
    } finally {
      cleanup(fixture)
    }
  })

  test("rejects unvalidated candidate IDs and duplicate source claims", async () => {
    const fixture = await createFixture()
    try {
      const source = await createNote(
        fixture,
        "fleeting",
        "Validation source",
        "Only the supplied source may be consolidated.",
      )
      const manual = await createNote(
        fixture,
        "permanent",
        "Manual permanent",
        "A human note that maintenance never owns.",
      )

      const provider: MaintenanceProvider = () =>
        Effect.succeed({
          operations: [
            {
              operation: "update",
              candidateId: manual.id,
              title: "Manual permanent",
              content: "An invalid overwrite attempt.",
              sourceIds: [source.id],
            },
            {
              operation: "create",
              title: "Valid memory",
              content: "A valid consolidation.",
              sourceIds: [source.id],
            },
            {
              operation: "create",
              title: "Duplicate memory",
              content: "The same source cannot be claimed twice in one pass.",
              sourceIds: [source.id],
            },
          ],
        })

      const worker = await makeWorker(fixture, provider)
      const result = await Effect.runPromise(worker.run())

      expect(result.writes).toHaveLength(1)
      expect(result.writes[0]?.operation).toBe("create")
      expect(result.skips.some((skip) => skip.candidateId === manual.id)).toBe(
        true,
      )
      expect(
        result.skips.some((skip) => skip.reason.includes("already assigned")),
      ).toBe(true)
      expect(await noteBody(fixture, manual.id)).toBe(
        "A human note that maintenance never owns.",
      )
    } finally {
      cleanup(fixture)
    }
  })

  test("defers ignored oldest sources so newer pending revisions get a turn", async () => {
    const fixture = await createFixture()
    try {
      const ignored = await createNote(
        fixture,
        "fleeting",
        "Ignored oldest",
        "The provider deliberately ignores this oldest source.",
      )
      const second = await createNote(
        fixture,
        "fleeting",
        "Second source",
        "The second source revision.",
      )
      const third = await createNote(
        fixture,
        "fleeting",
        "Third source",
        "The third source revision.",
      )

      const offered: string[][] = []
      const provider: MaintenanceProvider = (request) => {
        offered.push(request.sources.map((source) => source.id))
        const target = request.sources[0]
        if (target === undefined || target.id === ignored.id) {
          return Effect.succeed({ operations: [] })
        }
        return Effect.succeed({
          operations: [
            {
              operation: "create",
              title: `Memory ${target.id}`,
              content: `Consolidated from ${target.title}.`,
              sourceIds: [target.id],
            },
          ],
        })
      }
      const worker = await makeWorker(fixture, provider, { sourceLimit: 1 })

      const first = await Effect.runPromise(worker.run())
      expect(first.selectedSourceIds).toEqual([ignored.id])
      expect(first.writes).toEqual([])

      // The ignored source is deferred, so the newer source is selected even
      // though the oldest one is still pending.
      const secondRun = await Effect.runPromise(worker.run())
      expect(secondRun.selectedSourceIds).toEqual([second.id])
      expect(secondRun.writes).toHaveLength(1)

      const thirdRun = await Effect.runPromise(worker.run())
      expect(thirdRun.selectedSourceIds).toEqual([third.id])
      expect(thirdRun.writes).toHaveLength(1)

      // The cooldown is bounded, not a permanent exclusion: the ignored source
      // is still retried once nothing newer is pending.
      const fourth = await Effect.runPromise(worker.run())
      expect(fourth.selectedSourceIds).toEqual([ignored.id])
      expect(fourth.writes).toEqual([])
      expect(offered).toEqual([
        [ignored.id],
        [second.id],
        [third.id],
        [ignored.id],
      ])
    } finally {
      cleanup(fixture)
    }
  })

  test("does not apply source revisions changed or deleted during the model call", async () => {
    const fixture = await createFixture()
    try {
      const changed = await createNote(
        fixture,
        "fleeting",
        "Changing source",
        "The revision sent to the provider.",
      )
      const deleted = await createNote(
        fixture,
        "fleeting",
        "Deleted source",
        "This source is removed while the provider runs.",
      )

      const provider: MaintenanceProvider = () =>
        Effect.gen(function* () {
          yield* fixture.repository.update({
            id: changed.id,
            content: "A revision that landed during the model call.",
          })
          yield* fixture.repository.delete(deleted.id)
          return {
            operations: [
              {
                operation: "create",
                title: "Changed memory",
                content: "Must not be applied from the stale revision.",
                sourceIds: [changed.id],
              },
              {
                operation: "create",
                title: "Deleted memory",
                content: "Must not be applied from a deleted source.",
                sourceIds: [deleted.id],
              },
            ],
          }
        })
      const worker = await makeWorker(fixture, provider)
      const first = await Effect.runPromise(worker.run())

      expect(first.writes).toEqual([])
      expect(first.skips).toHaveLength(2)
      expect(
        first.skips.every((skip) =>
          skip.reason.includes("changed or was deleted"),
        ),
      ).toBe(true)
      expect(first.skips.map((skip) => skip.sourceIds).flat()).toEqual([
        changed.id,
        deleted.id,
      ])
      expect(
        await noteBody(fixture, changed.id),
      ).toBe("A revision that landed during the model call.")
      expect(Option.isNone(await getNote(fixture, deleted.id))).toBe(true)

      // The changed revision is still pending and can be consolidated on the
      // next run with its current hash, not the stale one.
      const current = await getNote(fixture, changed.id)
      expect(Option.isSome(current)).toBe(true)
      if (Option.isNone(current)) {
        return
      }
      const retried = await makeWorker(fixture, (request) => {
        expect(request.sources.map((source) => source.contentHash)).toEqual([
          current.value.contentHash,
        ])
        return Effect.succeed({
          operations: [
            {
              operation: "create",
              title: "Current memory",
              content: "Consolidated from the revision that won the race.",
              sourceIds: [changed.id],
            },
          ],
        })
      })
      const second = await Effect.runPromise(retried.run())
      expect(second.writes).toHaveLength(1)
      const marker = await maintenanceMarker(fixture, second.writes[0]!.noteId)
      expect(marker.sources).toEqual([
        { id: changed.id, contentHash: current.value.contentHash },
      ])
    } finally {
      cleanup(fixture)
    }
  })

  test("refuses writes that would make the tracked-source marker unreadable", async () => {
    const fixture = await createFixture()
    try {
      const saturated = await createSaturatedPermanent(fixture)
      const before = await getNote(fixture, saturated.id)
      expect(Option.isSome(before)).toBe(true)
      if (Option.isSome(before)) {
        expect(readMaintenanceMetadata(before.value)).not.toBeNull()
      }

      const unrelated = await createNote(
        fixture,
        "fleeting",
        "New related thought",
        "A new source that would push the marker past its bound.",
      )
      const refused = await makeWorker(fixture, () =>
        Effect.succeed({
          operations: [
            {
              operation: "update",
              candidateId: saturated.id,
              title: "Saturated memory",
              content: "A merged revision that must not overflow the bound.",
              tags: [],
              sourceIds: [unrelated.id],
            },
          ],
        }),
      )
      const first = await Effect.runPromise(refused.run())

      expect(first.writes).toEqual([])
      expect(
        first.skips.some(
          (skip) =>
            skip.candidateId === saturated.id &&
            skip.reason.includes(String(MAX_TRACKED_SOURCES)),
        ),
      ).toBe(true)
      const unchanged = await getNote(fixture, saturated.id)
      expect(Option.isSome(unchanged)).toBe(true)
      if (Option.isSome(unchanged)) {
        expect(unchanged.value.body).toBe(saturated.content)
        expect(readMaintenanceMetadata(unchanged.value)).not.toBeNull()
      }

      // Replacing the revision of an already tracked source keeps the count at
      // the bound, so it is still eligible.
      const trackedSource = await createNote(
        fixture,
        "fleeting",
        "Tracked 0",
        "A fresh revision of a source that is already tracked.",
      )
      expect(trackedSource.id).toBe("tracked-0")
      const accepted = await makeWorker(fixture, () =>
        Effect.succeed({
          operations: [
            {
              operation: "update",
              candidateId: saturated.id,
              title: "Saturated memory",
              content: "A permanent that absorbed one tracked revision.",
              tags: [],
              sourceIds: [trackedSource.id],
            },
          ],
        }),
      )
      const second = await Effect.runPromise(accepted.run())

      expect(second.writes).toHaveLength(1)
      const updated = await getNote(fixture, saturated.id)
      expect(Option.isSome(updated)).toBe(true)
      if (Option.isSome(updated)) {
        const marker = readMaintenanceMetadata(updated.value)
        expect(marker).not.toBeNull()
        expect(marker?.sources).toHaveLength(MAX_TRACKED_SOURCES)
        expect(
          marker?.sources.find((source) => source.id === trackedSource.id)
            ?.contentHash,
        ).toBe(trackedSource.contentHash)
      }
    } finally {
      cleanup(fixture)
    }
  })
})
