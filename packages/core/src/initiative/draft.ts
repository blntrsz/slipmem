import { Markdown } from "@slipmem/schemas/markdown"
import { Effect } from "effect"
import { evidenceDigest, normalizeEvidencePath } from "./evidence.js"
import { initiativeError } from "./errors.js"
import {
  ASSERTION_ID_PATTERN,
  INITIATIVE_ID_PATTERN,
  INITIATIVE_SCHEMA,
  MAX_ASSERTIONS_PER_MILESTONE,
  MAX_CLAIM_CHARS,
  MAX_EVIDENCE_PINS_PER_ASSERTION,
  MAX_ID_CHARS,
  MAX_MILESTONES,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  MILESTONE_ID_PATTERN,
  PROMOTION_ID_PATTERN,
  SHA256_HEX_PATTERN,
  type EvidenceKind,
  type EvidencePin,
  type EvidencePinInput,
  type GitSnapshot,
  type InitiativeAssertion,
  type InitiativeAssertionInput,
  type InitiativeDraftInput,
  type InitiativeMilestone,
  type InitiativeMilestoneInput,
  type InitiativePromotion,
  type InitiativeRecordData,
  type InitiativeScope,
  type InitiativeSnapshot,
} from "./types.js"

const invalid = (
  code: "invalid-draft" | "invalid-initiative",
  path: string,
  message: string,
  field?: string,
): ReturnType<typeof initiativeError> =>
  initiativeError({
    code,
    path,
    message,
    ...(field === undefined ? {} : { field }),
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const nonBlank = (
  value: unknown,
  path: string,
  field: string,
  max: number,
  code: "invalid-draft" | "invalid-initiative" = "invalid-draft",
): Effect.Effect<string, ReturnType<typeof initiativeError>> =>
  Effect.gen(function* () {
    if (typeof value !== "string" || value.trim().length === 0) {
      return yield* Effect.fail(
        invalid(code, path, `${field} must be a non-blank string.`, field),
      )
    }
    const text = value.trim()
    if (text.length > max) {
      return yield* Effect.fail(
        invalid(code, path, `${field} must be ${max} characters or fewer.`, field),
      )
    }
    return text
  })

const optionalText = (
  value: unknown,
  path: string,
  field: string,
  code: "invalid-draft" | "invalid-initiative" = "invalid-draft",
): Effect.Effect<string | undefined, ReturnType<typeof initiativeError>> =>
  Effect.gen(function* () {
    if (value === undefined || value === null) {
      return undefined
    }
    if (typeof value !== "string") {
      return yield* Effect.fail(
        invalid(code, path, `${field} must be a string when present.`, field),
      )
    }
    const text = value.trim()
    if (text.length > MAX_TEXT_CHARS) {
      return yield* Effect.fail(
        invalid(
          code,
          path,
          `${field} must be ${MAX_TEXT_CHARS} characters or fewer.`,
          field,
        ),
      )
    }
    return text.length === 0 ? undefined : text
  })

const textList = (
  value: unknown,
  path: string,
  field: string,
  code: "invalid-draft" | "invalid-initiative" = "invalid-draft",
): Effect.Effect<ReadonlyArray<string>, ReturnType<typeof initiativeError>> =>
  Effect.gen(function* () {
    if (value === undefined || value === null) {
      return []
    }
    if (!Array.isArray(value)) {
      return yield* Effect.fail(
        invalid(code, path, `${field} must be an array when present.`, field),
      )
    }
    if (value.length > 100) {
      return yield* Effect.fail(
        invalid(code, path, `${field} must contain 100 items or fewer.`, field),
      )
    }
    const items: string[] = []
    for (const item of value) {
      if (typeof item !== "string" || item.trim().length === 0) {
        return yield* Effect.fail(
          invalid(code, path, `${field} entries must be non-blank strings.`, field),
        )
      }
      const text = item.trim()
      if (text.length > MAX_TEXT_CHARS) {
        return yield* Effect.fail(
          invalid(
            code,
            path,
            `${field} entries must be ${MAX_TEXT_CHARS} characters or fewer.`,
            field,
          ),
        )
      }
      items.push(text)
    }
    return items
  })

const evidenceKinds = (
  value: unknown,
  path: string,
  code: "invalid-draft" | "invalid-initiative",
): Effect.Effect<ReadonlyArray<EvidenceKind>, ReturnType<typeof initiativeError>> =>
  Effect.gen(function* () {
    if (value === undefined || value === null) {
      return []
    }
    if (!Array.isArray(value)) {
      return yield* Effect.fail(
        invalid(code, path, "requiredEvidence must be an array when present.", "requiredEvidence"),
      )
    }
    const kinds: EvidenceKind[] = []
    for (const item of value) {
      if (item !== "code" && item !== "test") {
        return yield* Effect.fail(
          invalid(
            code,
            path,
            "requiredEvidence entries must be 'code' or 'test'.",
            "requiredEvidence",
          ),
        )
      }
      if (!kinds.includes(item)) {
        kinds.push(item)
      }
    }
    return kinds
  })

const evidenceKind = (
  value: unknown,
  path: string,
  code: "invalid-draft" | "invalid-initiative",
): Effect.Effect<EvidenceKind, ReturnType<typeof initiativeError>> =>
  value === "code" || value === "test"
    ? Effect.succeed(value)
    : Effect.fail(
        invalid(code, path, "Evidence kind must be 'code' or 'test'.", "kind"),
      )

const lineNumber = (
  value: unknown,
  path: string,
  field: string,
  code: "invalid-draft" | "invalid-initiative",
): Effect.Effect<number, ReturnType<typeof initiativeError>> =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? Effect.succeed(value)
    : Effect.fail(
        invalid(
          code,
          path,
          `${field} must be a positive safe integer.`,
          field,
        ),
      )

const hash = (
  value: unknown,
  path: string,
  field: string,
  code: "invalid-draft" | "invalid-initiative",
): Effect.Effect<string, ReturnType<typeof initiativeError>> =>
  typeof value === "string" && SHA256_HEX_PATTERN.test(value.toLowerCase())
    ? Effect.succeed(value.toLowerCase())
    : Effect.fail(
        invalid(
          code,
          path,
          `${field} must be a 64-character SHA-256 hex digest.`,
          field,
        ),
      )

const parseEvidencePin = (
  value: unknown,
  path: string,
  code: "invalid-draft" | "invalid-initiative",
): Effect.Effect<EvidencePinInput, ReturnType<typeof initiativeError>> =>
  Effect.gen(function* () {
    if (!isRecord(value)) {
      return yield* Effect.fail(
        invalid(code, path, "Evidence pins must be objects.", "evidence"),
      )
    }
    const kind = yield* evidenceKind(value.kind, path, code)
    const evidencePath = yield* normalizeEvidencePath(value.path)
    const lineStart = yield* lineNumber(value.lineStart, path, "lineStart", code)
    const lineEnd = yield* lineNumber(value.lineEnd, path, "lineEnd", code)
    if (lineEnd < lineStart) {
      return yield* Effect.fail(
        invalid(
          code,
          path,
          "Evidence lineEnd must be greater than or equal to lineStart.",
          "lineEnd",
        ),
      )
    }
    const contentHash = yield* hash(value.contentHash, path, "contentHash", code)
    const excerptHash = yield* hash(value.excerptHash, path, "excerptHash", code)
    const note = yield* optionalText(value.note, path, "note", code)
    return {
      kind,
      path: evidencePath,
      lineStart,
      lineEnd,
      contentHash,
      excerptHash,
      ...(note === undefined ? {} : { note }),
    }
  })

const parseEvidenceList = (
  value: unknown,
  path: string,
  field: string,
  code: "invalid-draft" | "invalid-initiative",
): Effect.Effect<ReadonlyArray<EvidencePinInput>, ReturnType<typeof initiativeError>> =>
  Effect.gen(function* () {
    if (value === undefined || value === null) {
      return []
    }
    if (!Array.isArray(value)) {
      return yield* Effect.fail(
        invalid(code, path, `${field} must be an array when present.`, field),
      )
    }
    if (value.length > MAX_EVIDENCE_PINS_PER_ASSERTION) {
      return yield* Effect.fail(
        invalid(
          code,
          path,
          `${field} must contain ${MAX_EVIDENCE_PINS_PER_ASSERTION} pins or fewer.`,
          field,
        ),
      )
    }
    const pins: EvidencePinInput[] = []
    for (const item of value) {
      pins.push(yield* parseEvidencePin(item, path, code))
    }
    return pins
  })

const parseId = (
  value: unknown,
  path: string,
  field: string,
  pattern: RegExp,
  code: "invalid-draft" | "invalid-initiative",
): Effect.Effect<string, ReturnType<typeof initiativeError>> =>
  Effect.gen(function* () {
    if (typeof value !== "string" || value.length > MAX_ID_CHARS || !pattern.test(value)) {
      return yield* Effect.fail(
        invalid(
          code,
          path,
          `${field} must be a stable kebab-case ID matching ${pattern}.`,
          field,
        ),
      )
    }
    return value
  })

const assertionIds = (
  value: unknown,
  path: string,
  code: "invalid-draft" | "invalid-initiative",
): Effect.Effect<string, ReturnType<typeof initiativeError>> => {
  if (value === undefined || value === null) {
    return Effect.fail(
      invalid(code, path, "Stored assertions require a stable ID.", "id"),
    )
  }
  return parseId(value, path, "id", ASSERTION_ID_PATTERN, code)
}

const milestoneIds = (
  value: unknown,
  path: string,
  code: "invalid-draft" | "invalid-initiative",
): Effect.Effect<string, ReturnType<typeof initiativeError>> => {
  if (value === undefined || value === null) {
    return Effect.fail(
      invalid(code, path, "Stored milestones require a stable ID.", "id"),
    )
  }
  return parseId(value, path, "id", MILESTONE_ID_PATTERN, code)
}

const parseAssertion = (
  value: unknown,
  path: string,
  code: "invalid-draft" | "invalid-initiative",
  requireId: boolean,
): Effect.Effect<InitiativeAssertion | InitiativeAssertionInput, ReturnType<typeof initiativeError>> =>
  Effect.gen(function* () {
    if (!isRecord(value)) {
      return yield* Effect.fail(
        invalid(code, path, "Assertions must be objects.", "assertions"),
      )
    }
    const id = requireId
      ? yield* assertionIds(value.id, path, code)
      : undefined
    const claim = yield* nonBlank(value.claim, path, "claim", MAX_CLAIM_CHARS, code)
    const intendedBehavior = yield* optionalText(
      value.intendedBehavior,
      path,
      "intendedBehavior",
      code,
    )
    const requiredEvidence = yield* evidenceKinds(
      value.requiredEvidence,
      path,
      code,
    )
    // `status`, `verified`, and similar computed fields are deliberately not
    // read. A draft cannot claim support by supplying a status string; the
    // verifier always recomputes from fresh source reads.
    const supports = yield* parseEvidenceList(value.supports, path, "supports", code)
    const contradicts = yield* parseEvidenceList(
      value.contradicts,
      path,
      "contradicts",
      code,
    )
    if (
      supports.length + contradicts.length >
      MAX_EVIDENCE_PINS_PER_ASSERTION
    ) {
      return yield* Effect.fail(
        invalid(
          code,
          path,
          `An assertion may have at most ${MAX_EVIDENCE_PINS_PER_ASSERTION} evidence pins in total.`,
          "evidence",
        ),
      )
    }

    if (requireId && id !== undefined) {
      return {
        id,
        claim,
        ...(intendedBehavior === undefined ? {} : { intendedBehavior }),
        requiredEvidence,
        supports,
        contradicts,
      } satisfies InitiativeAssertion
    }

    return {
      claim,
      ...(intendedBehavior === undefined ? {} : { intendedBehavior }),
      requiredEvidence,
      supports,
      contradicts,
    } satisfies InitiativeAssertionInput
  })

const parseMilestone = (
  value: unknown,
  path: string,
  code: "invalid-draft" | "invalid-initiative",
  requireId: boolean,
): Effect.Effect<InitiativeMilestone | InitiativeMilestoneInput, ReturnType<typeof initiativeError>> =>
  Effect.gen(function* () {
    if (!isRecord(value)) {
      return yield* Effect.fail(
        invalid(code, path, "Milestones must be objects.", "milestones"),
      )
    }
    const id = requireId
      ? yield* milestoneIds(value.id, path, code)
      : undefined
    const title = yield* nonBlank(
      value.title,
      path,
      "milestone title",
      MAX_TITLE_CHARS,
      code,
    )
    const scope = yield* optionalText(value.scope, path, "milestone scope", code)
    const intendedBehavior = yield* nonBlank(
      value.intendedBehavior,
      path,
      "milestone intendedBehavior",
      MAX_TEXT_CHARS,
      code,
    )
    const rawAssertions = value.assertions
    if (rawAssertions !== undefined && rawAssertions !== null && !Array.isArray(rawAssertions)) {
      return yield* Effect.fail(
        invalid(code, path, "assertions must be an array when present.", "assertions"),
      )
    }
    const assertionsValue = Array.isArray(rawAssertions) ? rawAssertions : []
    if (assertionsValue.length > MAX_ASSERTIONS_PER_MILESTONE) {
      return yield* Effect.fail(
        invalid(
          code,
          path,
          `A milestone may have at most ${MAX_ASSERTIONS_PER_MILESTONE} assertions.`,
          "assertions",
        ),
      )
    }
    const assertions: Array<InitiativeAssertion | InitiativeAssertionInput> = []
    for (const item of assertionsValue) {
      assertions.push(yield* parseAssertion(item, path, code, requireId))
    }

    if (requireId && id !== undefined) {
      return {
        id,
        title,
        ...(scope === undefined ? {} : { scope }),
        intendedBehavior,
        assertions: assertions as ReadonlyArray<InitiativeAssertion>,
      } satisfies InitiativeMilestone
    }

    return {
      title,
      ...(scope === undefined ? {} : { scope }),
      intendedBehavior,
      assertions: assertions as ReadonlyArray<InitiativeAssertionInput>,
    } satisfies InitiativeMilestoneInput
  })

const parseScope = (
  value: unknown,
  path: string,
  code: "invalid-draft" | "invalid-initiative",
  stored: boolean,
): Effect.Effect<InitiativeScope | (InitiativeDraftInput["scope"]), ReturnType<typeof initiativeError>> =>
  Effect.gen(function* () {
    if (!isRecord(value)) {
      return yield* Effect.fail(
        invalid(code, path, "scope must be an object.", "scope"),
      )
    }
    const summary = yield* nonBlank(
      value.summary,
      path,
      "scope summary",
      MAX_TEXT_CHARS,
      code,
    )
    const intendedBehavior = yield* nonBlank(
      value.intendedBehavior,
      path,
      "scope intendedBehavior",
      MAX_TEXT_CHARS,
      code,
    )
    const outOfScope = yield* textList(value.outOfScope, path, "outOfScope", code)
    const constraints = yield* textList(value.constraints, path, "constraints", code)

    if (!stored) {
      const sourcePath = yield* optionalText(
        value.sourcePath,
        path,
        "scope sourcePath",
        code,
      )
      const normalizedSource =
        sourcePath === undefined
          ? undefined
          : yield* normalizeEvidencePath(sourcePath).pipe(
              Effect.mapError((error) =>
                invalid(code, path, error.message, "scope.sourcePath"),
              ),
            )
      return {
        summary,
        intendedBehavior,
        outOfScope,
        constraints,
        ...(normalizedSource === undefined
          ? {}
          : { sourcePath: normalizedSource }),
      }
    }

    const rawSource = value.source
    let source: InitiativeScope["source"]
    if (rawSource !== undefined && rawSource !== null) {
      if (!isRecord(rawSource)) {
        return yield* Effect.fail(
          invalid(code, path, "scope.source must be an object when present.", "scope.source"),
        )
      }
      const sourcePath = yield* normalizeEvidencePath(rawSource.path).pipe(
        Effect.mapError((error) =>
          invalid(code, path, error.message, "scope.source.path"),
        ),
      )
      const contentHash = yield* hash(
        rawSource.contentHash,
        path,
        "scope.source.contentHash",
        code,
      )
      const bytes = rawSource.bytes
      if (
        typeof bytes !== "number" ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0
      ) {
        return yield* Effect.fail(
          invalid(code, path, "scope.source.bytes must be a non-negative integer.", "scope.source.bytes"),
        )
      }
      const lineCount = rawSource.lineCount
      if (
        typeof lineCount !== "number" ||
        !Number.isSafeInteger(lineCount) ||
        lineCount < 1
      ) {
        return yield* Effect.fail(
          invalid(code, path, "scope.source.lineCount must be a positive integer.", "scope.source.lineCount"),
        )
      }
      const excerpt = rawSource.excerpt
      if (
        typeof excerpt !== "string" ||
        excerpt.length > MAX_TEXT_CHARS * 2
      ) {
        return yield* Effect.fail(
          invalid(
            code,
            path,
            `scope.source.excerpt must be a string of at most ${MAX_TEXT_CHARS * 2} characters.`,
            "scope.source.excerpt",
          ),
        )
      }
      source = {
        path: sourcePath,
        contentHash,
        bytes,
        lineCount,
        excerpt,
      }
    }

    return {
      summary,
      intendedBehavior,
      outOfScope,
      constraints,
      ...(source === undefined ? {} : { source }),
    } satisfies InitiativeScope
  })

const parseGit = (
  value: unknown,
  path: string,
  code: "invalid-draft" | "invalid-initiative",
): Effect.Effect<GitSnapshot | null, ReturnType<typeof initiativeError>> =>
  Effect.gen(function* () {
    if (value === undefined || value === null) {
      return null
    }
    if (!isRecord(value)) {
      return yield* Effect.fail(
        invalid(code, path, "Promotion git snapshot must be an object.", "git"),
      )
    }
    const branch =
      value.branch === null || value.branch === undefined
        ? null
        : yield* nonBlank(value.branch, path, "git.branch", MAX_ID_CHARS * 2, code)
    const commit =
      value.commit === null || value.commit === undefined
        ? null
        : yield* nonBlank(value.commit, path, "git.commit", 64, code)
    if (typeof value.detached !== "boolean") {
      return yield* Effect.fail(
        invalid(code, path, "git.detached must be a boolean.", "git.detached"),
      )
    }
    return { branch, commit, detached: value.detached }
  })

const gitCommit = (
  value: unknown,
  path: string,
  field: string,
): Effect.Effect<string | null, ReturnType<typeof initiativeError>> =>
  Effect.gen(function* () {
    if (value === null || value === undefined) {
      return null
    }
    if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) {
      return yield* Effect.fail(
        invalid(
          "invalid-initiative",
          path,
          `${field} must be a full 40-character Git commit ID.`,
          field,
        ),
      )
    }
    return value.toLowerCase()
  })

const parseSnapshot = (
  value: unknown,
  path: string,
): Effect.Effect<InitiativeSnapshot | null, ReturnType<typeof initiativeError>> =>
  Effect.gen(function* () {
    if (value === undefined || value === null) {
      return null
    }
    if (!isRecord(value)) {
      return yield* Effect.fail(
        invalid(
          "invalid-initiative",
          path,
          "Promotion source snapshot must be an object when present.",
          "snapshot",
        ),
      )
    }
    const mainRef = yield* nonBlank(
      value.mainRef,
      path,
      "snapshot.mainRef",
      MAX_ID_CHARS,
      "invalid-initiative",
    )
    const mainCommit = yield* gitCommit(
      value.mainCommit,
      path,
      "snapshot.mainCommit",
    )
    const observedRef = yield* nonBlank(
      value.observedRef,
      path,
      "snapshot.observedRef",
      MAX_ID_CHARS,
      "invalid-initiative",
    )
    const observedCommit = yield* gitCommit(
      value.observedCommit,
      path,
      "snapshot.observedCommit",
    )
    if (observedCommit === null) {
      return yield* Effect.fail(
        invalid(
          "invalid-initiative",
          path,
          "snapshot.observedCommit is required.",
          "snapshot.observedCommit",
        ),
      )
    }
    if (typeof value.reachableFromMain !== "boolean") {
      return yield* Effect.fail(
        invalid(
          "invalid-initiative",
          path,
          "snapshot.reachableFromMain must be a boolean.",
          "snapshot.reachableFromMain",
        ),
      )
    }
    return {
      mainRef,
      mainCommit,
      observedRef,
      observedCommit,
      reachableFromMain: value.reachableFromMain,
    }
  })

const parsePromotion = (
  value: unknown,
  path: string,
): Effect.Effect<InitiativePromotion, ReturnType<typeof initiativeError>> =>
  Effect.gen(function* () {
    if (!isRecord(value)) {
      return yield* Effect.fail(
        invalid("invalid-initiative", path, "Promotions must be objects.", "promotions"),
      )
    }
    const id = yield* parseId(
      value.id,
      path,
      "promotion id",
      PROMOTION_ID_PATTERN,
      "invalid-initiative",
    )
    const initiativeId = yield* parseId(
      value.initiativeId,
      path,
      "promotion initiativeId",
      INITIATIVE_ID_PATTERN,
      "invalid-initiative",
    )
    const assertionId = yield* parseId(
      value.assertionId,
      path,
      "promotion assertionId",
      ASSERTION_ID_PATTERN,
      "invalid-initiative",
    )
    const milestoneId = yield* parseId(
      value.milestoneId,
      path,
      "promotion milestoneId",
      MILESTONE_ID_PATTERN,
      "invalid-initiative",
    )
    if (id !== `promotion-${assertionId}`) {
      return yield* Effect.fail(
        invalid(
          "invalid-initiative",
          path,
          "A promotion ID must be 'promotion-' followed by its assertion ID.",
          "promotions.id",
        ),
      )
    }
    const promotedAt = yield* nonBlank(
      value.promotedAt,
      path,
      "promotion promotedAt",
      32,
      "invalid-initiative",
    )
    const verifiedAt = yield* nonBlank(
      value.verifiedAt,
      path,
      "promotion verifiedAt",
      32,
      "invalid-initiative",
    )
    if (
      !Markdown.isUtcTimestamp(promotedAt) ||
      !Markdown.isUtcTimestamp(verifiedAt)
    ) {
        return yield* Effect.fail(
          invalid(
            "invalid-initiative",
            path,
            "Promotion timestamps must be canonical UTC timestamps.",
            "promotions.promotedAt",
          ),
        )
    }
    const declaredEvidenceDigest = yield* hash(
      value.evidenceDigest,
      path,
      "promotion evidenceDigest",
      "invalid-initiative",
    )
    const rawEvidence = value.evidence
    if (!Array.isArray(rawEvidence) || rawEvidence.length === 0) {
      return yield* Effect.fail(
        invalid(
          "invalid-initiative",
          path,
          "A promotion must snapshot at least one evidence pin.",
          "promotions.evidence",
        ),
      )
    }
    if (rawEvidence.length > MAX_EVIDENCE_PINS_PER_ASSERTION) {
      return yield* Effect.fail(
        invalid(
          "invalid-initiative",
          path,
          `A promotion may snapshot at most ${MAX_EVIDENCE_PINS_PER_ASSERTION} evidence pins.`,
          "promotions.evidence",
        ),
      )
    }
    const evidence: EvidencePin[] = []
    for (const item of rawEvidence) {
      evidence.push(
        (yield* parseEvidencePin(item, path, "invalid-initiative")) as EvidencePin,
      )
    }
    if (evidenceDigest(evidence) !== declaredEvidenceDigest) {
      return yield* Effect.fail(
        invalid(
          "invalid-initiative",
          path,
          "Promotion evidenceDigest does not match its evidence snapshot.",
          "promotions.evidenceDigest",
        ),
      )
    }
    if (value.advisory !== true) {
      return yield* Effect.fail(
        invalid(
          "invalid-initiative",
          path,
          "A promotion must be explicitly advisory.",
          "promotions.advisory",
        ),
      )
    }
    const git = yield* parseGit(value.git, path, "invalid-initiative")
    const snapshot = yield* parseSnapshot(value.snapshot, path)
    return {
      id,
      initiativeId,
      assertionId,
      milestoneId,
      promotedAt,
      verifiedAt,
      evidenceDigest: declaredEvidenceDigest,
      evidence,
      git,
      snapshot,
      advisory: true,
    }
  })

export const parseInitiativeDraft = (
  input: unknown,
  path = "<draft>",
): Effect.Effect<InitiativeDraftInput, ReturnType<typeof initiativeError>> =>
  Effect.gen(function* () {
    if (!isRecord(input)) {
      return yield* Effect.fail(
        invalid("invalid-draft", path, "An initiative draft must be a JSON object."),
      )
    }
    const title = yield* nonBlank(input.title, path, "title", MAX_TITLE_CHARS)
    const scope = (yield* parseScope(input.scope, path, "invalid-draft", false)) as InitiativeDraftInput["scope"]
    const rawMilestones = input.milestones
    if (!Array.isArray(rawMilestones)) {
      return yield* Effect.fail(
        invalid("invalid-draft", path, "milestones must be an array.", "milestones"),
      )
    }
    if (rawMilestones.length > MAX_MILESTONES) {
      return yield* Effect.fail(
        invalid(
          "invalid-draft",
          path,
          `An initiative may have at most ${MAX_MILESTONES} milestones.`,
          "milestones",
        ),
      )
    }
    const milestones: InitiativeMilestoneInput[] = []
    for (const item of rawMilestones) {
      milestones.push(
        (yield* parseMilestone(item, path, "invalid-draft", false)) as InitiativeMilestoneInput,
      )
    }
    return { title, scope, milestones }
  })

export const parseMilestoneDraft = (
  input: unknown,
  path = "<draft>",
): Effect.Effect<InitiativeMilestoneInput, ReturnType<typeof initiativeError>> =>
  parseMilestone(input, path, "invalid-draft", false).pipe(
    Effect.map((milestone) => milestone as InitiativeMilestoneInput),
  )

export const parseAssertionDraft = (
  input: unknown,
  path = "<draft>",
): Effect.Effect<InitiativeAssertionInput, ReturnType<typeof initiativeError>> =>
  parseAssertion(input, path, "invalid-draft", false).pipe(
    Effect.map((assertion) => assertion as InitiativeAssertionInput),
  )

export const parseStoredInitiative = (
  input: unknown,
  path: string,
): Effect.Effect<InitiativeRecordData, ReturnType<typeof initiativeError>> =>
  Effect.gen(function* () {
    if (!isRecord(input)) {
      return yield* Effect.fail(
        invalid("invalid-initiative", path, "Initiative record must be a JSON object."),
      )
    }
    if (input.schema !== INITIATIVE_SCHEMA) {
      return yield* Effect.fail(
        invalid(
          "invalid-initiative",
          path,
          `Initiative schema must be '${INITIATIVE_SCHEMA}'.`,
          "schema",
        ),
      )
    }
    const id = yield* parseId(
      input.id,
      path,
      "id",
      INITIATIVE_ID_PATTERN,
      "invalid-initiative",
    )
    const title = yield* nonBlank(
      input.title,
      path,
      "title",
      MAX_TITLE_CHARS,
      "invalid-initiative",
    )
    const createdAt = yield* nonBlank(
      input.createdAt,
      path,
      "createdAt",
      32,
      "invalid-initiative",
    )
    const updatedAt = yield* nonBlank(
      input.updatedAt,
      path,
      "updatedAt",
      32,
      "invalid-initiative",
    )
    if (!Markdown.isUtcTimestamp(createdAt) || !Markdown.isUtcTimestamp(updatedAt)) {
      return yield* Effect.fail(
        invalid(
          "invalid-initiative",
          path,
          "Initiative timestamps must be canonical UTC timestamps.",
          "createdAt",
        ),
      )
    }
    if (updatedAt < createdAt) {
      return yield* Effect.fail(
        invalid(
          "invalid-initiative",
          path,
          "updatedAt must be at least createdAt.",
          "updatedAt",
        ),
      )
    }
    if (
      typeof input.revision !== "number" ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1
    ) {
      return yield* Effect.fail(
        invalid(
          "invalid-initiative",
          path,
          "revision must be a positive integer.",
          "revision",
        ),
      )
    }
    const scope = (yield* parseScope(
      input.scope,
      path,
      "invalid-initiative",
      true,
    )) as InitiativeScope
    const rawMilestones = input.milestones
    if (!Array.isArray(rawMilestones)) {
      return yield* Effect.fail(
        invalid(
          "invalid-initiative",
          path,
          "milestones must be an array.",
          "milestones",
        ),
      )
    }
    if (rawMilestones.length > MAX_MILESTONES) {
      return yield* Effect.fail(
        invalid(
          "invalid-initiative",
          path,
          `An initiative may have at most ${MAX_MILESTONES} milestones.`,
          "milestones",
        ),
      )
    }
    const milestones: InitiativeMilestone[] = []
    const milestoneIds = new Set<string>()
    const assertionIds = new Set<string>()
    for (const item of rawMilestones) {
      const milestone = (yield* parseMilestone(
        item,
        path,
        "invalid-initiative",
        true,
      )) as InitiativeMilestone
      if (milestoneIds.has(milestone.id)) {
        return yield* Effect.fail(
          invalid(
            "invalid-initiative",
            path,
            `Duplicate milestone ID '${milestone.id}'.`,
            "milestones.id",
          ),
        )
      }
      milestoneIds.add(milestone.id)
      for (const assertion of milestone.assertions) {
        if (assertionIds.has(assertion.id)) {
          return yield* Effect.fail(
            invalid(
              "invalid-initiative",
              path,
              `Duplicate assertion ID '${assertion.id}'. Assertion IDs are unique across the initiative.`,
              "assertions.id",
            ),
          )
        }
        assertionIds.add(assertion.id)
      }
      milestones.push(milestone)
    }

    const rawPromotions = input.promotions
    if (rawPromotions !== undefined && rawPromotions !== null && !Array.isArray(rawPromotions)) {
      return yield* Effect.fail(
        invalid(
          "invalid-initiative",
          path,
          "promotions must be an array.",
          "promotions",
        ),
      )
    }
    const promotions: InitiativePromotion[] = []
    const promoted = new Set<string>()
    for (const item of Array.isArray(rawPromotions) ? rawPromotions : []) {
      const promotion = yield* parsePromotion(item, path)
      if (promoted.has(promotion.assertionId)) {
        return yield* Effect.fail(
          invalid(
            "invalid-initiative",
            path,
            `Assertion '${promotion.assertionId}' has more than one promotion.`,
            "promotions",
          ),
        )
      }
      promoted.add(promotion.assertionId)
      if (promotion.initiativeId !== id) {
        return yield* Effect.fail(
          invalid(
            "invalid-initiative",
            path,
            `Promotion initiativeId '${promotion.initiativeId}' does not match record ID '${id}'.`,
            "promotions.initiativeId",
          ),
        )
      }
      const milestone = milestones.find((candidate) =>
        candidate.assertions.some((assertion) => assertion.id === promotion.assertionId),
      )
      if (milestone === undefined) {
        return yield* Effect.fail(
          invalid(
            "invalid-initiative",
            path,
            `Promotion references unknown assertion '${promotion.assertionId}'.`,
            "promotions.assertionId",
          ),
        )
      }
      if (milestone.id !== promotion.milestoneId) {
        return yield* Effect.fail(
          invalid(
            "invalid-initiative",
            path,
            `Promotion milestone '${promotion.milestoneId}' does not contain assertion '${promotion.assertionId}'.`,
            "promotions.milestoneId",
          ),
        )
      }
      const assertion = milestone.assertions.find(
        (candidate) => candidate.id === promotion.assertionId,
      )
      if (
        assertion === undefined ||
        evidenceDigest(assertion.supports) !== promotion.evidenceDigest
      ) {
        return yield* Effect.fail(
          invalid(
            "invalid-initiative",
            path,
            `Promotion evidence does not match the support pins of assertion '${promotion.assertionId}'.`,
            "promotions.evidenceDigest",
          ),
        )
      }
      promotions.push(promotion)
    }

    return {
      schema: INITIATIVE_SCHEMA,
      id,
      title,
      createdAt,
      updatedAt,
      revision: input.revision,
      scope,
      milestones,
      promotions,
    }
  })
