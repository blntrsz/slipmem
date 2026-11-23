import type { Markdown } from "@slipmem/schemas/markdown"

/**
 * The minimal note shape the pure tag aggregation needs. `ParsedMarkdownNote`
 * is structurally assignable, so callers can pass repository scan results
 * directly without constructing a projection or touching the index.
 */
export interface TagInventoryNote {
  readonly id: string
  readonly metadata: {
    readonly type: Markdown.NoteType
    readonly title: string
    readonly tags?: ReadonlyArray<string> | undefined
  }
}

export interface TagTypeCounts {
  readonly fleeting: number
  readonly literature: number
  readonly permanent: number
}

export interface TagInventoryExample {
  readonly id: string
  readonly type: Markdown.NoteType
  readonly title: string
}

export interface TagInventoryEntry {
  readonly tag: string
  readonly noteCount: number
  readonly byType: TagTypeCounts
  readonly examples: ReadonlyArray<TagInventoryExample>
}

export interface TagInventoryOptions {
  /**
   * Normalized tag fragment. An empty or omitted value includes every tag.
   * Callers that accept user text normalize it with `Markdown.slugifyTag` and
   * reject a value that normalizes to an empty slug before calling.
   */
  readonly query?: string
  /** Maximum tags returned after count-desc, tag-asc ordering. */
  readonly limit?: number
  /** Examples retained per tag, in note order. Defaults to none. */
  readonly maxExamples?: number
}

type MutableTagTypeCounts = {
  fleeting: number
  literature: number
  permanent: number
}

const emptyCounts = (): MutableTagTypeCounts => ({
  fleeting: 0,
  literature: 0,
  permanent: 0,
})

/** A fresh all-zero breakdown, safe to place in a response. */
export const emptyTagTypeCounts = (): TagTypeCounts => emptyCounts()

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const boundedCount = (value: number | undefined): number | undefined =>
  value === undefined ? undefined : Math.max(0, Math.trunc(value))

/**
 * Pure tag inventory aggregation shared by HTTP and MCP.
 *
 * Counts every tag occurrence in note order and breaks each tag down by note
 * type. Examples are the first `maxExamples` notes for the tag in input order,
 * which keeps them deterministic and makes repository scan order authoritative.
 * The caller owns index refresh, filtering, and cache behavior; this function
 * never reads files or touches the index.
 */
export const aggregateTagInventory = (
  notes: ReadonlyArray<TagInventoryNote>,
  options: TagInventoryOptions = {},
): ReadonlyArray<TagInventoryEntry> => {
  const query = options.query ?? ""
  const maxExamples = boundedCount(options.maxExamples) ?? 0
  const summaries = new Map<
    string,
    {
      noteCount: number
      byType: MutableTagTypeCounts
      examples: TagInventoryExample[]
    }
  >()

  for (const note of notes) {
    for (const tag of note.metadata.tags ?? []) {
      if (query !== "" && !tag.includes(query)) {
        continue
      }
      const summary = summaries.get(tag) ?? {
        noteCount: 0,
        byType: emptyCounts(),
        examples: [],
      }
      summary.noteCount += 1
      summary.byType[note.metadata.type] += 1
      if (summary.examples.length < maxExamples) {
        summary.examples.push({
          id: note.id,
          type: note.metadata.type,
          title: note.metadata.title,
        })
      }
      summaries.set(tag, summary)
    }
  }

  const entries = [...summaries.entries()]
    .map(([tag, summary]) => ({ tag, ...summary }))
    .sort(
      (left, right) =>
        right.noteCount - left.noteCount ||
        compareText(left.tag, right.tag),
    )

  const limit = boundedCount(options.limit)
  return limit === undefined ? entries : entries.slice(0, limit)
}
