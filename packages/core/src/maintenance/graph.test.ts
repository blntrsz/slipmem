import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  makeMarkdownNoteRepository,
  type MarkdownNoteRepositoryShape,
} from "../markdown/repository.js"
import {
  MAINTENANCE_METADATA_KEY,
  maintenanceMetadata,
  makePermanentMaintenanceWorker,
  readMaintenanceGraph,
  readMaintenanceMetadata,
  type MaintenanceProvider,
  type MaintenanceRelation,
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
  const base = mkdtempSync(join(tmpdir(), "slipmem-graph-"))
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
  unknown?: Readonly<Record<string, unknown>>,
) => {
  nextSecond(fixture)
  return Effect.runPromise(
    fixture.repository.create({
      type,
      title,
      content,
      ...(unknown === undefined ? {} : { unknown }),
    }),
  )
}

const makeWorker = (
  fixture: Fixture,
  provider: MaintenanceProvider,
): Promise<PermanentMaintenanceWorkerShape> =>
  Effect.runPromise(
    makePermanentMaintenanceWorker(fixture.repository, {
      provider,
      now: () => fixture.clock.value,
    }),
  )

const createOnly = (
  sourceId: string,
  title: string,
  content: string,
): MaintenanceProvider =>
  () =>
    Effect.succeed({
      operations: [
        {
          operation: "create",
          title,
          content,
          tags: [],
          sourceIds: [sourceId],
        },
      ],
    })

const graph = (fixture: Fixture) =>
  Effect.runPromise(readMaintenanceGraph(fixture.repository))

const getNote = async (fixture: Fixture, id: string) => {
  const note = await Effect.runPromise(fixture.repository.get(id))
  if (note._tag === "None") {
    throw new Error(`Missing note ${id}`)
  }
  return note.value
}

describe("maintenance graph projection", () => {
  test("projects derived_from automatically and invalidates it by source version", async () => {
    const fixture = await createFixture()
    try {
      const source = await createNote(
        fixture,
        "fleeting",
        "Source thought",
        "A fact that becomes durable memory.",
      )
      const first = await Effect.runPromise(
        (await makeWorker(
          fixture,
          createOnly(source.id, "Durable fact", "A fact can become durable memory."),
        )).run(),
      )
      const permanentId = first.writes[0]!.noteId

      const initial = await graph(fixture)
      const derived = initial.edges.find(
        (edge) =>
          edge.from === permanentId &&
          edge.to === source.id &&
          edge.kind === "derived_from",
      )
      expect(derived).toMatchObject({
        status: "current",
        disposable: false,
        recordedTargetHash: source.contentHash,
        currentTargetHash: source.contentHash,
      })

      nextSecond(fixture)
      const edited = await Effect.runPromise(
        fixture.repository.update({
          id: source.id,
          content: "A fact can become durable memory with a revision.",
        }),
      )
      const stale = await graph(fixture)
      expect(
        stale.edges.find(
          (edge) => edge.from === permanentId && edge.kind === "derived_from",
        ),
      ).toMatchObject({
        status: "stale",
        recordedTargetHash: source.contentHash,
        currentTargetHash: edited.contentHash,
      })

      const refreshed = await Effect.runPromise(
        (await makeWorker(fixture, (request) => {
          expect(request.candidates.map((candidate) => candidate.id)).toContain(
            permanentId,
          )
          return Effect.succeed({
            operations: [
              {
                operation: "update",
                candidateId: permanentId,
                title: "Durable fact",
                content: "A fact can become durable memory with a revision.",
                tags: [],
                sourceIds: [source.id],
              },
            ],
          })
        })).run(),
      )
      expect(refreshed.writes).toHaveLength(1)
      const current = await graph(fixture)
      expect(
        current.edges.find(
          (edge) => edge.from === permanentId && edge.kind === "derived_from",
        )?.status,
      ).toBe("current")

      await Effect.runPromise(fixture.repository.delete(source.id))
      const missing = await graph(fixture)
      expect(
        missing.edges.find(
          (edge) => edge.from === permanentId && edge.kind === "derived_from",
        ),
      ).toMatchObject({
        status: "missing",
        currentTargetHash: null,
      })
    } finally {
      cleanup(fixture)
    }
  })

  test("marks typed edges from a hand-edited generated note stale without removing recall eligibility", async () => {
    const fixture = await createFixture()
    try {
      const source = await createNote(
        fixture,
        "fleeting",
        "Owner evidence",
        "The evidence behind a generated assertion.",
      )
      const target = await createNote(
        fixture,
        "permanent",
        "Contradicted note",
        "A note the generated assertion disagrees with.",
      )
      const title = "Generated assertion"
      const content = "The generated assertion before a human edit."
      const marker = maintenanceMetadata({
        title,
        content,
        tags: [],
        sources: [{ id: source.id, contentHash: source.contentHash }],
        relations: [
          {
            kind: "contradicts",
            target: target.id,
            targetHash: target.contentHash,
            evidence: [
              { id: source.id, contentHash: source.contentHash },
            ],
          },
        ],
        generatedAt: "2026-11-20T09:00:00Z",
      })
      const generated = await createNote(
        fixture,
        "permanent",
        title,
        content,
        { [MAINTENANCE_METADATA_KEY]: marker },
      )

      const initial = await graph(fixture)
      expect(
        initial.edges
          .filter((edge) => edge.from === generated.id)
          .every((edge) => edge.status === "current"),
      ).toBe(true)
      expect(
        initial.nodes.find((node) => node.id === generated.id)?.managed,
      ).toBe(true)

      nextSecond(fixture)
      await Effect.runPromise(
        fixture.repository.update({
          id: generated.id,
          content: "A human rewrote the assertion.",
        }),
      )

      const edited = await graph(fixture)
      const outgoing = edited.edges.filter(
        (edge) => edge.from === generated.id && !edge.disposable,
      )
      expect(outgoing.length).toBeGreaterThanOrEqual(2)
      expect(outgoing.every((edge) => edge.status === "stale")).toBe(true)
      expect(
        edited.nodes.find((node) => node.id === generated.id)?.managed,
      ).toBe(false)

      // The marker remains durable evidence even though recall now treats the
      // note as a human-edited factual permanent rather than managed output.
      const note = await getNote(fixture, generated.id)
      expect(readMaintenanceMetadata(note)).not.toBeNull()
    } finally {
      cleanup(fixture)
    }
  })

  test("projects existing Markdown links as disposable and never trusts them", async () => {
    const fixture = await createFixture()
    try {
      const target = await createNote(
        fixture,
        "permanent",
        "Link target",
        "A target of an ordinary Markdown link.",
      )
      const linking = await createNote(
        fixture,
        "permanent",
        "Linking note",
        `This note references [[${target.id}]].`,
      )

      const projected = await graph(fixture)
      const link = projected.edges.find(
        (edge) => edge.from === linking.id && edge.to === target.id,
      )
      expect(link).toMatchObject({
        kind: "link",
        status: "current",
        disposable: true,
        recordedTargetHash: null,
        currentTargetHash: target.contentHash,
        evidence: [],
      })
      expect(
        projected.edges.filter((edge) => edge.kind === "link"),
      ).toHaveLength(1)
    } finally {
      cleanup(fixture)
    }
  })
})

describe("maintenance graph relation plans", () => {
  test("stores validated supersedes and contradicts evidence with target versions", async () => {
    const fixture = await createFixture()
    try {
      const firstSource = await createNote(
        fixture,
        "fleeting",
        "First evidence",
        "The first durable claim.",
      )
      const secondSource = await createNote(
        fixture,
        "fleeting",
        "Second evidence",
        "An older claim that will be superseded.",
      )
      const firstRun = await Effect.runPromise(
        (await makeWorker(
          fixture,
          createOnly(firstSource.id, "First claim", "The first durable claim."),
        )).run(),
      )
      const firstId = firstRun.writes[0]!.noteId
      const secondRun = await Effect.runPromise(
        (await makeWorker(
          fixture,
          createOnly(secondSource.id, "Second claim", "An older claim."),
        )).run(),
      )
      const secondId = secondRun.writes[0]!.noteId
      const secondNote = await getNote(fixture, secondId)

      const thirdSource = await createNote(
        fixture,
        "fleeting",
        "New evidence",
        "New evidence that supersedes one claim and contradicts another.",
      )

      const provider: MaintenanceProvider = () =>
        Effect.succeed({
          operations: [
            {
              operation: "update",
              candidateId: firstId,
              title: "First claim",
              content:
                "The first durable claim, now supported by newer evidence.",
              tags: [],
              sourceIds: [firstSource.id, thirdSource.id],
              relations: [
                {
                  kind: "supersedes",
                  target: secondId,
                  evidenceSourceIds: [thirdSource.id],
                },
                {
                  kind: "contradicts",
                  target: thirdSource.id,
                  evidenceSourceIds: [thirdSource.id],
                },
              ],
            },
          ],
        })

      const applied = await Effect.runPromise((await makeWorker(fixture, provider)).run())
      expect(applied.writes).toHaveLength(1)
      expect(applied.writes[0]?.relations).toEqual([
        { kind: "contradicts", target: thirdSource.id },
        { kind: "supersedes", target: secondId },
      ])

      const note = await getNote(fixture, firstId)
      const marker = readMaintenanceMetadata(note)
      expect(marker?.relations).toEqual([
        {
          kind: "contradicts",
          target: thirdSource.id,
          targetHash: thirdSource.contentHash,
          evidence: [
            { id: thirdSource.id, contentHash: thirdSource.contentHash },
          ],
        },
        {
          kind: "supersedes",
          target: secondId,
          targetHash: secondNote.contentHash,
          evidence: [
            { id: thirdSource.id, contentHash: thirdSource.contentHash },
          ],
        },
      ])

      const projected = await graph(fixture)
      expect(
        projected.edges.find(
          (edge) => edge.from === firstId && edge.kind === "supersedes",
        ),
      ).toMatchObject({
        to: secondId,
        status: "current",
        disposable: false,
        recordedTargetHash: secondNote.contentHash,
        currentTargetHash: secondNote.contentHash,
      })

      // Evidence is versioned too: changing only the source revision makes the
      // typed claim unverifiable even while the target still matches.
      nextSecond(fixture)
      await Effect.runPromise(
        fixture.repository.update({
          id: thirdSource.id,
          content: "A later revision of the supporting evidence.",
        }),
      )
      const evidenceMoved = await graph(fixture)
      expect(
        evidenceMoved.edges.find(
          (edge) => edge.from === firstId && edge.kind === "supersedes",
        )?.status,
      ).toBe("stale")

      nextSecond(fixture)
      await Effect.runPromise(
        fixture.repository.update({
          id: secondId,
          content: "A human rewrite of the superseded note.",
        }),
      )
      const invalidated = await graph(fixture)
      expect(
        invalidated.edges.find(
          (edge) => edge.from === firstId && edge.kind === "supersedes",
        )?.status,
      ).toBe("stale")
    } finally {
      cleanup(fixture)
    }
  })

  test("rejects targets and evidence outside the bounded snapshot without blocking consolidation", async () => {
    const fixture = await createFixture()
    try {
      const source = await createNote(
        fixture,
        "fleeting",
        "Bounded source",
        "Only this source was shown to the model.",
      )
      const manual = await createNote(
        fixture,
        "permanent",
        "Hidden manual note",
        "A permanent that was never offered as a candidate.",
      )

      const provider: MaintenanceProvider = () =>
        Effect.succeed({
          operations: [
            {
              operation: "create",
              title: "Bounded memory",
              content: "A safe consolidation of the supplied source.",
              tags: [],
              sourceIds: [source.id],
              relations: [
                {
                  kind: "supersedes",
                  target: manual.id,
                  evidenceSourceIds: [source.id],
                },
                {
                  kind: "contradicts",
                  target: "never-supplied",
                  evidenceSourceIds: [source.id],
                },
                {
                  kind: "supersedes",
                  target: source.id,
                  evidenceSourceIds: [source.id],
                },
                {
                  kind: "contradicts",
                  target: source.id,
                  evidenceSourceIds: ["not-a-source"],
                },
                {
                  kind: "implements",
                  target: source.id,
                  evidenceSourceIds: [source.id],
                },
              ],
            },
          ],
        })

      const result = await Effect.runPromise((await makeWorker(fixture, provider)).run())
      expect(result.writes).toHaveLength(1)
      expect(result.writes[0]?.relations).toBeUndefined()
      expect(
        result.skips.flatMap((skip) => skip.targetIds ?? []),
      ).toEqual([
        manual.id,
        "never-supplied",
        source.id,
        source.id,
      ])
      expect(
        result.skips.some((skip) =>
          skip.reason.includes("not supplied in the bounded maintenance snapshot"),
        ),
      ).toBe(true)
      expect(
        result.skips.some((skip) =>
          skip.reason.includes("supersedes target must be an eligible permanent"),
        ),
      ).toBe(true)
      expect(
        result.skips.some((skip) =>
          skip.reason.includes("read-only"),
        ),
      ).toBe(true)

      const note = await getNote(fixture, result.writes[0]!.noteId)
      expect(readMaintenanceMetadata(note)?.relations).toEqual([])
      const projected = await graph(fixture)
      expect(
        projected.edges.filter(
          (edge) =>
            edge.from === result.writes[0]!.noteId &&
            edge.kind !== "derived_from",
        ),
      ).toEqual([])
      expect((await getNote(fixture, manual.id)).body).toBe(
        "A permanent that was never offered as a candidate.",
      )
    } finally {
      cleanup(fixture)
    }
  })

  test("drops a relation whose target changed during the model call", async () => {
    const fixture = await createFixture()
    try {
      const firstSource = await createNote(
        fixture,
        "fleeting",
        "First source",
        "The first claim.",
      )
      const secondSource = await createNote(
        fixture,
        "fleeting",
        "Second source",
        "The claim that moves during the call.",
      )
      const firstRun = await Effect.runPromise(
        (await makeWorker(
          fixture,
          createOnly(firstSource.id, "First claim", "The first claim."),
        )).run(),
      )
      const firstId = firstRun.writes[0]!.noteId
      const secondRun = await Effect.runPromise(
        (await makeWorker(
          fixture,
          createOnly(secondSource.id, "Second claim", "The second claim."),
        )).run(),
      )
      const secondId = secondRun.writes[0]!.noteId

      const newSource = await createNote(
        fixture,
        "fleeting",
        "New source",
        "New evidence for the updated claim.",
      )

      const provider: MaintenanceProvider = () =>
        Effect.gen(function* () {
          yield* fixture.repository.update({
            id: secondId,
            content: "A human edit landed while the provider was running.",
          })
          return {
            operations: [
              {
                operation: "update",
                candidateId: firstId,
                title: "First claim",
                content: "The first claim with new evidence.",
                tags: [],
                sourceIds: [firstSource.id, newSource.id],
                relations: [
                  {
                    kind: "supersedes",
                    target: secondId,
                    evidenceSourceIds: [newSource.id],
                  },
                ],
              },
            ],
          }
        })

      const result = await Effect.runPromise((await makeWorker(fixture, provider)).run())
      expect(result.writes).toHaveLength(1)
      expect(result.writes[0]?.relations).toBeUndefined()
      expect(
        result.skips.some(
          (skip) =>
            skip.targetIds?.includes(secondId) === true &&
            skip.reason.includes("changed or disappeared"),
        ),
      ).toBe(true)

      const note = await getNote(fixture, firstId)
      expect(readMaintenanceMetadata(note)?.relations).toEqual([])
      const projected = await graph(fixture)
      expect(
        projected.edges.some(
          (edge) => edge.from === firstId && edge.kind === "supersedes",
        ),
      ).toBe(false)
      expect((await getNote(fixture, secondId)).body).toBe(
        "A human edit landed while the provider was running.",
      )
    } finally {
      cleanup(fixture)
    }
  })

  test("drops a relation that pins a candidate this same run rewrites", async () => {
    const fixture = await createFixture()
    try {
      const firstSource = await createNote(
        fixture,
        "fleeting",
        "First base",
        "The first base claim.",
      )
      const secondSource = await createNote(
        fixture,
        "fleeting",
        "Second base",
        "The second base claim.",
      )
      const firstId = (
        await Effect.runPromise(
          (await makeWorker(
            fixture,
            createOnly(firstSource.id, "First base", "The first base claim."),
          )).run(),
        )
      ).writes[0]!.noteId
      const secondId = (
        await Effect.runPromise(
          (await makeWorker(
            fixture,
            createOnly(secondSource.id, "Second base", "The second base claim."),
          )).run(),
        )
      ).writes[0]!.noteId

      const firstNew = await createNote(
        fixture,
        "fleeting",
        "First new",
        "New evidence for the first base claim.",
      )
      const secondNew = await createNote(
        fixture,
        "fleeting",
        "Second new",
        "New evidence for the second base claim.",
      )

      const provider: MaintenanceProvider = () =>
        Effect.succeed({
          operations: [
            {
              operation: "update",
              candidateId: firstId,
              title: "First base",
              content: "The first base claim with new evidence.",
              tags: [],
              sourceIds: [firstSource.id, firstNew.id],
              relations: [
                {
                  kind: "supersedes",
                  target: secondId,
                  evidenceSourceIds: [firstNew.id],
                },
              ],
            },
            {
              operation: "update",
              candidateId: secondId,
              title: "Second base",
              content: "The second base claim with new evidence.",
              tags: [],
              sourceIds: [secondSource.id, secondNew.id],
            },
          ],
        })

      const result = await Effect.runPromise((await makeWorker(fixture, provider)).run())
      expect(result.writes).toHaveLength(2)
      expect(result.writes[0]?.relations).toBeUndefined()
      expect(
        result.skips.some(
          (skip) =>
            skip.targetIds?.includes(secondId) === true &&
            skip.reason.includes("updated by another operation"),
        ),
      ).toBe(true)
      expect(
        readMaintenanceMetadata(await getNote(fixture, firstId))?.relations,
      ).toEqual([])
    } finally {
      cleanup(fixture)
    }
  })

  test("preserves foreign implements relations and never generates one", async () => {
    const fixture = await createFixture()
    try {
      const source = await createNote(
        fixture,
        "fleeting",
        "Initiative source",
        "Evidence owned by the initiative workflow.",
      )
      const target = await createNote(
        fixture,
        "permanent",
        "Initiative note",
        "A note owned by another workflow.",
      )
      const relation: MaintenanceRelation = {
        kind: "implements",
        target: target.id,
        targetHash: target.contentHash,
        evidence: [],
      }
      const marker = maintenanceMetadata({
        title: "Managed memory",
        content: "A generated note that also carries a foreign relation.",
        tags: [],
        sources: [
          { id: source.id, contentHash: source.contentHash },
        ],
        relations: [relation],
        generatedAt: "2026-11-20T09:00:00Z",
      })
      const managed = await createNote(
        fixture,
        "permanent",
        "Managed memory",
        "A generated note that also carries a foreign relation.",
        { [MAINTENANCE_METADATA_KEY]: marker },
      )

      const initial = await graph(fixture)
      expect(
        initial.edges.find(
          (edge) =>
            edge.from === managed.id &&
            edge.kind === "implements" &&
            edge.to === target.id,
        ),
      ).toMatchObject({
        status: "current",
        disposable: false,
        recordedTargetHash: target.contentHash,
      })

      nextSecond(fixture)
      await Effect.runPromise(
        fixture.repository.update({
          id: source.id,
          content: "A new revision of the initiative evidence.",
        }),
      )

      const provider: MaintenanceProvider = () =>
        Effect.succeed({
          operations: [
            {
              operation: "update",
              candidateId: managed.id,
              title: "Managed memory",
              content: "A generated note that also carries a foreign relation.",
              tags: [],
              sourceIds: [source.id],
              relations: [
                {
                  kind: "implements",
                  target: target.id,
                  evidenceSourceIds: [source.id],
                },
              ],
            },
          ],
        })

      const result = await Effect.runPromise((await makeWorker(fixture, provider)).run())
      expect(result.writes).toHaveLength(1)
      expect(
        result.skips.some((skip) =>
          skip.reason.includes("implements is read-only"),
        ),
      ).toBe(true)

      const after = await getNote(fixture, managed.id)
      expect(readMaintenanceMetadata(after)?.relations).toEqual([relation])
      const projected = await graph(fixture)
      expect(
        projected.edges.filter(
          (edge) => edge.from === managed.id && edge.kind === "implements",
        ),
      ).toHaveLength(1)
    } finally {
      cleanup(fixture)
    }
  })
})
