import type { ApprovalProposal } from "./proposal-store.js"

export const MAX_DIFF_LINES = 600
export const MAX_DIFF_CHARS = 40_000

const splitLines = (value: string): ReadonlyArray<string> =>
  value.length === 0 ? [] : value.replace(/\r\n/g, "\n").split("\n")

/**
 * A small, bounded LCS line diff for the human review page.
 *
 * This is not a patch file and it never feeds a write. It exists so a reviewer
 * can see the exact before/after lines without adding a diff dependency. When a
 * note is larger than the review bound the diff is truncated with an explicit
 * notice instead of being silently shortened.
 */
export const lineDiff = (before: string, after: string): string => {
  const left = splitLines(before)
  const right = splitLines(after)

  // A poisoned proposal could be one megabyte of newlines. Keep the review
  // renderer bounded before allocating the LCS matrix.
  if (left.length * right.length > 1_000_000) {
    const lines = [
      ...left.slice(0, MAX_DIFF_LINES).map((line) => `-${line}`),
      ...right.slice(0, MAX_DIFF_LINES).map((line) => `+${line}`),
    ]
    return `${lines.join("\n").slice(0, MAX_DIFF_CHARS)}\n[diff too large for a line comparison; showing bounded replacement]`
  }

  const width = right.length + 1
  const matrix: Uint32Array = new Uint32Array((left.length + 1) * width)

  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      const index = i * width + j
      matrix[index] =
        left[i] === right[j]
          ? 1 + matrix[(i + 1) * width + j + 1]!
          : Math.max(matrix[(i + 1) * width + j]!, matrix[i * width + j + 1]!)
    }
  }

  const lines: string[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      lines.push(` ${left[i]}`)
      i++
      j++
    } else if (matrix[(i + 1) * width + j]! >= matrix[i * width + j + 1]!) {
      lines.push(`-${left[i]}`)
      i++
    } else {
      lines.push(`+${right[j]}`)
      j++
    }
  }
  while (i < left.length) {
    lines.push(`-${left[i]}`)
    i++
  }
  while (j < right.length) {
    lines.push(`+${right[j]}`)
    j++
  }

  const bounded = lines.slice(0, MAX_DIFF_LINES)
  const truncated = lines.length > MAX_DIFF_LINES
  const rendered = bounded.join("\n")
  const clipped =
    rendered.length > MAX_DIFF_CHARS
      ? `${rendered.slice(0, MAX_DIFF_CHARS)}\n[diff truncated at review bound]`
      : rendered

  return truncated
    ? `${clipped}\n[diff truncated at ${MAX_DIFF_LINES} lines]`
    : clipped
}

export interface ProposalDiffInput {
  readonly proposal: ApprovalProposal
  /** Current file content, or `null` when the target does not exist. */
  readonly currentContent: string | null
}

/**
 * Human-readable diff for the review queue.
 *
 * Creates show every proposed line prefixed with `+`; deletes show the current
 * file as `-` lines; updates and reclassifications use the line diff. The
 * proposal content is untrusted data and is rendered as plain text.
 */
export const proposalDiff = ({
  proposal,
  currentContent,
}: ProposalDiffInput): string => {
  if (proposal.operation === "create") {
    return lineDiff("", proposal.content)
  }
  if (proposal.operation === "delete") {
    return lineDiff(currentContent ?? "", "")
  }
  return lineDiff(currentContent ?? "", proposal.content)
}
