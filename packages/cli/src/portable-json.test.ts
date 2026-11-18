import { describe, expect, test } from "bun:test"
import { toPortableJson } from "./portable-json.js"

describe("portable migration JSON", () => {
  test("tags unsafe integers and blobs instead of rounding or stringifying them", () => {
    expect(
      toPortableJson({
        big: 9223372036854775807n,
        negative: -9223372036854775808n,
        blob: new Uint8Array([0, 255, 16]),
        finite: 12,
        text: "kept",
        nested: [1n],
      }),
    ).toEqual({
      big: { $bigint: "9223372036854775807" },
      negative: { $bigint: "-9223372036854775808" },
      blob: { $base64: "AP8Q" },
      finite: 12,
      text: "kept",
      nested: [{ $bigint: "1" }],
    })
  })

  test("tags non-finite numbers and normalizes undefined object entries", () => {
    expect(
      toPortableJson({ missing: undefined, infinite: Number.POSITIVE_INFINITY }),
    ).toEqual({ missing: null, infinite: { $number: "Infinity" } })
  })
})
