import { Effect } from "effect"
import { stringify } from "yaml"
import { initiativeError } from "./errors.js"
import {
  INITIATIVE_RECORD_MARKER,
  type InitiativePromotion,
  type InitiativeRecordData,
  type InitiativeVerificationReport,
  type MilestoneStatus,
} from "./types.js"

const singleLine = (value: string): string =>
  value.replace(/\s+/g, " ").trim()

const statusOf = (
  assertionCount: number,
  promotedCount: number,
): MilestoneStatus => {
  if (assertionCount === 0 || promotedCount === 0) {
    return "planned"
  }
  return promotedCount >= assertionCount ? "landed" : "active"
}

const promotionFor = (
  promotions: ReadonlyArray<InitiativePromotion>,
  assertionId: string,
): InitiativePromotion | undefined =>
  promotions.find((promotion) => promotion.assertionId === assertionId)

const renderFrontmatter = (data: InitiativeRecordData): string => {
  const yaml = stringify(
    {
      schema: data.schema,
      id: data.id,
      title: data.title,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      revision: data.revision,
    },
    { schema: "core", lineWidth: 0 },
  ).trimEnd()
  return `---\n${yaml}\n---\n`
}

/**
 * Renders the durable Markdown record. The human sections are a view; the
 * fenced JSON block is the authoritative structured record. Keeping both in
 * one nested file means Git versions the initiative, while the flat note
 * scanner, search index, and recall never treat it as a note.
 */
export const renderInitiativeMarkdown = (data: InitiativeRecordData): string => {
  const lines: string[] = [
    renderFrontmatter(data),
    `# ${data.title}`,
    "",
    "> Initiative bookkeeping. This file is not a note and is not indexed or recalled.",
    "",
    "## Scope",
    "",
    data.scope.summary,
    "",
    "## Intended behavior",
    "",
    data.scope.intendedBehavior,
  ]

  if (data.scope.outOfScope.length > 0) {
    lines.push("", "### Out of scope", "")
    for (const item of data.scope.outOfScope) {
      lines.push(`- ${item}`)
    }
  }
  if (data.scope.constraints.length > 0) {
    lines.push("", "### Constraints", "")
    for (const item of data.scope.constraints) {
      lines.push(`- ${item}`)
    }
  }
  if (data.scope.source !== undefined) {
    lines.push(
      "",
      "### Scope source",
      "",
      `- path: \`${data.scope.source.path}\``,
      `- content hash: \`${data.scope.source.contentHash}\``,
      `- bytes: ${data.scope.source.bytes}`,
      `- lines: ${data.scope.source.lineCount}`,
    )
  }

  lines.push("", "## Milestones", "")
  if (data.milestones.length === 0) {
    lines.push("_No milestones recorded._")
  }
  for (const milestone of data.milestones) {
    const promotedCount = milestone.assertions.filter((assertion) =>
      promotionFor(data.promotions, assertion.id) !== undefined,
    ).length
    const status = statusOf(milestone.assertions.length, promotedCount)
    lines.push(
      `### ${milestone.title} — ${status}`,
      "",
      `Intended behavior: ${milestone.intendedBehavior}`,
    )
    if (milestone.scope !== undefined) {
      lines.push("", `Scope: ${milestone.scope}`)
    }
    if (milestone.assertions.length > 0) {
      lines.push("")
      for (const assertion of milestone.assertions) {
        const promotion = promotionFor(data.promotions, assertion.id)
        lines.push(
          `- [${promotion === undefined ? " " : "x"}] \`${assertion.id}\` ${singleLine(assertion.claim)}`,
        )
        const summary = [
          `supports: ${assertion.supports.length}`,
          `contradicts: ${assertion.contradicts.length}`,
          ...(assertion.requiredEvidence.length === 0
            ? []
            : [`required: ${assertion.requiredEvidence.join(", ")}`]),
          ...(promotion === undefined ? [] : [`promoted: ${promotion.promotedAt}`]),
        ]
        lines.push(`  - ${summary.join("; ")}`)
      }
    }
    lines.push("")
  }

  lines.push("## Promotions", "")
  if (data.promotions.length === 0) {
    lines.push("_No assertions have been promoted._")
  } else {
    for (const promotion of data.promotions) {
      const source =
        promotion.snapshot === null
          ? "working tree"
          : `commit ${promotion.snapshot.observedCommit.slice(0, 12)}`
      lines.push(
        `- \`${promotion.assertionId}\` at ${promotion.promotedAt} (${source}; evidence ${promotion.evidenceDigest.slice(0, 12)}…)`,
      )
    }
  }

  lines.push(
    "",
    "## Machine record",
    "",
    `<!-- ${INITIATIVE_RECORD_MARKER} -->`,
    "```json",
    JSON.stringify(data, null, 2),
    "```",
    "",
  )

  return lines.join("\n")
}

const extractMarker = (body: string): number | null => {
  const marker = `<!-- ${INITIATIVE_RECORD_MARKER} -->`
  const lines = body.split("\n")
  let offset = 0
  let found: number | null = null
  for (const line of lines) {
    if (line.trim() === marker) {
      if (found !== null) {
        return null
      }
      found = offset
    }
    offset += line.length + 1
  }
  return found
}

/**
 * Extracts the single structured JSON block from the Markdown record body.
 * Multiple or missing markers fail closed: ambiguity is not a verification
 * result.
 */
export const extractInitiativeRecordJson = (
  body: string,
  path: string,
): Effect.Effect<unknown, ReturnType<typeof initiativeError>> =>
  Effect.gen(function* () {
    const marker = extractMarker(body)
    if (marker === null) {
      return yield* Effect.fail(
        initiativeError({
          code: "invalid-initiative",
          path,
          message: `Initiative file must contain exactly one '<!-- ${INITIATIVE_RECORD_MARKER} -->' marker.`,
        }),
      )
    }

    const after = body.slice(marker)
    const match = /^[ \t]*```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/m.exec(after)
    if (match === null) {
      return yield* Effect.fail(
        initiativeError({
          code: "invalid-initiative",
          path,
          message: "Initiative machine record must be a fenced ```json block after the marker.",
        }),
      )
    }

    try {
      return JSON.parse(match[1]!)
    } catch (cause) {
      return yield* Effect.fail(
        initiativeError({
          code: "invalid-initiative",
          path,
          message: `Initiative machine record is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      )
    }
  })

const evidenceLine = (check: {
  readonly stance: string
  readonly kind: string
  readonly path: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly valid: boolean
  readonly reason?: string
}): string =>
  `    - ${check.valid ? "VALID" : "INVALID"} ${check.stance}/${check.kind} \`${check.path}:${check.lineStart}-${check.lineEnd}\`${check.reason === undefined ? "" : ` — ${check.reason}`}`

/**
 * Renders a human-readable advisory verification report. This is the integration
 * export for a release/report surface; it intentionally separates supported,
 * contradicted, and not-evidenced assertions instead of collapsing them into a
 * single pass/fail claim.
 */
export const renderInitiativeVerificationMarkdown = (
  report: InitiativeVerificationReport,
): string => {
  const lines: string[] = [
    `# Initiative verification: ${report.title}`,
    "",
    `> Advisory verification only. It proves that pinned code/test lines still match; it does not prove semantic truth.`,
    "",
    `- initiative: \`${report.initiativeId}\``,
    `- verified at: ${report.verifiedAt}`,
    `- revision: ${report.revision}`,
    `- file: \`${report.path}\``,
    `- verification mode: ${report.verificationMode}`,
    "- automatic PR verification: no",
    "- automatic promotion: no",
    "- operator action required: explicit pins and an explicit per-assertion promotion",
    ...(report.snapshot === null
      ? ["- trusted snapshot: not available; evidence was read from the working tree"]
      : [
          `- main ref: ${report.snapshot.mainRef}`,
          `- observed ref: ${report.snapshot.observedRef}`,
          `- observed commit: ${report.snapshot.observedCommit}`,
          `- main commit: ${report.snapshot.mainCommit ?? "(unresolved)"}`,
          `- observed commit reachable from main: ${report.snapshot.reachableFromMain ? "yes" : "no"}`,
        ]),
    ...(report.git === null
      ? ["- git: not available"]
      : [
          `- git branch: ${report.git.branch ?? "(detached)"}`,
          `- git commit: ${report.git.commit ?? "(unknown)"}`,
        ]),
    "",
    "## Scope",
    "",
    report.scope.summary,
    "",
    "## Intended behavior",
    "",
    report.scope.intendedBehavior,
    "",
    "## Milestones",
    "",
  ]

  if (report.milestones.length === 0) {
    lines.push("_No milestones recorded._")
  }
  for (const milestone of report.milestones) {
    lines.push(
      `- ${milestone.title}: ${milestone.status} (${milestone.promotedCount}/${milestone.assertionCount} promoted; ${milestone.supportedCount} supported, ${milestone.contradictedCount} contradicted, ${milestone.notEvidencedCount} not evidenced)`,
    )
  }

  const section = (
    title: string,
    rows: ReadonlyArray<InitiativeVerificationReport["supported"][number]>,
  ): void => {
    lines.push("", `## ${title}`, "")
    if (rows.length === 0) {
      lines.push("_None._")
      return
    }
    for (const row of rows) {
      lines.push(
        `### ${row.milestoneTitle} / \`${row.assertionId}\``,
        "",
        row.claim,
        "",
        `- status: ${row.status}`,
        `- promoted: ${row.promoted ? "yes" : "no"}${row.promotionStatus === undefined ? "" : ` (${row.promotionStatus})`}`,
        ...(row.intendedBehavior === undefined
          ? []
          : [`- intended behavior: ${row.intendedBehavior}`]),
      )
      if (row.evidence.length === 0) {
        lines.push("- evidence: none")
      } else {
        lines.push("- evidence:")
        for (const check of row.evidence) {
          lines.push(evidenceLine(check))
        }
      }
      lines.push("")
    }
  }

  section("Supported assertions", report.supported)
  section("Contradicted assertions", report.contradicted)
  section("Not-evidenced assertions", report.notEvidenced)
  lines.push("")
  return lines.join("\n")
}
