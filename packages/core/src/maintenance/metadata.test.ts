import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { ParsedMarkdownNote } from "../markdown/note-document.js"
import {
  MAINTENANCE_METADATA_KEY,
  managedPermanentMetadata,
  managedStateHash,
  maintenanceMetadata,
  readMaintenanceMetadata,
  type MaintenanceRelation,
  type MaintenanceSourceRef,
} from "./index.js"

const source: MaintenanceSourceRef = {
  id: "source-note",
  contentHash: "a".repeat(64),
}

const note = (
  title: string,
  content: string,
  unknown: Readonly<Record<string, unknown>>,
  tags: ReadonlyArray<string> = [],
): Pick<ParsedMarkdownNote, "metadata" | "body" | "unknown"> =>
  ({
    metadata: { title, tags },
    body: content,
    unknown,
  }) as unknown as Pick<ParsedMarkdownNote, "metadata" | "body" | "unknown">

const legacyStateHash = (
  title: string,
  content: string,
  tags: ReadonlyArray<string>,
  sources: ReadonlyArray<MaintenanceSourceRef>,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        title: title.trim(),
        content: content.trim(),
        tags,
        sources: [...sources].sort((left, right) =>
          left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
        ),
      }),
      "utf8",
    )
    .digest("hex")

const versionOneMarker = (
  title: string,
  content: string,
  tags: ReadonlyArray<string> = [],
) => ({
  [MAINTENANCE_METADATA_KEY]: {
    version: 1,
    generatedAt: "2026-11-20T09:00:00Z",
    stateHash: legacyStateHash(title, content, tags, [source]),
    sources: [source],
  },
})

describe("maintenance metadata versions", () => {
  test("reads a version 1 marker without relations and keeps it managed", () => {
    const value = note(
      "Legacy memory",
      "A generated permanent from before typed relations.",
      versionOneMarker("Legacy memory", "A generated permanent from before typed relations."),
    )

    const metadata = readMaintenanceMetadata(value)
    expect(metadata).toMatchObject({
      version: 1,
      sources: [source],
      relations: [],
    })
    expect(managedPermanentMetadata(value)).not.toBeNull()
  })

  test("a version 1 marker cannot smuggle in an unhased relation", () => {
    const marker = versionOneMarker("Legacy memory", "Body.")[MAINTENANCE_METADATA_KEY]
    const value = note("Legacy memory", "Body.", {
      [MAINTENANCE_METADATA_KEY]: {
        ...marker,
        relations: [
          {
            kind: "implements",
            target: "initiative-note",
            targetHash: "b".repeat(64),
            evidence: [],
          },
        ],
      },
    })

    expect(readMaintenanceMetadata(value)?.relations).toEqual([])
    expect(managedPermanentMetadata(value)).not.toBeNull()
  })

  test("version 2 stores canonical relation evidence but stays compatible when empty", () => {
    const empty = maintenanceMetadata({
      title: "Memory",
      content: "Body.",
      tags: [],
      sources: [source],
      generatedAt: "2026-11-20T09:00:00Z",
    })
    expect(empty.version).toBe(2)
    expect(empty.relations).toEqual([])
    expect(empty.stateHash).toBe(
      legacyStateHash("Memory", "Body.", [], [source]),
    )

    const relation: MaintenanceRelation = {
      kind: "contradicts",
      target: "other-note",
      targetHash: "b".repeat(64),
      evidence: [source],
    }
    const metadata = maintenanceMetadata({
      title: "Memory",
      content: "Body.",
      tags: [],
      sources: [source],
      relations: [relation],
      generatedAt: "2026-11-20T09:00:00Z",
    })
    expect(metadata.stateHash).not.toBe(empty.stateHash)
    expect(metadata.stateHash).toBe(managedStateHash({
      title: "Memory",
      content: "Body.",
      tags: [],
      sources: [source],
      relations: [relation],
    }))

    const value = note("Memory", "Body.", {
      [MAINTENANCE_METADATA_KEY]: metadata,
    })
    expect(readMaintenanceMetadata(value)?.relations).toEqual([relation])
    expect(managedPermanentMetadata(value)?.relations).toEqual([relation])
  })

  test("canonicalizes relation evidence so YAML list order cannot break ownership", () => {
    const secondSource: MaintenanceSourceRef = {
      id: "another-source",
      contentHash: "c".repeat(64),
    }
    const metadata = maintenanceMetadata({
      title: "Memory",
      content: "Body.",
      tags: [],
      sources: [source],
      relations: [
        {
          kind: "contradicts",
          target: "other-note",
          targetHash: "b".repeat(64),
          evidence: [source, secondSource],
        },
      ],
      generatedAt: "2026-11-20T09:00:00Z",
    })
    expect(metadata.relations[0]?.evidence.map((item) => item.id)).toEqual([
      "another-source",
      "source-note",
    ])

    const value = note("Memory", "Body.", {
      [MAINTENANCE_METADATA_KEY]: metadata,
    })
    expect(managedPermanentMetadata(value)).not.toBeNull()
  })

  test("a tampered version 2 relation is readable evidence but not managed state", () => {
    const metadata = maintenanceMetadata({
      title: "Memory",
      content: "Body.",
      tags: [],
      sources: [source],
      relations: [
        {
          kind: "supersedes",
          target: "old-note",
          targetHash: "b".repeat(64),
          evidence: [source],
        },
      ],
      generatedAt: "2026-11-20T09:00:00Z",
    })
    const value = note("Memory", "Body.", {
      [MAINTENANCE_METADATA_KEY]: {
        ...metadata,
        relations: [
          {
            ...metadata.relations[0]!,
            target: "attacker-chosen-note",
          },
        ],
      },
    })

    expect(readMaintenanceMetadata(value)?.relations[0]?.target).toBe(
      "attacker-chosen-note",
    )
    expect(managedPermanentMetadata(value)).toBeNull()
  })

  test("malformed relation targets or hashes invalidate the marker", () => {
    const metadata = maintenanceMetadata({
      title: "Memory",
      content: "Body.",
      tags: [],
      sources: [source],
      generatedAt: "2026-11-20T09:00:00Z",
    })

    for (const relations of [
      [{ kind: "supersedes", target: "../escape", targetHash: "b".repeat(64), evidence: [source] }],
      [{ kind: "supersedes", target: "old-note", targetHash: "short", evidence: [source] }],
      [{ kind: "supersedes", target: "old-note", targetHash: "b".repeat(64), evidence: [] }],
      [{ kind: "derived_from", target: "old-note", targetHash: "b".repeat(64), evidence: [source] }],
    ]) {
      const value = note("Memory", "Body.", {
        [MAINTENANCE_METADATA_KEY]: { ...metadata, relations },
      })
      expect(readMaintenanceMetadata(value)).toBeNull()
    }
  })

  test("a future metadata version is not interpreted", () => {
    const metadata = maintenanceMetadata({
      title: "Memory",
      content: "Body.",
      tags: [],
      sources: [source],
      generatedAt: "2026-11-20T09:00:00Z",
    })
    const value = note("Memory", "Body.", {
      [MAINTENANCE_METADATA_KEY]: { ...metadata, version: 99 },
    })
    expect(readMaintenanceMetadata(value)).toBeNull()
  })
})
