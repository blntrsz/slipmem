import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { makeMarkdownNoteRepository, scanMarkdownRoot } from "../markdown/repository.js"
import {
  makeEvidencePin,
  makeInitiativeService,
  initiativeProjectionTitle,
  renderInitiativeVerificationMarkdown,
  type EvidencePin,
  type InitiativeError,
  type InitiativeServiceShape,
} from "./index.js"

const FIXED_NOW = Date.parse("2026-11-22T12:00:00Z")

const cleanup: string[] = []

afterEach(() => {
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true })
  }
})

const fixture = (): {
  readonly base: string
  readonly root: string
  readonly evidenceRoot: string
  readonly clock: { value: number }
} => {
  const base = mkdtempSync("/tmp/opencode/slipmem-initiative-")
  cleanup.push(base)
  const root = join(base, ".slipmem")
  mkdirSync(root, { recursive: true })
  mkdirSync(join(base, "src"), { recursive: true })
  mkdirSync(join(base, "tests"), { recursive: true })
  writeFileSync(
    join(base, "src/feature.ts"),
    "export const feature = (value: number): number => value + 1\n",
    "utf8",
  )
  writeFileSync(
    join(base, "tests/feature.test.ts"),
    'import { feature } from "../src/feature"\n\nif (feature(1) !== 2) {\n  throw new Error("wrong")\n}\n',
    "utf8",
  )
  return { base, root, evidenceRoot: base, clock: { value: FIXED_NOW } }
}

const serviceFor = async (
  fixtureRoot: {
    readonly root: string
    readonly evidenceRoot: string
    readonly clock: { value: number }
  },
  options: {
    readonly mainRef?: string | null
    readonly observedRef?: string
    readonly requireMain?: boolean
  } = {},
): Promise<InitiativeServiceShape> =>
  Effect.runPromise(
    makeInitiativeService({
      root: fixtureRoot.root,
      evidenceRoot: fixtureRoot.evidenceRoot,
      now: () => fixtureRoot.clock.value,
      ...(options.mainRef === undefined ? { mainRef: null } : { mainRef: options.mainRef }),
      ...(options.observedRef === undefined
        ? {}
        : { observedRef: options.observedRef }),
      ...(options.requireMain === undefined
        ? {}
        : { requireMain: options.requireMain }),
    }),
  )

const pin = async (
  fixtureRoot: { readonly evidenceRoot: string },
  input: {
    kind: "code" | "test"
    path: string
    lineStart: number
    lineEnd: number
  },
): Promise<EvidencePin> =>
  Effect.runPromise(makeEvidencePin(fixtureRoot.evidenceRoot, input))

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim()

const notesFor = async (fixtureRoot: {
  readonly base: string
  readonly root: string
  readonly clock: { value: number }
}) =>
  Effect.runPromise(
    makeMarkdownNoteRepository({
      root: fixtureRoot.root,
      backupDir: join(fixtureRoot.base, "backups"),
      now: () => fixtureRoot.clock.value,
    }).pipe(Effect.flatMap((repository) => repository.listNotes())),
  )

const initializeGit = (base: string): void => {
  git(base, ["init", "-b", "main"])
  git(base, ["config", "user.email", "test@example.com"])
  git(base, ["config", "user.name", "Test"])
  git(base, ["add", "src", "tests"])
  git(base, ["commit", "-m", "initial"])
}

const noteFiles = (root: string): ReadonlyArray<string> =>
  readdirSync(root).filter((name) => name.endsWith(".md"))

const failure = async <A>(
  effect: Effect.Effect<A, InitiativeError>,
): Promise<InitiativeError> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) {
    throw new Error("Expected a typed failure")
  }
  const fail = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (fail === undefined || fail._tag !== "Fail") {
    throw new Error("Expected a typed failure reason")
  }
  return fail.error as InitiativeError
}

describe("initiative records", () => {
  test("store scope and milestones outside the flat note store", async () => {
    const fixtureRoot = fixture()
    mkdirSync(join(fixtureRoot.base, "docs"), { recursive: true })
    writeFileSync(
      join(fixtureRoot.base, "docs/initiative-scope.md"),
      "# Scope\n\nTrack one initiative without notes.\n",
      "utf8",
    )
    const service = await serviceFor(fixtureRoot)

    const record = await Effect.runPromise(
      service.create({
        title: "Initiative tracking",
        scope: {
          summary: "Track an initiative and its intended behavior.",
          intendedBehavior:
            "Expose a stable initiative ID, milestones, and evidence-backed assertions.",
          outOfScope: ["Spec Kit import"],
          constraints: ["Records stay outside the note/recall store"],
          sourcePath: "docs/initiative-scope.md",
        },
        milestones: [
          {
            title: "Verification",
            intendedBehavior: "Separate supported, contradicted, and not-evidenced claims.",
            assertions: [
              {
                claim: "Assertions require evidence pins.",
                supports: [],
              },
            ],
          },
        ],
      }),
    )

    expect(record.id).toStartWith("initiative-")
    expect(record.id).not.toContain("main")
    expect(record.path).toContain("/.slipmem/initiatives/")
    expect(record.scope.outOfScope).toEqual(["Spec Kit import"])
    expect(record.scope.source?.path).toBe("docs/initiative-scope.md")
    expect(record.scope.source?.contentHash).toBe(
      createHash("sha256")
        .update(readFileSync(join(fixtureRoot.base, "docs/initiative-scope.md"), "utf8"))
        .digest("hex"),
    )
    expect(noteFiles(fixtureRoot.root)).toEqual([])
    expect(
      (await Effect.runPromise(scanMarkdownRoot(fixtureRoot.root))).notes,
    ).toEqual([])
    expect(readFileSync(record.path, "utf8")).toContain("slipmem-initiative-record")
    expect(readFileSync(record.path, "utf8")).toContain("Initiative bookkeeping")

    const scope = await Effect.runPromise(service.readScope(record.id))
    expect(scope.scope.intendedBehavior).toBe(
      "Expose a stable initiative ID, milestones, and evidence-backed assertions.",
    )

    const appended = await Effect.runPromise(
      service.appendMilestone(record.id, {
        title: "Promotion",
        intendedBehavior: "Promote one supported assertion at a time.",
        assertions: [],
      }),
    )
    expect(appended.id).toBe(record.id)
    expect(appended.milestones).toHaveLength(2)
    expect(appended.revision).toBe(2)

    const withAssertion = await Effect.runPromise(
      service.appendAssertion(
        record.id,
        appended.milestones[1]!.id,
        {
          claim: "Appending an assertion keeps the initiative ID.",
          supports: [],
        },
      ),
    )
    expect(withAssertion.id).toBe(record.id)
    expect(withAssertion.revision).toBe(3)
    expect(withAssertion.milestones[1]!.assertions[0]!.id).toStartWith(
      "assertion-",
    )
  })

  test("ignore an unchecked status claim and classify evidence honestly", async () => {
    const fixtureRoot = fixture()
    const service = await serviceFor(fixtureRoot)
    const codePin = await pin(fixtureRoot, {
      kind: "code",
      path: "src/feature.ts",
      lineStart: 1,
      lineEnd: 1,
    })
    const testPin = await pin(fixtureRoot, {
      kind: "test",
      path: "tests/feature.test.ts",
      lineStart: 1,
      lineEnd: 5,
    })
    const contradiction = await pin(fixtureRoot, {
      kind: "test",
      path: "tests/feature.test.ts",
      lineStart: 3,
      lineEnd: 5,
    })

    const record = await Effect.runPromise(
      // The extra `status` field is untrusted draft data and must be ignored.
      service.create({
        title: "Evidence separation",
        scope: {
          summary: "Classify assertions by fresh evidence.",
          intendedBehavior: "No supplied status is accepted as verification.",
        },
        milestones: [
          {
            title: "Claims",
            intendedBehavior: "Each claim is checked against its own pins.",
            assertions: [
              {
                claim: "Supported claim",
                requiredEvidence: ["code", "test"],
                supports: [codePin, testPin],
              },
              {
                claim: "Not evidenced claim",
                supports: [],
                // Deliberately untrusted and ignored.
                ...({ status: "supported", verified: true } as object),
              },
              {
                claim: "Contradicted claim",
                supports: [testPin],
                contradicts: [contradiction],
              },
            ],
          },
        ],
      } as never),
    )

    const report = await Effect.runPromise(service.verify(record.id))
    expect(report.advisory).toBe(true)
    expect(report.automaticPrVerification).toBe(false)
    expect(report.automaticPromotion).toBe(false)
    expect(report.operatorActionRequired).toBe(true)
    expect(report.verificationMode).toBe("working-tree")
    expect(report.supported.map((row) => row.claim)).toEqual(["Supported claim"])
    expect(report.contradicted.map((row) => row.claim)).toEqual([
      "Contradicted claim",
    ])
    expect(report.notEvidenced.map((row) => row.claim)).toEqual([
      "Not evidenced claim",
    ])
    expect(renderInitiativeVerificationMarkdown(report)).toContain(
      "does not prove semantic truth",
    )
    expect(report.supported[0]?.evidence.every((check) => check.valid)).toBe(true)
  })

  test("a changed source invalidates a pin and blocks promotion", async () => {
    const fixtureRoot = fixture()
    const service = await serviceFor(fixtureRoot)
    const codePin = await pin(fixtureRoot, {
      kind: "code",
      path: "src/feature.ts",
      lineStart: 1,
      lineEnd: 1,
    })
    const record = await Effect.runPromise(
      service.create({
        title: "Stale evidence",
        scope: {
          summary: "Pins are exact snapshots.",
          intendedBehavior: "Changed evidence is not supported.",
        },
        milestones: [
          {
            title: "Pin",
            intendedBehavior: "Reject stale pins.",
            assertions: [
              { claim: "Pinned line", supports: [codePin] },
            ],
          },
        ],
      }),
    )

    writeFileSync(
      join(fixtureRoot.base, "src/feature.ts"),
      "export const feature = (value: number): number => value + 2\n",
      "utf8",
    )

    const report = await Effect.runPromise(service.verify(record.id))
    expect(report.supported).toHaveLength(0)
    expect(report.notEvidenced).toHaveLength(1)
    expect(report.notEvidenced[0]?.evidence[0]?.valid).toBe(false)

    const error = await failure(
      service.promote(record.id, record.milestones[0]!.assertions[0]!.id),
    )
    expect(error.code).toBe("unsupported-promotion")
    expect(error.message).toContain("not-evidenced")
  })

  test("promote one supported assertion and stay idempotent on retry", async () => {
    const fixtureRoot = fixture()
    const service = await serviceFor(fixtureRoot)
    const codePin = await pin(fixtureRoot, {
      kind: "code",
      path: "src/feature.ts",
      lineStart: 1,
      lineEnd: 1,
    })
    const record = await Effect.runPromise(
      service.create({
        title: "Promotion",
        scope: {
          summary: "Promote only clear support.",
          intendedBehavior: "Promotion is explicit and per assertion.",
        },
        milestones: [
          {
            title: "One",
            intendedBehavior: "Promote one.",
            assertions: [
              { claim: "Promotable", supports: [codePin] },
              { claim: "Not promotable", supports: [] },
            ],
          },
        ],
      }),
    )

    const first = await Effect.runPromise(
      service.promote(record.id, record.milestones[0]!.assertions[0]!.id),
    )
    expect(first.created).toBe(true)
    expect(first.record.promotions).toHaveLength(1)
    expect(first.promotion.initiativeId).toBe(record.id)
    expect(first.promotion.snapshot).toBeNull()
    expect(first.projection.status).toBe("skipped")
    expect(first.projection.reason).toBe("unversioned")
    expect(first.record.revision).toBe(2)
    expect(await notesFor(fixtureRoot)).toEqual([])

    const retry = await Effect.runPromise(
      service.promote(record.id, record.milestones[0]!.assertions[0]!.id),
    )
    expect(retry.created).toBe(false)
    expect(retry.record.revision).toBe(first.record.revision)
    expect(retry.record.promotions).toHaveLength(1)
    expect(retry.projection.status).toBe("skipped")

    const projectionError = await failure(
      service.project(record.id, record.milestones[0]!.assertions[0]!.id),
    )
    expect(projectionError.code).toBe("projection-requires-landed-main")

    const reconcile = await Effect.runPromise(service.reconcile(record.id))
    expect(reconcile.items).toHaveLength(1)
    expect(reconcile.items[0]?.result.status).toBe("skipped")
    expect(reconcile.items[0]?.result.reason).toBe("unversioned")
    expect(await notesFor(fixtureRoot)).toEqual([])

    const secondError = await failure(
      service.promote(record.id, record.milestones[0]!.assertions[1]!.id),
    )
    expect(secondError.code).toBe("unsupported-promotion")
  })

  test("verify against the trusted commit and require reachability from main", async () => {
    const fixtureRoot = fixture()
    initializeGit(fixtureRoot.base)
    const service = await serviceFor(fixtureRoot, {
      mainRef: "main",
      requireMain: true,
    })
    const codePin = await pin(fixtureRoot, {
      kind: "code",
      path: "src/feature.ts",
      lineStart: 1,
      lineEnd: 1,
    })
    const record = await Effect.runPromise(
      service.create({
        title: "Trusted snapshot",
        scope: {
          summary: "Use committed evidence.",
          intendedBehavior: "Dirty working trees do not count.",
        },
        milestones: [
          {
            title: "Snapshot",
            intendedBehavior: "Read evidence at the observed commit.",
            assertions: [{ claim: "Committed line", supports: [codePin] }],
          },
        ],
      }),
    )

    // A dirty working tree must not affect the trusted-snapshot result.
    writeFileSync(
      join(fixtureRoot.base, "src/feature.ts"),
      "export const feature = (value: number): number => value + 99\n",
      "utf8",
    )
    const report = await Effect.runPromise(service.verify(record.id))
    expect(report.verificationMode).toBe("trusted-snapshot")
    expect(report.snapshot?.reachableFromMain).toBe(true)
    expect(report.supported).toHaveLength(1)

    // A new commit on a feature branch is verified at that commit, but cannot
    // be promoted until the configured main ref contains it.
    git(fixtureRoot.base, ["checkout", "-b", "feature"])
    git(fixtureRoot.base, ["add", "src/feature.ts"])
    git(fixtureRoot.base, ["commit", "-m", "change feature"])
    const featurePin = await pin(fixtureRoot, {
      kind: "code",
      path: "src/feature.ts",
      lineStart: 1,
      lineEnd: 1,
    })
    const featureRecord = await Effect.runPromise(
      service.create({
        title: "Feature snapshot",
        scope: {
          summary: "Feature evidence.",
          intendedBehavior: "Only main-reachable evidence may promote.",
        },
        milestones: [
          {
            title: "Feature",
            intendedBehavior: "Check reachability.",
            assertions: [{ claim: "Feature line", supports: [featurePin] }],
          },
        ],
      }),
    )
    const featureReport = await Effect.runPromise(service.verify(featureRecord.id))
    expect(featureReport.snapshot?.reachableFromMain).toBe(false)
    expect(featureReport.supported).toHaveLength(1)

    const blocked = await failure(
      service.promote(
        featureRecord.id,
        featureRecord.milestones[0]!.assertions[0]!.id,
      ),
    )
    expect(blocked.code).toBe("main-required")
    expect(blocked.message).toContain("not reachable")

    git(fixtureRoot.base, ["branch", "-f", "main", "feature"])
    const promoted = await Effect.runPromise(
      service.promote(
        featureRecord.id,
        featureRecord.milestones[0]!.assertions[0]!.id,
      ),
    )
    expect(promoted.created).toBe(true)
    expect(promoted.promotion.snapshot?.reachableFromMain).toBe(true)
    expect(promoted.promotion.snapshot?.observedCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(promoted.projection.status).toBe("created")
    expect(promoted.projection.noteId).toBeString()
    expect(promoted.projection.notePath).toBeString()

    const projectedNotes = await notesFor(fixtureRoot)
    expect(projectedNotes).toHaveLength(1)
    const projected = projectedNotes[0]!
    expect(projected.metadata.type).toBe("permanent")
    expect(projected.id).toBe(promoted.projection.noteId!)
    expect(projected.body).toContain("Feature line")
    expect(projected.body).toContain("Scope:")
    const marker = projected.unknown.initiativeProjection as {
      initiativeId: string
      assertionId: string
      advisory: boolean
      evidence: ReadonlyArray<unknown>
      scope: { summary: string }
    }
    expect(marker.initiativeId).toBe(featureRecord.id)
    expect(marker.assertionId).toBe(featureRecord.milestones[0]!.assertions[0]!.id)
    expect(marker.advisory).toBe(true)
    expect(marker.evidence).toHaveLength(1)
    expect(marker.scope.summary).toBe("Feature evidence.")

    const afterPromotion = await Effect.runPromise(service.verify(featureRecord.id))
    expect(afterPromotion.supported[0]?.promotionStatus).toBe("current")
    expect(afterPromotion.milestones[0]?.status).toBe("landed")

    const projectionRetry = await Effect.runPromise(
      service.project(
        featureRecord.id,
        featureRecord.milestones[0]!.assertions[0]!.id,
      ),
    )
    expect(projectionRetry.status).toBe("existing")
    expect(projectionRetry.noteId).toBe(promoted.projection.noteId)

    const reconciled = await Effect.runPromise(
      service.reconcile(featureRecord.id),
    )
    expect(reconciled.items).toHaveLength(1)
    expect(reconciled.items[0]?.result.status).toBe("existing")
    expect(await notesFor(fixtureRoot)).toHaveLength(1)

    const retry = await Effect.runPromise(
      service.promote(
        featureRecord.id,
        featureRecord.milestones[0]!.assertions[0]!.id,
      ),
    )
    expect(retry.created).toBe(false)
    expect(retry.record.revision).toBe(promoted.record.revision)
    expect(retry.projection.status).toBe("existing")
    expect(await notesFor(fixtureRoot)).toHaveLength(1)
  })

  test("re-promotion upgrades an unversioned receipt to landed main and projects it", async () => {
    const fixtureRoot = fixture()
    const unversioned = await serviceFor(fixtureRoot)
    const codePin = await pin(fixtureRoot, {
      kind: "code",
      path: "src/feature.ts",
      lineStart: 1,
      lineEnd: 1,
    })
    const record = await Effect.runPromise(
      unversioned.create({
        title: "Upgrade projection",
        scope: {
          summary: "A landed snapshot upgrades the receipt.",
          intendedBehavior: "Project only after main reachability.",
        },
        milestones: [
          {
            title: "Upgrade",
            intendedBehavior: "No unversioned main writes.",
            assertions: [{ claim: "Upgrade claim", supports: [codePin] }],
          },
        ],
      }),
    )
    const assertion = record.milestones[0]!.assertions[0]!
    const first = await Effect.runPromise(
      unversioned.promote(record.id, assertion.id),
    )
    expect(first.created).toBe(true)
    expect(first.projection.status).toBe("skipped")
    expect(await notesFor(fixtureRoot)).toEqual([])

    initializeGit(fixtureRoot.base)
    const landed = await serviceFor(fixtureRoot, {
      mainRef: "main",
      requireMain: true,
    })
    const upgraded = await Effect.runPromise(
      landed.promote(record.id, assertion.id),
    )
    expect(upgraded.created).toBe(false)
    expect(upgraded.promotion.snapshot?.reachableFromMain).toBe(true)
    expect(upgraded.projection.status).toBe("created")
    expect(await notesFor(fixtureRoot)).toHaveLength(1)

    const retry = await Effect.runPromise(landed.promote(record.id, assertion.id))
    expect(retry.created).toBe(false)
    expect(retry.projection.status).toBe("existing")
    expect(await notesFor(fixtureRoot)).toHaveLength(1)
  })

  test("never overwrites a human permanent note with the projection title", async () => {
    const fixtureRoot = fixture()
    initializeGit(fixtureRoot.base)
    const service = await serviceFor(fixtureRoot, {
      mainRef: "main",
      requireMain: true,
    })
    const codePin = await pin(fixtureRoot, {
      kind: "code",
      path: "src/feature.ts",
      lineStart: 1,
      lineEnd: 1,
    })
    const record = await Effect.runPromise(
      service.create({
        title: "Collision initiative",
        scope: {
          summary: "Projection must not overwrite human knowledge.",
          intendedBehavior: "Create a distinct projection note.",
        },
        milestones: [
          {
            title: "Collision",
            intendedBehavior: "Keep both notes.",
            assertions: [{ claim: "Human collision", supports: [codePin] }],
          },
        ],
      }),
    )
    const assertion = record.milestones[0]!.assertions[0]!
    const repository = await Effect.runPromise(
      makeMarkdownNoteRepository({
        root: fixtureRoot.root,
        backupDir: join(fixtureRoot.base, "backups"),
        now: () => fixtureRoot.clock.value,
      }),
    )
    const human = await Effect.runPromise(
      repository.create({
        type: "permanent",
        title: initiativeProjectionTitle(record, assertion),
        content: "Human-authored note body.",
      }),
    )

    const promoted = await Effect.runPromise(
      service.promote(record.id, assertion.id),
    )
    expect(promoted.projection.status).toBe("created")
    expect(promoted.projection.noteId).not.toBe(human.id)

    const notes = await notesFor(fixtureRoot)
    expect(notes).toHaveLength(2)
    const humanAfter = notes.find((note) => note.id === human.id)!
    expect(humanAfter.body).toBe("Human-authored note body.")
    expect(humanAfter.unknown.initiativeProjection).toBeUndefined()
    const projectionNote = notes.find(
      (note) => note.id === promoted.projection.noteId,
    )!
    expect(projectionNote.unknown.initiativeProjection).toBeDefined()
  })
})
