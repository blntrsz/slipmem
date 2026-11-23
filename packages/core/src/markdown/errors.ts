import { Data } from "effect"

// Every failure in the Markdown path carries enough context for a CLI, MCP
// tool, or web form to point at the exact file and field. The `area` and `code`
// values are stable enough to replay the Phase 0 fixture manifest; they are not
// yet a public API promise.
export type MarkdownErrorArea =
  | "filename"
  | "frontmatter"
  | "metadata"
  | "body"
  | "path"
  | "repository"
  | "index"

export type MarkdownErrorCode =
  | "filename-pattern"
  | "malformed-yaml"
  | "executable-yaml"
  | "frontmatter-missing"
  | "frontmatter-too-large"
  | "file-too-large"
  | "id-mismatch"
  | "timestamp-invalid"
  | "timestamp-mismatch"
  | "timestamp-order"
  | "blank-title"
  | "unknown-type"
  | "unknown-schema"
  | "missing-reference"
  | "invalid-tag"
  | "content-empty"
  | "content-too-long"
  | "conflict-markers"
  | "invalid-field"
  | "path-outside-root"
  | "symlink"
  | "not-found"
  | "repository-locked"
  | "repository-root-missing"
  | "stale-base"
  | "target-exists"
  | "write-failed"
  | "backup-failed"
  | "index-error"
  | "index-schema"

export interface MarkdownErrorFields {
  readonly code: MarkdownErrorCode
  readonly area: MarkdownErrorArea
  /** The note file path, or the repository root for root-level failures. */
  readonly path: string
  readonly field?: string
  readonly message: string
}

/**
 * A typed, actionable Markdown repository failure.
 *
 * The class is intentionally one type across parser, repository, and index so
 * surfaces can render `{ code, area, path, field, message }` without matching
 * nested error unions. `cause` is reserved for the underlying OS or SQLite
 * failure and is never used to make decisions.
 */
export class MarkdownError extends Data.TaggedError("MarkdownError")<MarkdownErrorFields> {}

export const markdownError = (fields: MarkdownErrorFields): MarkdownError =>
  new MarkdownError(fields)
