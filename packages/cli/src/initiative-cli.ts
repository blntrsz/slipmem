import {
  defaultEvidenceRoot,
  makeEvidencePin,
  makeInitiativeService,
  renderInitiativeVerificationMarkdown,
  type EvidenceKind,
  type InitiativeAssertionInput,
  type InitiativeDraftInput,
  type InitiativeError,
  type InitiativeRecord,
  type MarkdownError,
} from "@slipmem/core"
import { Effect } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import {
  GLOBAL_OPTIONS,
  booleanOption,
  parseArgs,
  requireStringOption,
  stringOption,
  type OptionSpec,
} from "./args.js"
import { openRepository, resolveRoot, type CliContext } from "./context.js"
import { CliUsageError, usageError } from "./errors.js"
import { writeErrorLine, writeJson, writeLine } from "./output.js"

type CliError = InitiativeError | MarkdownError | CliUsageError

interface CommandSpec {
  readonly summary: string
  readonly options: Readonly<Record<string, OptionSpec>>
  readonly minPositionals?: number
  readonly maxPositionals?: number
  readonly run: (
    parsed: ReturnType<typeof parseArgs>,
    context: CliContext,
  ) => Effect.Effect<number, CliError>
}

const commonOptions: Readonly<Record<string, OptionSpec>> = {
  "main-ref": { type: "string", valueName: "ref" },
  "observed-ref": { type: "string", valueName: "ref" },
  "working-tree": { type: "boolean" },
}

const jsonHint = (argv: ReadonlyArray<string>): boolean =>
  argv.some((token) => token === "--json" || token === "--json=true")

const failure = (context: CliContext, error: unknown, json: boolean): number => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : String(error)
  if (json) {
    if (error instanceof CliUsageError) {
      writeErrorLine(
        context.io,
        JSON.stringify(
          {
            ok: false,
            error: { kind: "usage", code: "usage", message },
          },
          null,
          2,
        ),
      )
    } else {
      const tagged = error as Partial<{
        _tag: string
        code: string
        path: string
        field: string
        initiativeId: string
        assertionId: string
        area: string
      }>
      writeErrorLine(
        context.io,
        JSON.stringify(
          {
            ok: false,
            error: {
              kind: tagged._tag === "InitiativeError" ? "validation" : tagged._tag === "MarkdownError" ? "validation" : "internal",
              code: tagged.code ?? "internal",
              message,
              ...(tagged.path === undefined ? {} : { path: tagged.path }),
              ...(tagged.field === undefined ? {} : { field: tagged.field }),
              ...(tagged.initiativeId === undefined
                ? {}
                : { initiativeId: tagged.initiativeId }),
              ...(tagged.assertionId === undefined
                ? {}
                : { assertionId: tagged.assertionId }),
            },
          },
          null,
          2,
        ),
      )
    }
    return error instanceof CliUsageError ? 2 : 1
  }

  if (error instanceof CliUsageError) {
    writeErrorLine(context.io, `slipmem initiative: ${message}`)
    return 2
  }
  writeErrorLine(context.io, `slipmem initiative: ${message}`)
  return 1
}

const serviceFor = (
  parsed: ReturnType<typeof parseArgs>,
  context: CliContext,
) =>
  Effect.gen(function* () {
    const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
    const evidenceRoot = defaultEvidenceRoot(resolved.root)
    const repository = yield* openRepository(context, resolved.root)
    const unversioned =
      booleanOption(parsed, "allow-unversioned") ||
      booleanOption(parsed, "working-tree")
    const service = yield* makeInitiativeService({
      root: resolved.root,
      evidenceRoot,
      repository,
      now: context.now,
      mainRef: unversioned
        ? null
        : (stringOption(parsed, "main-ref") ?? "main"),
      observedRef: stringOption(parsed, "observed-ref") ?? "HEAD",
      requireMain: !unversioned,
    })
    return { service, resolved, evidenceRoot }
  })

const projectPath = (
  evidenceRoot: string,
  cwd: string,
  input: string,
): string => {
  const absolute = isAbsolute(input) ? resolve(input) : resolve(cwd, input)
  const rel = relative(evidenceRoot, absolute)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return input
  }
  return rel.split("\\").join("/")
}

const readDraftFile = (
  context: CliContext,
  evidenceRoot: string,
  input: string,
): unknown => {
  const path = isAbsolute(input)
    ? input
    : existsSync(resolve(context.cwd, input))
      ? resolve(context.cwd, input)
      : resolve(evidenceRoot, input)
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (cause) {
    throw usageError(
      `Could not read draft '${input}': ${cause instanceof Error ? cause.message : String(cause)}`,
      "initiative",
    )
  }
  try {
    return JSON.parse(raw) as unknown
  } catch (cause) {
    throw usageError(
      `Draft '${input}' is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      "initiative",
    )
  }
}

const parseLineRange = (value: string): { lineStart: number; lineEnd: number } => {
  const match = /^(\d+)[-:](\d+)$/.exec(value.trim())
  if (match === null) {
    throw usageError("--lines expects a range such as 10-20.", "initiative")
  }
  const lineStart = Number(match[1])
  const lineEnd = Number(match[2])
  if (
    !Number.isSafeInteger(lineStart) ||
    !Number.isSafeInteger(lineEnd) ||
    lineStart < 1 ||
    lineEnd < lineStart
  ) {
    throw usageError("--lines must be a one-based inclusive start-end range.", "initiative")
  }
  return { lineStart, lineEnd }
}

const evidenceKind = (value: string | undefined): EvidenceKind => {
  if (value === "code" || value === "test") {
    return value
  }
  throw usageError("--kind must be 'code' or 'test'.", "initiative")
}

const recordSummary = (record: InitiativeRecord): string => {
  const assertions = record.milestones.reduce(
    (total, milestone) => total + milestone.assertions.length,
    0,
  )
  return `${record.id}  ${record.title}  (revision ${record.revision}, ${record.milestones.length} milestones, ${assertions} assertions, ${record.promotions.length} promoted)`
}

const definitions: Readonly<Record<string, CommandSpec>> = {
  create: {
    summary: "Create a durable initiative record without creating a note",
    options: {
      title: { type: "string", valueName: "title" },
      scope: { type: "string", valueName: "text" },
      "intended-behavior": { type: "string", valueName: "text" },
      "scope-file": { type: "string", valueName: "path" },
      draft: { type: "string", valueName: "path" },
      "milestone-title": { type: "string", valueName: "title" },
      "milestone-behavior": { type: "string", valueName: "text" },
    },
    run: (parsed, context) => {
      const draftPath = stringOption(parsed, "draft")
      const title =
        draftPath === undefined
          ? requireStringOption(parsed, "title", "initiative")
          : undefined
      const summary =
        draftPath === undefined
          ? requireStringOption(parsed, "scope", "initiative")
          : undefined
      const intendedBehavior =
        draftPath === undefined
          ? requireStringOption(parsed, "intended-behavior", "initiative")
          : undefined
      const scopeFile = stringOption(parsed, "scope-file")
      const milestoneTitle =
        stringOption(parsed, "milestone-title") ?? "Initial milestone"
      const milestoneBehavior =
        stringOption(parsed, "milestone-behavior") ?? intendedBehavior

      return Effect.gen(function* () {
        const opened = yield* serviceFor(parsed, context)
        let draft: unknown
        if (draftPath !== undefined) {
          draft = readDraftFile(context, opened.evidenceRoot, draftPath)
        } else {
          draft = {
            title,
            scope: {
              summary,
              intendedBehavior,
              ...(scopeFile === undefined
                ? {}
                : {
                    sourcePath: projectPath(
                      opened.evidenceRoot,
                      context.cwd,
                      scopeFile,
                    ),
                  }),
            },
            milestones: [
              {
                title: milestoneTitle,
                intendedBehavior: milestoneBehavior,
                assertions: [],
              },
            ],
          }
        }

        const record = yield* opened.service.create(draft as InitiativeDraftInput)
        if (parsed.options.json === true) {
          writeJson(context.io, { ok: true, initiative: record })
        } else {
          writeLine(context.io, `Created initiative ${record.id}`)
          writeLine(context.io, `  ${record.path}`)
          writeLine(
            context.io,
            "  Drafts stay in the nested initiative record; no note was created.",
          )
        }
        return 0
      })
    },
  },
  list: {
    summary: "List durable initiative records",
    options: {},
    run: (parsed, context) =>
      Effect.gen(function* () {
        const opened = yield* serviceFor(parsed, context)
        const scan = yield* opened.service.scan()
        if (parsed.options.json === true) {
          writeJson(context.io, {
            ok: true,
            root: opened.resolved.root,
            initiatives: scan.initiatives.map((record) => ({
              id: record.id,
              title: record.title,
              path: record.path,
              updatedAt: record.updatedAt,
              revision: record.revision,
              milestoneCount: record.milestones.length,
              assertionCount: record.milestones.reduce(
                (total, milestone) => total + milestone.assertions.length,
                0,
              ),
              promotionCount: record.promotions.length,
            })),
            invalid: scan.invalid,
          })
        } else {
          writeLine(context.io, `Initiatives in ${opened.service.directory}`)
          if (scan.initiatives.length === 0) {
            writeLine(context.io, "  (none)")
          }
          for (const record of scan.initiatives) {
            writeLine(context.io, `  ${recordSummary(record)}`)
          }
          for (const error of scan.invalid) {
            writeErrorLine(
              context.io,
              `  invalid: ${error.path}: ${error.message}`,
            )
          }
        }
        return scan.invalid.length === 0 ? 0 : 1
      }),
  },
  show: {
    summary: "Show one initiative record",
    options: {},
    minPositionals: 1,
    maxPositionals: 1,
    run: (parsed, context) =>
      Effect.gen(function* () {
        const opened = yield* serviceFor(parsed, context)
        const record = yield* opened.service.get(parsed.positionals[0]!)
        if (parsed.options.json === true) {
          writeJson(context.io, { ok: true, initiative: record })
        } else {
          writeLine(context.io, recordSummary(record))
          writeLine(context.io, `  ${record.path}`)
          writeLine(context.io, `  scope: ${record.scope.summary}`)
          writeLine(
            context.io,
            `  intended behavior: ${record.scope.intendedBehavior}`,
          )
          if (record.scope.source !== undefined) {
            writeLine(
              context.io,
              `  scope source: ${record.scope.source.path} (${record.scope.source.contentHash.slice(0, 12)}…)`,
            )
          }
        }
        return 0
      }),
  },
  scope: {
    summary: "Read an initiative's scope and intended behavior",
    options: {},
    minPositionals: 1,
    maxPositionals: 1,
    run: (parsed, context) =>
      Effect.gen(function* () {
        const opened = yield* serviceFor(parsed, context)
        const view = yield* opened.service.readScope(parsed.positionals[0]!)
        if (parsed.options.json === true) {
          writeJson(context.io, { ok: true, ...view })
        } else {
          writeLine(context.io, `${view.id}  ${view.title}`)
          writeLine(context.io, `  ${view.path}`)
          writeLine(context.io, `  revision: ${view.revision}`)
          writeLine(context.io, "  summary:")
          writeLine(context.io, `    ${view.scope.summary}`)
          writeLine(context.io, "  intended behavior:")
          writeLine(context.io, `    ${view.scope.intendedBehavior}`)
          if (view.scope.outOfScope.length > 0) {
            writeLine(context.io, "  out of scope:")
            for (const item of view.scope.outOfScope) {
              writeLine(context.io, `    - ${item}`)
            }
          }
          if (view.scope.constraints.length > 0) {
            writeLine(context.io, "  constraints:")
            for (const item of view.scope.constraints) {
              writeLine(context.io, `    - ${item}`)
            }
          }
          if (view.scope.source !== undefined) {
            writeLine(
              context.io,
              `  source: ${view.scope.source.path} (${view.scope.source.contentHash.slice(0, 12)}…, ${view.scope.source.bytes} bytes)`,
            )
          }
        }
        return 0
      }),
  },
  verify: {
    summary: "Run advisory evidence checks against the trusted snapshot",
    options: {},
    minPositionals: 1,
    maxPositionals: 1,
    run: (parsed, context) =>
      Effect.gen(function* () {
        const opened = yield* serviceFor(parsed, context)
        const report = yield* opened.service.verify(parsed.positionals[0]!)
        if (parsed.options.json === true) {
          writeJson(context.io, { ok: true, report })
        } else {
          context.io.out(renderInitiativeVerificationMarkdown(report))
        }
        return 0
      }),
  },
  promote: {
    summary: "Promote one freshly supported assertion, one at a time",
    options: {
      "allow-unversioned": { type: "boolean" },
    },
    minPositionals: 2,
    maxPositionals: 2,
    run: (parsed, context) =>
      Effect.gen(function* () {
        const opened = yield* serviceFor(parsed, context)
        const result = yield* opened.service.promote(
          parsed.positionals[0]!,
          parsed.positionals[1]!,
        )
        if (parsed.options.json === true) {
          writeJson(context.io, { ok: true, ...result })
        } else {
          writeLine(
            context.io,
            `${result.created ? "Promoted" : "Already promoted"} ${result.promotion.assertionId} in ${result.record.id}`,
          )
          writeLine(
            context.io,
            `  evidence snapshot: ${result.promotion.snapshot === null ? "working tree (unversioned)" : `commit ${result.promotion.snapshot.observedCommit}`}`,
          )
          writeLine(
            context.io,
            `  main note projection: ${result.projection.status}${result.projection.reason === undefined ? "" : ` (${result.projection.reason})`}${result.projection.noteId === undefined ? "" : ` ${result.projection.noteId}`}`,
          )
          if (result.projection.status === "skipped") {
            writeLine(
              context.io,
              "  No note was written to the main store without a landed, main-reachable snapshot.",
            )
          }
          writeLine(
            context.io,
            "  Advisory: promotion records pinned evidence, not semantic truth.",
          )
        }
        return 0
      }),
  },
  project: {
    summary: "Project one promoted assertion into a permanent main note",
    options: {},
    minPositionals: 2,
    maxPositionals: 2,
    run: (parsed, context) =>
      Effect.gen(function* () {
        const opened = yield* serviceFor(parsed, context)
        const result = yield* opened.service.project(
          parsed.positionals[0]!,
          parsed.positionals[1]!,
        )
        if (parsed.options.json === true) {
          writeJson(context.io, { ok: true, projection: result })
        } else {
          writeLine(
            context.io,
            `Projection ${result.status} for ${result.assertionId}${result.reason === undefined ? "" : ` (${result.reason})`}`,
          )
          if (result.noteId !== undefined) {
            writeLine(context.io, `  ${result.noteId}`)
            writeLine(context.io, `  ${result.notePath}`)
          }
        }
        return 0
      }),
  },
  reconcile: {
    summary: "Idempotently reconcile promoted assertions into main notes",
    options: {},
    minPositionals: 0,
    maxPositionals: 1,
    run: (parsed, context) =>
      Effect.gen(function* () {
        const opened = yield* serviceFor(parsed, context)
        const report = yield* opened.service.reconcile(parsed.positionals[0])
        if (parsed.options.json === true) {
          writeJson(context.io, { ok: true, report })
        } else {
          writeLine(context.io, `Projection reconcile (${report.items.length} item(s))`)
          for (const item of report.items) {
            const result = item.result
            writeLine(
              context.io,
              `  ${item.initiativeId} / ${item.assertionId}: ${result.status}${result.reason === undefined ? "" : ` (${result.reason})`}${result.noteId === undefined ? "" : ` ${result.noteId}`}`,
            )
          }
        }
        return 0
      }),
  },
  pin: {
    summary: "Read source and compute an exact evidence pin",
    options: {
      kind: { type: "string", valueName: "code|test" },
      lines: { type: "string", valueName: "start-end" },
      note: { type: "string", valueName: "text" },
    },
    minPositionals: 1,
    maxPositionals: 1,
    run: (parsed, context) => {
      const kind = evidenceKind(stringOption(parsed, "kind"))
      const range = parseLineRange(
        requireStringOption(parsed, "lines", "initiative"),
      )
      const note = stringOption(parsed, "note")
      return Effect.gen(function* () {
        const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
        const evidenceRoot = defaultEvidenceRoot(resolved.root)
        const pin = yield* makeEvidencePin(evidenceRoot, {
          kind,
          path: projectPath(evidenceRoot, context.cwd, parsed.positionals[0]!),
          lineStart: range.lineStart,
          lineEnd: range.lineEnd,
          ...(note === undefined ? {} : { note }),
        })
        if (parsed.options.json === true) {
          writeJson(context.io, { ok: true, pin })
        } else {
          writeLine(context.io, JSON.stringify(pin, null, 2))
        }
        return 0
      })
    },
  },
  milestone: {
    summary: "Add a milestone to an existing initiative",
    options: {
      title: { type: "string", valueName: "title" },
      scope: { type: "string", valueName: "text" },
      "intended-behavior": { type: "string", valueName: "text" },
    },
    minPositionals: 2,
    maxPositionals: 2,
    run: (parsed, context) => {
      const title = requireStringOption(parsed, "title", "initiative")
      const intendedBehavior = requireStringOption(
        parsed,
        "intended-behavior",
        "initiative",
      )
      const scope = stringOption(parsed, "scope")
      return Effect.gen(function* () {
        if (parsed.positionals[0] !== "add") {
          return yield* Effect.fail(
            usageError(
              "Usage: initiative milestone add <initiative-id> [options]",
              "initiative",
            ),
          )
        }
        const opened = yield* serviceFor(parsed, context)
        const record = yield* opened.service.appendMilestone(
          parsed.positionals[1]!,
          {
            title,
            ...(scope === undefined ? {} : { scope }),
            intendedBehavior,
            assertions: [],
          },
        )
        if (parsed.options.json === true) {
          writeJson(context.io, { ok: true, initiative: record })
        } else {
          writeLine(context.io, `Added milestone to ${record.id}`)
          writeLine(context.io, `  ${record.path}`)
        }
        return 0
      })
    },
  },
  assertion: {
    summary: "Add an assertion draft to a milestone",
    options: {
      draft: { type: "string", valueName: "path" },
      claim: { type: "string", valueName: "text" },
      "intended-behavior": { type: "string", valueName: "text" },
    },
    minPositionals: 3,
    maxPositionals: 3,
    run: (parsed, context) => {
      const draftPath = stringOption(parsed, "draft")
      const claim =
        draftPath === undefined
          ? requireStringOption(parsed, "claim", "initiative")
          : undefined
      const intendedBehavior = stringOption(parsed, "intended-behavior")
      return Effect.gen(function* () {
        if (parsed.positionals[0] !== "add") {
          return yield* Effect.fail(
            usageError(
              "Usage: initiative assertion add <initiative-id> <milestone-id> [options]",
              "initiative",
            ),
          )
        }
        const opened = yield* serviceFor(parsed, context)
        const draft =
          draftPath === undefined
            ? {
                claim,
                ...(intendedBehavior === undefined
                  ? {}
                  : { intendedBehavior }),
                supports: [],
                contradicts: [],
              }
            : readDraftFile(context, opened.evidenceRoot, draftPath)
        const record = yield* opened.service.appendAssertion(
          parsed.positionals[1]!,
          parsed.positionals[2]!,
          draft as InitiativeAssertionInput,
        )
        if (parsed.options.json === true) {
          writeJson(context.io, { ok: true, initiative: record })
        } else {
          writeLine(context.io, `Added assertion to ${record.id}`)
          writeLine(context.io, `  ${record.path}`)
        }
        return 0
      })
    },
  },
}

const help = (): string => {
  const lines = [
    "Usage: slipmem initiative <command> [options]",
    "       bun packages/cli/src/main-initiative.ts <command> [options]",
    "",
    "Durable initiative scope, milestones, advisory verification, and explicit",
    "per-assertion promotion. Initiative records live under .slipmem/initiatives/",
    "and are never notes, search-index entries, or recall candidates.",
    "",
    "Commands:",
  ]
  for (const [name, definition] of Object.entries(definitions)) {
    lines.push(`  ${name.padEnd(12)} ${definition.summary}`)
  }
  lines.push(
    "",
    "Disclosure: verification only checks explicitly pinned code/test lines",
    "against the observed Git snapshot. It does not run a PR check, infer",
    "support, or promote automatically; an operator must add pins and request",
    "each promotion. Use --main-ref (default main) and --observed-ref (default",
    "HEAD) to select the trusted snapshot; --working-tree is an explicit",
    "unversioned opt-out. Without Git, reports say 'working-tree'.",
    "Promotion also projects the selected assertion into one permanent note",
    "when the promotion snapshot is landed on main; unversioned promotions",
    "skip the note write. Existing projection notes are reused, never",
    "overwritten, and `reconcile` repairs missing projections idempotently.",
  )
  return `${lines.join("\n")}\n`
}

/**
 * Standalone initiative CLI. The root `slipmem` dispatcher is intentionally not
 * edited here; its owner can register this command after handoff.
 */
export const runInitiativeCli = async (
  argv: ReadonlyArray<string>,
  context: CliContext,
): Promise<number> => {
  const json = jsonHint(argv)
  try {
    const name = argv[0]
    if (name === undefined || name === "help" || name === "--help" || name === "-h") {
      context.io.out(help())
      return 0
    }
    const definition = definitions[name]
    if (definition === undefined) {
      throw usageError(
        `Unknown initiative command '${name}'. Run 'initiative help' for usage.`,
        "initiative",
      )
    }
    const parsed = parseArgs(
      argv.slice(1),
      { ...GLOBAL_OPTIONS, ...commonOptions, ...definition.options },
      {
        command: `initiative ${name}`,
        ...(definition.minPositionals === undefined
          ? {}
          : { minPositionals: definition.minPositionals }),
        ...(definition.maxPositionals === undefined
          ? {}
          : { maxPositionals: definition.maxPositionals }),
      },
    )
    if (parsed.options.help === true) {
      context.io.out(help())
      return 0
    }

    const exit = await Effect.runPromise(
      Effect.match(definition.run(parsed, context), {
        onFailure: (error) => failure(context, error, parsed.options.json === true),
        onSuccess: (code) => code,
      }),
    )
    return exit
  } catch (error) {
    return failure(context, error, json)
  }
}

export { definitions as initiativeCommands }
