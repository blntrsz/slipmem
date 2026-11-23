import { describe, expect, test } from "bun:test"
import {
  aggregateTagInventory,
  emptyTagTypeCounts,
  type TagInventoryNote,
} from "./inventory.js"

const note = (
  id: string,
  type: TagInventoryNote["metadata"]["type"],
  tags: ReadonlyArray<string>,
  title = id,
): TagInventoryNote => ({
  id,
  metadata: { type, title, tags },
})

describe("tag inventory aggregation", () => {
  test("counts tags by type and keeps the first examples in note order", () => {
    const notes = [
      note("newest", "permanent", ["shared", "recall"]),
      note("middle", "literature", ["shared"]),
      note("oldest", "fleeting", ["shared", "inbox"]),
    ]

    expect(aggregateTagInventory(notes, { maxExamples: 2 })).toEqual([
      {
        tag: "shared",
        noteCount: 3,
        byType: { fleeting: 1, literature: 1, permanent: 1 },
        examples: [
          { id: "newest", type: "permanent", title: "newest" },
          { id: "middle", type: "literature", title: "middle" },
        ],
      },
      {
        tag: "inbox",
        noteCount: 1,
        byType: { fleeting: 1, literature: 0, permanent: 0 },
        examples: [{ id: "oldest", type: "fleeting", title: "oldest" }],
      },
      {
        tag: "recall",
        noteCount: 1,
        byType: { fleeting: 0, literature: 0, permanent: 1 },
        examples: [{ id: "newest", type: "permanent", title: "newest" }],
      },
    ])
  })

  test("filters by normalized substring and bounds the ordered result", () => {
    const notes = [
      note("permanent", "permanent", ["recall", "shared"]),
      note("fleeting", "fleeting", ["recent", "recall"]),
      note("literature", "literature", ["recall"]),
    ]

    expect(
      aggregateTagInventory(notes, { query: "rec", limit: 1, maxExamples: 0 }),
    ).toEqual([
      {
        tag: "recall",
        noteCount: 3,
        byType: { fleeting: 1, literature: 1, permanent: 1 },
        examples: [],
      },
    ])
  })

  test("returns a fresh zero breakdown", () => {
    const first = emptyTagTypeCounts()
    const second = emptyTagTypeCounts()

    expect(first).toEqual({ fleeting: 0, literature: 0, permanent: 0 })
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
  })
})
