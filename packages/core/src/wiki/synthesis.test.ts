import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ParsedMarkdownNote } from "../markdown/note-document.js"
import {
  extractiveSourceSpan,
  isExtractiveSupport,
  sourceSentenceSpans,
  validateSynthesisOutput,
} from "./synthesis.js"

const note = (body: string): ParsedMarkdownNote =>
  ({ id: "20261117213000-note", body }) as unknown as ParsedMarkdownNote

const validate = (sentences: ReadonlyArray<unknown>, body: string) =>
  Effect.runPromise(validateSynthesisOutput({ sentences }, [note(body)]))

describe("extractive support equality", () => {
  test("accepts the complete quoted source sentence", () => {
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

  test("rejects a clipped fragment even when the quote is the same fragment", () => {
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
})

describe("complete source sentence spans", () => {
  test("segments Markdown headings, lists, wrapped lines, and abbreviations", () => {
    const spans = sourceSentenceSpans(
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

    expect(spans).toContain("Caching is not dangerous for this workload.")
    expect(spans).toContain("Deleting is safe only after a verified backup.")
    expect(spans).toContain(
      "Use e.g. caching for this workload and keep the bound documented.",
    )
    expect(spans).not.toContain("dangerous for this workload.")
    expect(spans).not.toContain("Deleting is safe.")
  })

  test("matches a quote only at complete boundary, not a clipped substring", () => {
    const body = "Caching is not dangerous for this workload."

    expect(extractiveSourceSpan(body, body)).toBe(body)
    expect(
      extractiveSourceSpan(
        "Caching is not dangerous for this workload",
        body,
      ),
    ).toBe(body)
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
  })
})

describe("synthesis citation validation", () => {
  test("omits text plus quote clipped from a negated sentence", async () => {
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
    expect(result.reasons.join("\n")).toContain("complete sentence")
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
    expect(result.reasons.join("\n")).toContain("complete sentence")
  })

  test("accepts a complete source sentence and canonicalizes the excerpt", async () => {
    const result = await validate(
      [
        {
          text: "\u201cCaching is not dangerous for this workload.\u201d",
          noteId: "20261117213000-note",
          quote: "Caching is not dangerous for this workload.",
        },
      ],
      "# Caching\n\nCaching is not dangerous for this workload.",
    )

    expect(result.omitted).toBe(0)
    expect(result.sentences).toHaveLength(1)
    expect(result.sentences[0]!.text).toBe(
      "\u201cCaching is not dangerous for this workload.\u201d",
    )
    expect(result.sentences[0]!.quote).toBe(
      "Caching is not dangerous for this workload.",
    )
  })
})
