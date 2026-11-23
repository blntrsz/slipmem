import { Markdown } from "@slipmem/schemas/markdown"
import { createHash } from "node:crypto"
import type { CaptureLimits } from "./config.js"
import { gitCaptureError, type GitCaptureError } from "./errors.js"
import type { GitDiff, GitHunk } from "./git.js"

export interface CaptureEvidence {
  readonly commit: string
  readonly path: string
  readonly hunk: number
  readonly quote: string
}

export interface CaptureSourceDraft {
  readonly title: string
  readonly content: string
  readonly tags: ReadonlyArray<string>
  readonly evidence: ReadonlyArray<CaptureEvidence>
  /** Stable content-addressed key used to make repeated deliveries idempotent. */
  readonly captureKey: string
}

export interface CaptureSourceSkip {
  readonly reason: string
  readonly title?: string
}

export interface ValidatedCaptureOutput {
  readonly sources: ReadonlyArray<CaptureSourceDraft>
  readonly skips: ReadonlyArray<CaptureSourceSkip>
  readonly invalidSourceCount: number
}

export const MIN_EVIDENCE_QUOTE_CHARS = 4
export const MAX_EVIDENCE_QUOTE_CHARS = 500

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null

const changedLines = (hunk: GitHunk): ReadonlyArray<string> =>
  hunk.lines
    .filter((line) => line.startsWith("+") || line.startsWith("-"))
    .map((line) => line.slice(1))

const canonicalKey = (input: {
  readonly repository: string
  readonly before: string
  readonly after: string
  readonly title: string
  readonly content: string
  readonly tags: ReadonlyArray<string>
  readonly evidence: ReadonlyArray<CaptureEvidence>
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        repository: input.repository,
        before: input.before,
        after: input.after,
        title: input.title,
        content: input.content,
        tags: input.tags,
        evidence: input.evidence,
      }),
      "utf8",
    )
    .digest("hex")

interface SourceValidation {
  readonly source?: CaptureSourceDraft
  readonly reason?: string
  readonly invalidEvidence: boolean
}

const validateSource = (
  raw: unknown,
  context: {
    readonly repository: string
    readonly before: string
    readonly after: string
    readonly files: ReadonlyMap<string, GitDiff["files"][number]>
    readonly limits: CaptureLimits
  },
): SourceValidation => {
  if (!isRecord(raw)) {
    return { reason: "source is not an object", invalidEvidence: false }
  }

  const title = text(raw.title)?.replaceAll("\u0000", "").trim() ?? ""
  if (title.length === 0 || title.length > context.limits.maxSourceTitleChars) {
    return {
      reason: `title is empty or longer than ${context.limits.maxSourceTitleChars} characters`,
      invalidEvidence: false,
    }
  }

  const content = text(raw.content)?.replaceAll("\u0000", "").trim() ?? ""
  if (
    content.length === 0 ||
    content.length > context.limits.maxSourceContentChars
  ) {
    return {
      reason: `content is empty or longer than ${context.limits.maxSourceContentChars} characters`,
      invalidEvidence: false,
    }
  }

  const tags: string[] = []
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags)) {
      return { reason: "tags is not an array", invalidEvidence: false }
    }
    for (const value of raw.tags) {
      if (typeof value !== "string") {
        return { reason: "tags contains a non-string", invalidEvidence: false }
      }
      const tag = Markdown.slugifyTag(value)
      if (tag !== "" && !tags.includes(tag)) {
        tags.push(tag)
      }
      if (tags.length >= context.limits.maxSourceTags) {
        break
      }
    }
  }

  if (!Array.isArray(raw.evidence) || raw.evidence.length === 0) {
    return { reason: "evidence is missing or empty", invalidEvidence: true }
  }
  if (raw.evidence.length > context.limits.maxEvidencePerSource) {
    return {
      reason: `evidence exceeds ${context.limits.maxEvidencePerSource} items`,
      invalidEvidence: true,
    }
  }

  const evidence: CaptureEvidence[] = []
  for (const item of raw.evidence) {
    if (!isRecord(item)) {
      return { reason: "evidence is not an object", invalidEvidence: true }
    }
    const commit = text(item.commit)
    if (commit !== context.after) {
      return {
        reason: "evidence commit does not equal the after commit",
        invalidEvidence: true,
      }
    }
    const path = text(item.path)
    const file = path === null ? undefined : context.files.get(path)
    if (path === null || file === undefined) {
      return {
        reason: "evidence path is not a changed path from the bounded request",
        invalidEvidence: true,
      }
    }
    if (
      typeof item.hunk !== "number" ||
      !Number.isSafeInteger(item.hunk) ||
      item.hunk < 0 ||
      item.hunk >= file.hunks.length
    ) {
      return {
        reason: "evidence hunk is not a listed hunk index",
        invalidEvidence: true,
      }
    }
    const hunk = file.hunks[item.hunk]!
    const quote = text(item.quote)?.replaceAll("\u0000", "").trim() ?? ""
    if (
      quote.length < MIN_EVIDENCE_QUOTE_CHARS ||
      quote.length > MAX_EVIDENCE_QUOTE_CHARS
    ) {
      return {
        reason: `evidence quote must be ${MIN_EVIDENCE_QUOTE_CHARS}-${MAX_EVIDENCE_QUOTE_CHARS} characters`,
        invalidEvidence: true,
      }
    }
    if (quote.includes("\n") || quote.includes("\r")) {
      return {
        reason: "evidence quote must be a single changed line",
        invalidEvidence: true,
      }
    }
    if (!changedLines(hunk).some((line) => line.includes(quote))) {
      return {
        reason: "evidence quote is not present in one cited hunk changed line",
        invalidEvidence: true,
      }
    }
    const duplicate = evidence.some(
      (existing) =>
        existing.path === path &&
        existing.hunk === item.hunk &&
        existing.quote === quote,
    )
    if (!duplicate) {
      evidence.push({ commit, path, hunk: item.hunk, quote })
    }
  }

  if (evidence.length === 0) {
    return { reason: "evidence is empty after validation", invalidEvidence: true }
  }

  return {
    source: {
      title,
      content,
      tags,
      evidence,
      captureKey: canonicalKey({
        repository: context.repository,
        before: context.before,
        after: context.after,
        title,
        content,
        tags,
        evidence,
      }),
    },
    invalidEvidence: false,
  }
}

/**
 * Validates model output against the exact bounded request, never against the
 * filesystem. A source with a fabricated commit, path, hunk, or quote is
 * dropped whole. If the model supplied sources but none survived, the run fails
 * instead of pretending the push had no durable content.
 */
export const validateCaptureOutput = (
  raw: unknown,
  context: {
    readonly repository: string
    readonly before: string
    readonly after: string
    readonly diff: GitDiff
    readonly limits: CaptureLimits
  },
): { readonly ok: true; readonly value: ValidatedCaptureOutput } | { readonly ok: false; readonly error: GitCaptureError } => {
  if (!isRecord(raw) || !Array.isArray(raw.sources)) {
    return {
      ok: false,
      error: gitCaptureError({
        code: "model-output-invalid",
        message:
          "The capture provider must return a JSON object with a sources array.",
      }),
    }
  }

  const supplied = raw.sources as ReadonlyArray<unknown>
  const files = new Map(context.diff.files.map((file) => [file.path, file]))
  const sources: CaptureSourceDraft[] = []
  const skips: CaptureSourceSkip[] = []
  let invalidSourceCount = 0

  for (let index = 0; index < supplied.length; index++) {
    const validation = validateSource(supplied[index], {
      repository: context.repository,
      before: context.before,
      after: context.after,
      files,
      limits: context.limits,
    })
    if (validation.source === undefined) {
      invalidSourceCount += validation.invalidEvidence ? 1 : 0
      skips.push({ reason: validation.reason ?? "source is invalid" })
      continue
    }
    if (sources.length >= context.limits.maxSources) {
      skips.push({
        reason: `more than ${context.limits.maxSources} sources`,
        title: validation.source.title,
      })
      continue
    }
    sources.push(validation.source)
  }

  if (supplied.length > 0 && sources.length === 0) {
    if (invalidSourceCount > 0) {
      return {
        ok: false,
        error: gitCaptureError({
          code: "evidence-invalid",
          message:
            "No model source cited valid commit/path/hunk evidence, so nothing was written. Rejecting the run is safer than storing unverified memory.",
        }),
      }
    }
    return {
      ok: false,
      error: gitCaptureError({
        code: "model-output-invalid",
        message:
          "The model supplied sources but none satisfied the bounded title, content, tag, or evidence contract. Nothing was written.",
      }),
    }
  }

  return { ok: true, value: { sources, skips, invalidSourceCount } }
}
