import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Markdown } from "./markdown.js"

const decodes = (
  schema: Schema.ConstraintDecoder<unknown>,
  input: unknown,
): boolean => Schema.decodeUnknownOption(schema)(input)._tag === "Some"

const omit = (
  input: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> => {
  const next = { ...input }
  delete next[key]
  return next
}

describe("note slugs and filenames", () => {
  test("normalizes titles to lowercase ASCII kebab-case", () => {
    expect(Markdown.slugifyTitle("Agent memory is bounded")).toBe(
      "agent-memory-is-bounded",
    )
    expect(Markdown.slugifyTitle("Café notes")).toBe("cafe-notes")
    expect(Markdown.slugifyTitle("  Hello,   World!  ")).toBe("hello-world")
    expect(Markdown.slugifyTitle("!!!")).toBe("untitled")
    expect(Markdown.slugifyTitle("日本語")).toBe("untitled")
  })

  test("truncates long titles on a hyphen boundary within 80 characters", () => {
    const slug = Markdown.slugifyTitle("word ".repeat(30))

    expect(slug.length).toBeLessThanOrEqual(80)
    expect(slug.startsWith("word-word")).toBe(true)
    expect(slug.endsWith("-")).toBe(false)
  })

  test("formats UTC timestamps without milliseconds", () => {
    expect(
      Markdown.toUtcTimestamp(Date.parse("2026-11-17T19:30:45.999Z")),
    ).toEqual({
      filenamePrefix: "20261117193045",
      isoTimestamp: "2026-11-17T19:30:45Z",
    })
    expect(() => Markdown.toUtcTimestamp(Number.NaN)).toThrow(RangeError)
  })

  test("parses only real UTC filename prefixes", () => {
    expect(Markdown.parseUtcPrefix("20261117193045")?.toISOString()).toBe(
      "2026-11-17T19:30:45.000Z",
    )
    expect(Markdown.parseUtcPrefix("20261317193045")).toBeNull()
    expect(Markdown.parseUtcPrefix("20260230193045")).toBeNull()
    expect(Markdown.parseUtcPrefix("2026111719304")).toBeNull()
  })

  test("builds descriptive filenames and resolves collisions", () => {
    expect(Markdown.noteFilename({ title: "Café notes" })).toBe("cafe-notes.md")
    expect(
      Markdown.noteFilename({
        title: "Café notes",
        taken: ["cafe-notes.md"],
      }),
    ).toBe("cafe-notes-2.md")
    expect(
      Markdown.noteFilename({
        title: "Café notes",
        taken: ["cafe-notes.md", "cafe-notes-2.md"],
      }),
    ).toBe("cafe-notes-3.md")
  })

  test("never generates a legacy-looking filename for a date-prefixed title", () => {
    // An impossible timestamp prefix used to produce a filename that
    // `isNoteFilename` rejected, so creation could generate an unreadable note.
    const impossible = Markdown.noteFilename({
      title: "20260230193045 impossible date",
    })
    expect(impossible).toBe("note-20260230193045-impossible-date.md")
    expect(Markdown.isNoteFilename(impossible)).toBe(true)
    expect(Markdown.isNoteId(impossible.slice(0, -".md".length))).toBe(true)
    expect(
      Markdown.isNoteIdWithRealTimestamp(impossible.slice(0, -".md".length)),
    ).toBe(false)

    // A real-looking prefix is also ambiguous: a new note should keep its
    // creation time in frontmatter, not claim it in the filename.
    const realLooking = Markdown.noteFilename({
      title: "20261117193045 retrospective",
    })
    expect(realLooking).toBe("note-20261117193045-retrospective.md")
    expect(Markdown.isNoteFilename(realLooking)).toBe(true)
    expect(
      Markdown.isNoteIdWithRealTimestamp(realLooking.slice(0, -".md".length)),
    ).toBe(false)

    // Collision resolution still applies to the deterministic fallback.
    expect(
      Markdown.noteFilename({
        title: "20260230193045 impossible date",
        taken: ["note-20260230193045-impossible-date.md"],
      }),
    ).toBe("note-20260230193045-impossible-date-2.md")
  })

  test("accepts descriptive and legacy timestamp-prefixed note filenames", () => {
    expect(Markdown.isNoteFilename("agent-memory-is-bounded.md")).toBe(true)
    expect(
      Markdown.isNoteFilename("20261117193045-agent-memory-is-bounded.md"),
    ).toBe(true)
    expect(Markdown.isNoteFilename("20261117193045-Bad-Uppercase.md")).toBe(false)
    expect(Markdown.isNoteFilename("20261117193045-bad_underscore.md")).toBe(false)
    expect(Markdown.isNoteFilename("20260230193045-impossible-date.md")).toBe(false)
    expect(Markdown.isNoteFilename("../escape.md")).toBe(false)
    expect(Markdown.isNoteFilename("note.txt")).toBe(false)
    expect(Markdown.noteIdFromFilename("agent-memory-is-bounded.md")).toBe(
      "agent-memory-is-bounded",
    )
    expect(
      Markdown.noteIdFromFilename("20261117193045-agent-memory-is-bounded.md"),
    ).toBe("20261117193045-agent-memory-is-bounded")
    expect(Markdown.noteIdFromFilename("bad_name.md")).toBeNull()
  })

  test("extracts the title slug from both ID shapes", () => {
    expect(Markdown.noteSlugFromId("agent-memory-is-bounded")).toBe(
      "agent-memory-is-bounded",
    )
    expect(
      Markdown.noteSlugFromId("20261117193045-agent-memory-is-bounded"),
    ).toBe("agent-memory-is-bounded")
  })
})

describe("tag slug normalization", () => {
  test("uses the same ASCII kebab-case pipeline as note slugs", () => {
    expect(Markdown.slugifyTag("Agent Memory")).toBe("agent-memory")
    expect(Markdown.slugifyTag("Café & MCP")).toBe("cafe-mcp")
    expect(Markdown.slugifyTag("  retrieval  ")).toBe("retrieval")
    expect(Markdown.slugifyTag("日本語")).toBe("")
  })

  test("enforces the published tag shape", () => {
    expect(Markdown.isTagSlug("agent-memory")).toBe(true)
    expect(Markdown.isTagSlug("agent_memory")).toBe(false)
    expect(Markdown.isTagSlug("Agent-Memory")).toBe(false)
    expect(Markdown.isTagSlug("-agent-memory")).toBe(false)
    expect(Markdown.isTagSlug("")).toBe(false)
    expect(Markdown.isTagSlug("a".repeat(65))).toBe(false)
  })

  test("TagSlug rejects values beyond the 64-character limit", () => {
    expect(decodes(Markdown.TagSlug, "a".repeat(64))).toBe(true)
    expect(decodes(Markdown.TagSlug, "a".repeat(65))).toBe(false)
    expect(decodes(Markdown.TagSlug, `${"a".repeat(31)}-${"b".repeat(32)}`)).toBe(
      true,
    )
  })
})

describe("UTC timestamp and note ID schemas", () => {
  test("Timestamp accepts canonical whole-second UTC instants", () => {
    expect(decodes(Markdown.Timestamp, "2026-11-17T19:30:45Z")).toBe(true)
    expect(decodes(Markdown.Timestamp, "2024-02-29T00:00:00Z")).toBe(true)
  })

  test("Timestamp rejects impossible calendar dates and times", () => {
    expect(decodes(Markdown.Timestamp, "2026-02-30T19:30:45Z")).toBe(false)
    expect(decodes(Markdown.Timestamp, "2026-13-01T00:00:00Z")).toBe(false)
    expect(decodes(Markdown.Timestamp, "2026-11-17T24:00:00Z")).toBe(false)
    expect(decodes(Markdown.Timestamp, "2026-11-17T19:60:00Z")).toBe(false)
    expect(decodes(Markdown.Timestamp, "2026-11-17T19:30:60Z")).toBe(false)
    expect(decodes(Markdown.Timestamp, "2026-11-17T19:30:45.000Z")).toBe(false)
    expect(decodes(Markdown.Timestamp, "2026-11-17T19:30:45")).toBe(false)
  })

  test("NoteId accepts descriptive slugs and rejects an impossible timestamp prefix", () => {
    expect(decodes(Markdown.NoteId, "agent-memory-is-bounded")).toBe(true)
    expect(
      decodes(Markdown.NoteId, "20261117193045-agent-memory-is-bounded"),
    ).toBe(true)
    expect(
      decodes(Markdown.NoteId, "20260230193045-agent-memory-is-bounded"),
    ).toBe(false)
    expect(
      decodes(Markdown.NoteId, "20261301193045-agent-memory-is-bounded"),
    ).toBe(false)
    expect(Markdown.isNoteIdWithRealTimestamp("20260230193045-agent-memory")).toBe(
      false,
    )
  })
})

describe("canonical note projection", () => {
  const base = {
    id: "agent-memory-is-bounded",
    title: "Agent memory is bounded",
    content: "Body.",
    createdAt: 1_763_407_845_000,
    updatedAt: 1_763_407_902_000,
  }

  test("decodes each note kind with the legacy wire shape", () => {
    expect(decodes(Markdown.NoteProjection, { ...base, type: "fleeting" })).toBe(
      true,
    )
    expect(decodes(Markdown.NoteProjection, { ...base, type: "permanent" })).toBe(
      true,
    )
    expect(
      decodes(Markdown.NoteProjection, {
        ...base,
        type: "literature",
        reference: "Book",
      }),
    ).toBe(true)
    expect(
      decodes(Markdown.NoteProjection, {
        ...base,
        type: "literature",
      }),
    ).toBe(false)
    expect(decodes(Markdown.NoteProjection, { ...base, type: "unknown" })).toBe(
      false,
    )
  })
})

describe("Markdown contract schemas", () => {
  const metadata = {
    schema: 1,
    id: "20261117193045-agent-memory-is-bounded",
    type: "permanent",
    title: "Agent memory is bounded",
    createdAt: "2026-11-17T19:30:45Z",
    updatedAt: "2026-11-17T19:35:02Z",
    tags: ["agent-memory", "retrieval"],
    provenance: { source: "cli", actor: "user" },
  }

  test("decodes complete note metadata", () => {
    expect(decodes(Markdown.NoteMetadata, metadata)).toBe(true)
    expect(
      decodes(Markdown.NoteMetadata, { ...metadata, futureField: "preserved" }),
    ).toBe(true)

    // Decoding validates but does not preserve unknown keys; the repository
    // parser keeps the raw mapping and re-emits it on render.
    const decoded = Schema.decodeUnknownOption(Markdown.NoteMetadata)({
      ...metadata,
      futureField: "preserved",
    })
    expect(decoded._tag).toBe("Some")
    if (decoded._tag === "Some") {
      expect("futureField" in decoded.value).toBe(false)
    }
  })

  test("rejects invalid note metadata", () => {
    expect(decodes(Markdown.NoteMetadata, { ...metadata, schema: 2 })).toBe(false)
    expect(decodes(Markdown.NoteMetadata, { ...metadata, id: "Not-An-Id" })).toBe(
      false,
    )
    expect(decodes(Markdown.NoteMetadata, { ...metadata, type: "unknown" })).toBe(
      false,
    )
    expect(decodes(Markdown.NoteMetadata, { ...metadata, title: "   " })).toBe(false)
    expect(
      decodes(Markdown.NoteMetadata, {
        ...metadata,
        createdAt: "2026-11-17T19:30:45.000Z",
      }),
    ).toBe(false)
    expect(
      decodes(Markdown.NoteMetadata, { ...metadata, tags: ["Agent Memory"] }),
    ).toBe(false)
    expect(
      decodes(Markdown.NoteMetadata, {
        ...metadata,
        createdAt: "2026-02-30T19:30:45Z",
      }),
    ).toBe(false)
    expect(
      decodes(Markdown.NoteMetadata, {
        ...metadata,
        id: "20260230193045-agent-memory-is-bounded",
      }),
    ).toBe(false)
  })

  test("requires updatedAt to be at least createdAt", () => {
    expect(
      decodes(Markdown.NoteMetadata, {
        ...metadata,
        updatedAt: "2026-11-17T19:30:44Z",
      }),
    ).toBe(false)
    expect(
      decodes(Markdown.NoteMetadata, {
        ...metadata,
        updatedAt: metadata.createdAt,
      }),
    ).toBe(true)
  })

  test("requires a non-blank reference for literature notes only", () => {
    const literature = {
      ...metadata,
      type: "literature" as const,
      reference: "https://example.com/source",
    }

    expect(decodes(Markdown.NoteMetadata, literature)).toBe(true)

    const withoutReference: { reference?: string } = { ...literature }
    delete withoutReference.reference
    expect(decodes(Markdown.NoteMetadata, withoutReference)).toBe(false)
    expect(
      decodes(Markdown.NoteMetadata, { ...literature, reference: "   " }),
    ).toBe(false)
    expect(
      decodes(Markdown.NoteMetadata, { ...metadata, reference: "   " }),
    ).toBe(false)
  })

  test("decodes structured wiki output with citations", () => {
    const page = {
      tag: "agent-memory",
      generatedAt: "2026-11-17T20:10:00Z",
      mode: "extractive",
      noteCount: 1,
      sources: [
        {
          id: "20261117193045-agent-memory-is-bounded",
          path: ".slipmem/20261117193045-agent-memory-is-bounded.md",
          type: "permanent",
          title: "Agent memory is bounded",
          updatedAt: "2026-11-17T19:35:02Z",
        },
      ],
      sections: [
        {
          heading: "Bounded recall",
          markdown: "> Every recall operation is bounded.",
          citations: [
            {
              noteId: "20261117193045-agent-memory-is-bounded",
              path: ".slipmem/20261117193045-agent-memory-is-bounded.md",
              excerpt: "Every recall operation is bounded.",
            },
          ],
        },
      ],
      markdown: "# Tag: agent memory\n",
    }

    expect(decodes(Markdown.WikiPage, page)).toBe(true)
    expect(decodes(Markdown.WikiPage, { ...page, mode: "invented" })).toBe(false)
  })

  test("rejects uncited sections and blank citation targets", () => {
    const section = {
      heading: "Bounded recall",
      markdown: "> Every recall operation is bounded.",
      citations: [
        {
          noteId: "20261117193045-agent-memory-is-bounded",
          path: ".slipmem/20261117193045-agent-memory-is-bounded.md",
        },
      ],
    }

    expect(decodes(Markdown.WikiSection, section)).toBe(true)
    expect(
      decodes(Markdown.WikiSection, { ...section, citations: [] }),
    ).toBe(false)
    expect(decodes(Markdown.WikiSection, { ...section, heading: "   " })).toBe(
      false,
    )
    expect(decodes(Markdown.WikiSection, { ...section, markdown: "" })).toBe(false)
    expect(
      decodes(Markdown.WikiSection, {
        ...section,
        citations: [{ ...section.citations[0], path: "  " }],
      }),
    ).toBe(false)
  })

  test("bounds wiki page counts and source fields", () => {
    const page = {
      tag: "agent-memory",
      generatedAt: "2026-11-17T20:10:00Z",
      mode: "extractive",
      noteCount: 0,
      sources: [],
      sections: [],
      markdown: "# Tag: agent-memory\n",
    }

    expect(decodes(Markdown.WikiPage, page)).toBe(true)
    expect(decodes(Markdown.WikiPage, { ...page, noteCount: -1 })).toBe(false)
    expect(
      decodes(Markdown.WikiPage, {
        ...page,
        noteCount: Markdown.MAX_WIKI_LIMIT + 1,
      }),
    ).toBe(false)
    expect(decodes(Markdown.WikiPage, { ...page, noteCount: 1.5 })).toBe(false)
    expect(
      decodes(Markdown.WikiPage, {
        ...page,
        sources: [
          {
            id: "20261117193045-agent-memory-is-bounded",
            path: "",
            type: "permanent",
            title: "Agent memory is bounded",
            updatedAt: "2026-11-17T19:35:02Z",
          },
        ],
      }),
    ).toBe(false)
  })

  test("WikiInput bounds the note limit", () => {
    expect(decodes(Markdown.WikiInput, { tag: "agent-memory" })).toBe(true)
    expect(decodes(Markdown.WikiInput, { tag: "agent-memory", limit: 1 })).toBe(
      true,
    )
    expect(
      decodes(Markdown.WikiInput, {
        tag: "agent-memory",
        limit: Markdown.MAX_WIKI_LIMIT,
      }),
    ).toBe(true)
    expect(decodes(Markdown.WikiInput, { tag: "agent-memory", limit: 0 })).toBe(
      false,
    )
    expect(
      decodes(Markdown.WikiInput, {
        tag: "agent-memory",
        limit: Markdown.MAX_WIKI_LIMIT + 1,
      }),
    ).toBe(false)
    expect(decodes(Markdown.WikiInput, { tag: "a".repeat(65) })).toBe(false)
  })

  test("decodes MCP approval proposals and rejects self-approval sources", () => {
    const proposal = {
      id: "proposal-1",
      createdAt: "2026-11-17T20:10:00Z",
      expiresAt: "2026-11-24T20:10:00Z",
      operation: "create",
      noteId: "20261117193045-agent-memory-is-bounded",
      path: ".slipmem/20261117193045-agent-memory-is-bounded.md",
      content: "---\n",
      actor: "agent",
      source: "mcp",
      summary: "Create a permanent note.",
    }

    expect(decodes(Markdown.ApprovalProposal, proposal)).toBe(true)
    expect(
      decodes(Markdown.ApprovalProposal, { ...proposal, source: "human" }),
    ).toBe(false)
    expect(
      decodes(Markdown.ApprovalProposal, { ...proposal, operation: "approve" }),
    ).toBe(false)
  })

  test("requires operation-specific proposal fields", () => {
    const target = {
      id: "proposal-1",
      createdAt: "2026-11-17T20:10:00Z",
      expiresAt: "2026-11-24T20:10:00Z",
      noteId: "20261117193045-agent-memory-is-bounded",
      path: ".slipmem/20261117193045-agent-memory-is-bounded.md",
      actor: "agent",
      source: "mcp",
      summary: "Change a permanent note.",
    }

    const create = {
      ...target,
      operation: "create",
      content: "---\n",
    }
    const update = {
      ...target,
      operation: "update",
      baseHash: "abc123",
      content: "---\n",
    }
    const remove = {
      ...target,
      operation: "delete",
      baseHash: "abc123",
    }
    const reclassify = {
      ...target,
      operation: "reclassify",
      baseHash: "abc123",
      content: "---\n",
    }

    expect(decodes(Markdown.ApprovalProposal, create)).toBe(true)
    expect(decodes(Markdown.ApprovalProposal, update)).toBe(true)
    expect(decodes(Markdown.ApprovalProposal, remove)).toBe(true)
    expect(decodes(Markdown.ApprovalProposal, reclassify)).toBe(true)

    expect(decodes(Markdown.ApprovalProposal, omit(create, "content"))).toBe(false)
    expect(decodes(Markdown.ApprovalProposal, omit(create, "noteId"))).toBe(false)
    expect(decodes(Markdown.ApprovalProposal, omit(create, "path"))).toBe(false)
    expect(decodes(Markdown.ApprovalProposal, omit(update, "baseHash"))).toBe(
      false,
    )
    expect(decodes(Markdown.ApprovalProposal, omit(update, "content"))).toBe(false)
    expect(decodes(Markdown.ApprovalProposal, omit(remove, "baseHash"))).toBe(
      false,
    )
    expect(decodes(Markdown.ApprovalProposal, omit(reclassify, "content"))).toBe(
      false,
    )
    expect(
      decodes(Markdown.ApprovalProposal, {
        ...create,
        expiresAt: "2026-11-17T20:09:59Z",
      }),
    ).toBe(false)
    expect(
      decodes(Markdown.ApprovalProposal, {
        ...create,
        createdAt: "2026-02-30T20:10:00Z",
      }),
    ).toBe(false)
    expect(decodes(Markdown.ApprovalProposal, { ...create, summary: "  " })).toBe(
      false,
    )
  })
})
