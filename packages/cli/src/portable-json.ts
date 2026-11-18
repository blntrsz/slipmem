/**
 * Converts SQLite/JSON values to a JSON-safe shape without rounding or loss.
 *
 * This mirrors the migration manifest contract: unsafe integers become
 * `{ "$bigint": "..." }`, blobs become `{ "$base64": "..." }`, and non-finite
 * numbers become `{ "$number": "..." }`. The CLI uses it only where a report can
 * contain raw source rows; ordinary note output never needs the tags.
 */
export const toPortableJson = (value: unknown): unknown => {
  if (value === null || value === undefined) return null
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : { $number: String(value) }
  }
  if (typeof value === "bigint") return { $bigint: value.toString() }
  if (value instanceof Uint8Array) {
    return { $base64: Buffer.from(value).toString("base64") }
  }
  if (value instanceof Date) return { $date: value.toISOString() }
  if (Array.isArray(value)) return value.map(toPortableJson)
  if (typeof value === "object") {
    const object: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      object[key] = toPortableJson(entry)
    }
    return object
  }
  return String(value)
}
