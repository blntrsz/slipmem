import { describe, expect, test } from "bun:test"
import { makeExcerpt } from "./excerpt.js"

describe("search excerpts", () => {
  test("collapses whitespace and keeps short content intact", () => {
    expect(makeExcerpt("one\n\n two\tthree", "two")).toBe("one two three")
  })

  test("windows around a match and stays bounded", () => {
    const content = `${"prefix ".repeat(60)}needle${" suffix".repeat(60)}`
    const excerpt = makeExcerpt(content, "needle", 80)
    expect(excerpt).toContain("needle")
    expect(excerpt.length).toBeLessThanOrEqual(82)
    expect(excerpt.startsWith("…")).toBe(true)
    expect(excerpt.endsWith("…")).toBe(true)
  })

  test("falls back to the beginning when the query is absent", () => {
    const excerpt = makeExcerpt("a ".repeat(100), "missing", 40)
    expect(excerpt.endsWith("…")).toBe(true)
    expect(excerpt.startsWith("a a")).toBe(true)
  })
})
