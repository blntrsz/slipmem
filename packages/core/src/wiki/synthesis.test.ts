import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ParsedMarkdownNote } from "../markdown/note-document.js"
import {
  extractiveSourceSpan,
  isExtractiveSupport,
  sourceParagraphSpans,
  validateSynthesisOutput,
} from "./synthesis.js"

const note = (body: string): ParsedMarkdownNote =>
  ({ id: "20261117213000-note", body }) as unknown as ParsedMarkdownNote

const validate = (sentences: ReadonlyArray<unknown>, body: string) =>
  Effect.runPromise(validateSynthesisOutput({ sentences }, [note(body)]))

describe("extractive paragraph support equality", () => {
  test("accepts the complete exact source paragraph", () => {
    expect(
      isExtractiveSupport(
        "Caching is not dangerous for this workload.",
        "Caching is not dangerous for this workload.",
        "Caching is not dangerous for this workload.",
      ),
    ).toBe(true)
    expect(
      isExtractiveSupport(
        "\u201cCaching is safe.\u201d",
        "Caching is safe.",
        "Caching is safe.",
      ),
    ).toBe(true)
  })

  test("accepts a full paragraph containing multiple source sentences", () => {
    const body =
      "Caching is not dangerous for this workload. Deleting is safe only after a verified backup."
    expect(isExtractiveSupport(body, body, body)).toBe(true)
    // Newline wrapping in the source is harmless; the paragraph is identical.
    expect(
      isExtractiveSupport(
        "Deleting is safe only after a verified backup. Caching is bounded.",
        "Deleting is safe only after a verified backup. Caching is bounded.",
        "Deleting is safe only after a verified backup.\nCaching is bounded.",
      ),
    ).toBe(true)
  })

  test("rejects a sentence or clipped fragment inside a paragraph", () => {
    const body =
      "Caching is not dangerous for this workload. Deleting is safe only after a verified backup."
    expect(
      isExtractiveSupport(
        "Caching is not dangerous for this workload.",
        "Caching is not dangerous for this workload.",
        body,
      ),
    ).toBe(false)
    expect(
      isExtractiveSupport(
        "dangerous for this workload.",
        "dangerous for this workload.",
        "Caching is not dangerous for this workload.",
      ),
    ).toBe(false)
    expect(
      isExtractiveSupport(
        "Deleting is safe.",
        "Deleting is safe",
        "Deleting is safe only after a verified backup.",
      ),
    ).toBe(false)
  })

  test("does not strip terminal punctuation", () => {
    const body = "Deleting is safe only after a verified backup."
    expect(
      isExtractiveSupport(
        "Deleting is safe only after a verified backup",
        "Deleting is safe only after a verified backup",
        body,
      ),
    ).toBe(false)
    expect(
      isExtractiveSupport(
        "Deleting is safe only after a verified backup.",
        "Deleting is safe only after a verified backup.",
        body,
      ),
    ).toBe(true)
  })

  test("rejects concrete ellipsis, parenthetical, and abbreviation clips", () => {
    const clips: ReadonlyArray<readonly [string, string]> = [
      ["Deleting is safe... only after verified backup.", "Deleting is safe."],
      [
        "Deleting is safe . . . only after verified backup.",
        "Deleting is safe.",
      ],
      [
        "Caching is not... dangerous for this workload.",
        "dangerous for this workload.",
      ],
      [
        "Caching is not . . . dangerous for this workload.",
        "dangerous for this workload.",
      ],
      [
        "Deleting is safe (when backup verified.) unless backup stale.",
        "Deleting is safe (when backup verified.)",
      ],
      [
        "Deleting is safe (backup verified?) only after checks.",
        "Deleting is safe (backup verified?)",
      ],
      [
        "Deleting is safe (backup verified!) only after checks.",
        "Deleting is safe (backup verified!)",
      ],
      [
        "Deleting is safe only after a backup by Acme Corp. is verified.",
        "Deleting is safe only after a backup by Acme Corp.",
      ],
      [
        "Deleting is safe only after signoff by Acme Co. is recorded.",
        "Deleting is safe only after signoff by Acme Co.",
      ],
      [
        "Deleting is safe only after review by Smith et al. is completed.",
        "Deleting is safe only after review by Smith et al.",
      ],
    ]

    for (const [body, clip] of clips) {
      expect(isExtractiveSupport(clip, clip, body)).toBe(false)
      expect(extractiveSourceSpan(clip, body)).toBeUndefined()
      expect(extractiveSourceSpan(body, body)).toBe(body)
    }
  })
})

describe("complete source paragraph spans", () => {
  test("keeps whole headings, list items, and wrapped paragraphs", () => {
    const spans = sourceParagraphSpans(
      [
        "## Safety notes",
        "",
        "- Caching is not dangerous for this workload.",
        "- Deleting is safe only after a verified backup.",
        "",
        "Use e.g. caching for this workload",
        "and keep the bound documented.",
        "",
        "```",
        "Caching is not dangerous for this workload.",
        "```",
      ].join("\n"),
    )

    expect(spans).toContain("Safety notes")
    expect(spans).toContain("Caching is not dangerous for this workload.")
    expect(spans).toContain("Deleting is safe only after a verified backup.")
    expect(spans).toContain(
      "Use e.g. caching for this workload and keep the bound documented.",
    )
    expect(spans).not.toContain("dangerous for this workload.")
    expect(spans).not.toContain("Deleting is safe.")
    expect(spans).not.toContain("Caching is not dangerous for this workload. Deleting is safe only after a verified backup.")
  })

  test("matches only an exact complete block, without punctuation stripping", () => {
    const body = "Caching is not dangerous for this workload."

    expect(extractiveSourceSpan(body, body)).toBe(body)
    expect(
      extractiveSourceSpan(
        "Caching is not dangerous for this workload",
        body,
      ),
    ).toBeUndefined()
    expect(
      extractiveSourceSpan("dangerous for this workload.", body),
    ).toBeUndefined()
    expect(
      extractiveSourceSpan(
        "Deleting is safe.",
        "Deleting is safe only after a verified backup.",
      ),
    ).toBeUndefined()
  })

  test("allows a conservative full paragraph quote", () => {
    const body =
      "Caching is not dangerous for this workload. Deleting is safe only after a verified backup."
    expect(extractiveSourceSpan(body, body)).toBe(body)
    expect(extractiveSourceSpan("Caching is not dangerous for this workload.", body)).toBeUndefined()
  })
})

describe("synthesis citation validation", () => {
  test("omits text plus quote clipped from a negated paragraph", async () => {
    const result = await validate(
      [
        {
          text: "dangerous for this workload.",
          noteId: "20261117213000-note",
          quote: "dangerous for this workload.",
        },
      ],
      "Caching is not dangerous for this workload.",
    )

    expect(result.sentences).toEqual([])
    expect(result.omitted).toBe(1)
    expect(result.reasons.join("\n")).toContain("complete source paragraph")
  })

  test("omits text plus quote that cuts a qualifier", async () => {
    const result = await validate(
      [
        {
          text: "Deleting is safe.",
          noteId: "20261117213000-note",
          quote: "Deleting is safe",
        },
      ],
      "Deleting is safe only after a verified backup.",
    )

    expect(result.sentences).toEqual([])
    expect(result.omitted).toBe(1)
    expect(result.reasons.join("\n")).toContain("complete source paragraph")
  })

  test("omits concrete ellipsis, parenthetical, and abbreviation clips", async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["Deleting is safe... only after verified backup.", "Deleting is safe."],
      [
        "Deleting is safe . . . only after verified backup.",
        "Deleting is safe.",
      ],
      [
        "Deleting is safe (when backup verified.) unless backup stale.",
        "Deleting is safe (when backup verified.)",
      ],
      [
        "Deleting is safe only after a backup by Acme Corp. is verified.",
        "Deleting is safe only after a backup by Acme Corp.",
      ],
      [
        "Deleting is safe only after signoff by Acme Co. is recorded.",
        "Deleting is safe only after signoff by Acme Co.",
      ],
      [
        "Deleting is safe only after review by Smith et al. is completed.",
        "Deleting is safe only after review by Smith et al.",
      ],
    ]

    for (const [body, clip] of cases) {
      const result = await validate(
        [
          {
            text: clip,
            noteId: "20261117213000-note",
            quote: clip,
          },
        ],
        body,
      )
      expect(result.sentences).toEqual([])
      expect(result.omitted).toBe(1)
    }
  })

  test("accepts a complete paragraph and canonicalizes the excerpt", async () => {
    const body =
      "Caching is not dangerous for this workload.\nDeleting is safe only after a verified backup."
    const result = await validate(
      [
        {
          text: "\u201cCaching is not dangerous for this workload. Deleting is safe only after a verified backup.\u201d",
          noteId: "20261117213000-note",
          quote:
            "Caching is not dangerous for this workload. Deleting is safe only after a verified backup.",
        },
      ],
      `# Caching\n\n${body}`,
    )

    expect(result.omitted).toBe(0)
    expect(result.sentences).toHaveLength(1)
    expect(result.sentences[0]!.text).toBe(
      "\u201cCaching is not dangerous for this workload. Deleting is safe only after a verified backup.\u201d",
    )
    expect(result.sentences[0]!.quote).toBe(
      "Caching is not dangerous for this workload. Deleting is safe only after a verified backup.",
    )
  })
})
