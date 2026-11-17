const normalize = (text: string): string => text.replace(/\s+/g, " ").trim()

const firstTermIndex = (lower: string, query: string): number => {
  const exact = query.trim().toLowerCase()
  if (exact.length > 0) {
    const found = lower.indexOf(exact)
    if (found !== -1) {
      return found
    }
  }
  for (const term of exact.split(/\s+/)) {
    if (term.length === 0) {
      continue
    }
    const found = lower.indexOf(term)
    if (found !== -1) {
      return found
    }
  }
  return -1
}

/**
 * Builds a bounded, single-line excerpt around the first matching query term.
 * Search ranking and note content come from the core index; this only chooses a
 * readable window for terminal and JSON output.
 */
export const makeExcerpt = (
  content: string,
  query: string,
  maximum = 180,
): string => {
  const text = normalize(content)
  if (text.length <= maximum) {
    return text
  }

  const lower = text.toLowerCase()
  const found = firstTermIndex(lower, query)
  if (found === -1) {
    return `${text.slice(0, maximum).trimEnd()}…`
  }

  let start = Math.max(0, found - Math.floor(maximum / 3))
  let end = Math.min(text.length, start + maximum)
  if (start > 0) {
    const space = text.indexOf(" ", start)
    if (space !== -1 && space < found) {
      start = space + 1
    }
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end)
    if (space > start) {
      end = space
    }
  }

  const prefix = start > 0 ? "…" : ""
  const suffix = end < text.length ? "…" : ""
  return `${prefix}${text.slice(start, end).trim()}${suffix}`
}
