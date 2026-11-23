import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { makeTempBase, parseJson, runCliProcess } from "../test-support.js"
import {
  DEFAULT_GIT_DIFF_LIMITS,
  captureGitDiff,
  verifyGitRange,
} from "./git.js"
import { DEFAULT_CAPTURE_LIMITS, resolveCaptureModel } from "./config.js"
import { validateCaptureOutput } from "./evidence.js"
import {
  AUTOMATIC_MEMORY_LEASE_FILENAME,
  acquireConsolidationLock,
  readCheckpoint,
  captureRepositoryKey,
} from "./checkpoint.js"

const temporaryDirectories: string[] = []
const servers: Array<ReturnType<typeof Bun.serve>> = []

const temporaryDirectory = (prefix: string): string => {
  const directory = mkdtempSync(join(makeTempBase(), `${prefix}-`))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true)
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const git = (
  repository: string,
  args: ReadonlyArray<string>,
  options: { readonly allowFailure?: boolean } = {},
): string => {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Capture Test",
      GIT_AUTHOR_EMAIL: "capture@example.test",
      GIT_COMMITTER_NAME: "Capture Test",
      GIT_COMMITTER_EMAIL: "capture@example.test",
    },
  })
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    )
  }
  return result.stdout.trim()
}

const makeRepository = (): {
  readonly repository: string
  readonly before: string
  readonly after: string
} => {
  const repository = temporaryDirectory("slipmem-capture-repo")
  git(repository, ["init", "-q"])
  mkdirSync(join(repository, "src"))
  writeFileSync(
    join(repository, "src", "feature.ts"),
    [
      "export const stable = true",
      "export const captureEvidence = \"before\"",
      "export const tail = 1",
      "",
    ].join("\n"),
  )
  writeFileSync(join(repository, "README.md"), "# Capture fixture\n")
  git(repository, ["add", "."])
  git(repository, ["commit", "-q", "-m", "before"])
  const before = git(repository, ["rev-parse", "HEAD"])

  writeFileSync(
    join(repository, "src", "feature.ts"),
    [
      "export const stable = true",
      "export const captureEvidence = \"after\"",
      "export const tail = 2",
      "",
    ].join("\n"),
  )
  git(repository, ["add", "."])
  git(repository, ["commit", "-q", "-m", "after"])
  const after = git(repository, ["rev-parse", "HEAD"])
  return { repository, before, after }
}

const makeNoteRoot = (): string => {
  const root = temporaryDirectory("slipmem-capture-notes")
  mkdirSync(join(root, ".slipmem"))
  writeFileSync(join(root, ".slipmem", ".gitignore"), ".state/\n")
  return join(root, ".slipmem")
}

const noteFiles = (root: string): ReadonlyArray<string> =>
  readdirSync(root).filter((name) => name.endsWith(".md"))

const captureModelResponse = (
  after: string,
  path: string,
  quote: string,
): unknown => ({
  sources: [
    {
      title: "Capture evidence fixture",
      content:
        "The capture fixture keeps the after marker and its bounded test evidence.",
      tags: ["capture", "tests"],
      evidence: [{ commit: after, path, hunk: 0, quote }],
    },
  ],
})

describe("Git capture verification and bounded diff", () => {
  test("verifies exact commits and keeps the checkout read-only", () => {
    const { repository, before, after } = makeRepository()
    const headBefore = git(repository, ["rev-parse", "HEAD"])
    const statusBefore = git(repository, ["status", "--porcelain", "--untracked-files=no"])

    const verified = verifyGitRange(repository, before, after)
    expect(verified.ok).toBe(true)
    if (verified.ok) {
      expect(verified.value.before).toBe(before)
      expect(verified.value.after).toBe(after)
      expect(verified.value.head).toBe(after)
    }

    expect(git(repository, ["rev-parse", "HEAD"])).toBe(headBefore)
    expect(git(repository, ["status", "--porcelain", "--untracked-files=no"])).toBe(
      statusBefore,
    )
  })

  test("rejects short SHAs, missing commits, HEAD mismatch, and non-ancestor ranges", () => {
    const { repository, before, after } = makeRepository()
    expect(verifyGitRange(repository, before.slice(0, 12), after).ok).toBe(false)
    expect(verifyGitRange(repository, "0".repeat(40), after).ok).toBe(false)
    expect(verifyGitRange(repository, before, before).ok).toBe(false)

    const short = captureGitDiff(repository, before.slice(0, 12), after)
    expect(short.ok).toBe(false)
    if (!short.ok) {
      expect(short.error.code).toBe("invalid-commit")
    }

    git(repository, ["checkout", "-q", "-b", "sibling", before])
    writeFileSync(join(repository, "sibling.txt"), "sibling\n")
    git(repository, ["add", "."])
    git(repository, ["commit", "-q", "-m", "sibling"])
    const sibling = git(repository, ["rev-parse", "HEAD"])
    expect(verifyGitRange(repository, before, sibling).ok).toBe(true)
    expect(verifyGitRange(repository, before, after).ok).toBe(false)
    expect(verifyGitRange(repository, before, sibling).ok).toBe(true)
  })

  test("parses only bounded hunk text and excludes the note root", () => {
    const { repository, before, after } = makeRepository()
    const result = captureGitDiff(repository, before, after, {
      limits: DEFAULT_GIT_DIFF_LIMITS,
      excludedPrefixes: [".slipmem"],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const file = result.value.files.find((item) => item.path === "src/feature.ts")
    expect(file).toBeDefined()
    expect(file!.hunks.length).toBeGreaterThan(0)
    expect(file!.hunks[0]!.lines.some((line) => line.startsWith("+"))).toBe(true)
    expect(result.value.totalChars).toBeLessThanOrEqual(
      DEFAULT_GIT_DIFF_LIMITS.maxTotalPatchChars,
    )

    const tiny = captureGitDiff(repository, before, after, {
      limits: {
        ...DEFAULT_GIT_DIFF_LIMITS,
        maxTotalPatchChars: 1,
        maxFilePatchChars: 1,
      },
    })
    expect(tiny.ok).toBe(true)
    if (tiny.ok) {
      expect(tiny.value.files.every((item) => item.hunks.length === 0)).toBe(true)
      expect(tiny.value.truncated).toBe(true)
    }
  })

  test("bounds omitted detail rows and applies the configured hunk line limit", () => {
    const { repository, before } = makeRepository()
    for (let index = 0; index < 40; index++) {
      writeFileSync(
        join(repository, "src", `generated-${String(index).padStart(2, "0")}.ts`),
        `export const generated${index} = ${index}\n`,
      )
    }
    writeFileSync(
      join(repository, "src", "long-line.ts"),
      `export const longLine = "${"x".repeat(200)}"\n`,
    )
    git(repository, ["add", "."])
    git(repository, ["commit", "-q", "-m", "many files"])
    const after = git(repository, ["rev-parse", "HEAD"])

    const bounded = captureGitDiff(repository, before, after, {
      limits: {
        ...DEFAULT_GIT_DIFF_LIMITS,
        maxFiles: 4,
        maxHunkLineChars: 40,
      },
    })
    expect(bounded.ok).toBe(true)
    if (!bounded.ok) {
      return
    }
    expect(bounded.value.omittedCount).toBeGreaterThan(
      bounded.value.omitted.length,
    )
    expect(bounded.value.omitted.length).toBeLessThanOrEqual(32)

    const lineLimited = captureGitDiff(repository, before, after, {
      limits: {
        ...DEFAULT_GIT_DIFF_LIMITS,
        maxFiles: 100,
        maxHunkLineChars: 40,
      },
    })
    expect(lineLimited.ok).toBe(true)
    if (lineLimited.ok) {
      const longFile = lineLimited.value.omitted.find(
        (file) => file.path === "src/long-line.ts",
      )
      expect(longFile?.reason).toBe("line-too-long")
    }
  })

  test("rejects evidence from a different commit, path, hunk, or quote", () => {
    const { repository, before, after } = makeRepository()
    const diff = captureGitDiff(repository, before, after)
    expect(diff.ok).toBe(true)
    if (!diff.ok) {
      return
    }
    const file = diff.value.files.find((item) => item.path === "src/feature.ts")!
    const quote =
      "export const captureEvidence = \"after\"" as const
    const context = {
      repository: captureRepositoryKey(repository),
      before,
      after,
      diff: diff.value,
      limits: DEFAULT_CAPTURE_LIMITS,
    }

    const valid = validateCaptureOutput(
      captureModelResponse(after, "src/feature.ts", quote),
      context,
    )
    expect(valid.ok).toBe(true)
    if (valid.ok) {
      expect(valid.value.sources).toHaveLength(1)
      expect(valid.value.sources[0]!.evidence[0]!.hunk).toBe(0)
    }

    const invalid = validateCaptureOutput(
      {
        sources: [
          {
            title: "Wrong commit",
            content: "Wrong commit must not be written.",
            tags: [],
            evidence: [
              { commit: before, path: "src/feature.ts", hunk: 0, quote },
            ],
          },
        ],
      },
      context,
    )
    expect(invalid.ok).toBe(false)

    for (const evidence of [
      { commit: after, path: "src/not-changed.ts", hunk: 0, quote },
      { commit: after, path: "src/feature.ts", hunk: 99, quote },
      { commit: after, path: "src/feature.ts", hunk: 0, quote: "not in the diff" },
      {
        commit: after,
        path: "src/feature.ts",
        hunk: 0,
        quote: `${quote}\nexport const tail = 2`,
      },
    ]) {
      const result = validateCaptureOutput(
        {
          sources: [
            {
              title: "Bad evidence",
              content: "Bad evidence must not be written.",
              tags: [],
              evidence: [evidence],
            },
          ],
        },
        context,
      )
      expect(result.ok).toBe(false)
    }

    expect(file.hunks[0]!.lines.join("\n")).toContain(quote)
  })
})

describe("capture model configuration", () => {
  test("falls back to the shared primary chat model", () => {
    const resolved = resolveCaptureModel({
      SLIPMEM_CHAT_PROVIDER: "openai-compatible",
      SLIPMEM_CHAT_MODEL: "shared-model",
      SLIPMEM_CHAT_BASE_URL: "https://provider.example/v1",
      SLIPMEM_CHAT_API_KEY: "shared-key",
    })
    expect("error" in resolved).toBe(false)
    if ("error" in resolved) {
      return
    }
    expect(resolved.label).toBe("shared-model at https://provider.example")
    expect(resolved.egress).toBe("remote")
  })

  test("prefers capture-specific settings when both are configured", () => {
    const resolved = resolveCaptureModel({
      SLIPMEM_CAPTURE_PROVIDER: "openai-compatible",
      SLIPMEM_CAPTURE_MODEL: "capture-model",
      SLIPMEM_CAPTURE_BASE_URL: "http://127.0.0.1:8080/v1",
      SLIPMEM_CHAT_PROVIDER: "openai-compatible",
      SLIPMEM_CHAT_MODEL: "shared-model",
      SLIPMEM_CHAT_BASE_URL: "https://provider.example/v1",
      SLIPMEM_CHAT_API_KEY: "shared-key",
    })
    expect("error" in resolved).toBe(false)
    if ("error" in resolved) {
      return
    }
    expect(resolved.label).toBe("capture-model at http://127.0.0.1:8080")
    expect(resolved.egress).toBe("local")
  })

  test("still requires an explicit model when neither capture nor chat is configured", () => {
    const resolved = resolveCaptureModel({})
    expect("error" in resolved).toBe(true)
    if ("error" in resolved) {
      expect(resolved.error.message).toContain("SLIPMEM_CHAT_PROVIDER")
    }
  })

  test("rejects invalid numeric timeout and response bounds as invalid-config", () => {
    const configured = (extra: Readonly<Record<string, string>>) => ({
      SLIPMEM_CAPTURE_PROVIDER: "openai-compatible",
      SLIPMEM_CAPTURE_MODEL: "capture-model",
      SLIPMEM_CAPTURE_BASE_URL: "https://provider.example/v1",
      ...extra,
    })
    const cases = [
      ["SLIPMEM_CAPTURE_TIMEOUT_MS", "soon"],
      ["SLIPMEM_CAPTURE_TIMEOUT_MS", "0"],
      ["SLIPMEM_CAPTURE_TIMEOUT_MS", "1.5"],
      ["SLIPMEM_CAPTURE_TIMEOUT_MS", "600001"],
      ["SLIPMEM_CAPTURE_MAX_RESPONSE_BYTES", "many"],
      ["SLIPMEM_CAPTURE_MAX_RESPONSE_BYTES", "-1"],
      ["SLIPMEM_CAPTURE_MAX_RESPONSE_BYTES", "16777217"],
    ] as const

    for (const [name, value] of cases) {
      const resolved = resolveCaptureModel(configured({ [name]: value }))
      expect("error" in resolved).toBe(true)
      if ("error" in resolved) {
        expect(resolved.error.code).toBe("invalid-config")
        expect(resolved.error.field).toBe(name)
        expect(resolved.error.message).toContain(name)
      }
    }
  })

  test("accepts bounded integer timeout and response settings", () => {
    const resolved = resolveCaptureModel({
      SLIPMEM_CAPTURE_PROVIDER: "openai-compatible",
      SLIPMEM_CAPTURE_MODEL: "capture-model",
      SLIPMEM_CAPTURE_BASE_URL: "https://provider.example/v1",
      SLIPMEM_CAPTURE_TIMEOUT_MS: "1500",
      SLIPMEM_CAPTURE_MAX_RESPONSE_BYTES: "2048",
    })
    expect("error" in resolved).toBe(false)
  })
})

describe("slipmem capture git", () => {
  test("runs with only the shared primary chat model configuration", async () => {
    const { repository, before, after } = makeRepository()
    const noteRoot = makeNoteRoot()
    const quote = "export const captureEvidence = \"after\""
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify(
                  captureModelResponse(after, "src/feature.ts", quote),
                ),
              },
            },
          ],
        })
      },
    })
    servers.push(server)

    const result = await runCliProcess(
      [
        "capture",
        "git",
        "--before",
        before,
        "--after",
        after,
        "--repo",
        repository,
        "--dir",
        noteRoot,
        "--json",
      ],
      {
        env: {
          SLIPMEM_CHAT_PROVIDER: "openai-compatible",
          SLIPMEM_CHAT_MODEL: "shared-capture-model",
          SLIPMEM_CHAT_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
          SLIPMEM_CHAT_API_KEY: "shared-capture-key",
        },
      },
    )
    expect(result.code).toBe(0)
    const json = parseJson<{
      ok: boolean
      model: { label?: string; egress?: string }
    }>(result.stdout)
    expect(json.ok).toBe(true)
    expect(json.model).toMatchObject({
      label: `shared-capture-model at http://127.0.0.1:${server.port}`,
      egress: "local",
    })
    expect(noteFiles(noteRoot)).toHaveLength(1)
  })

  test("writes idempotent fleeting sources, a checkpoint, and leaves consolidation to the runtime", async () => {
    const { repository, before, after } = makeRepository()
    const noteRoot = makeNoteRoot()
    const requests: Array<Record<string, unknown>> = []
    const quote = "export const captureEvidence = \"after\""
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as Record<string, unknown>
        requests.push(body)
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify(
                  captureModelResponse(after, "src/feature.ts", quote),
                ),
              },
            },
          ],
        })
      },
    })
    servers.push(server)

    const env = {
      SLIPMEM_CAPTURE_PROVIDER: "openai-compatible",
      SLIPMEM_CAPTURE_MODEL: "capture-test-model",
      SLIPMEM_CAPTURE_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      SLIPMEM_CAPTURE_API_KEY: "capture-test-key",
    }
    const args = [
      "capture",
      "git",
      "--before",
      before,
      "--after",
      after,
      "--repo",
      repository,
      "--dir",
      noteRoot,
      "--json",
    ]

    const first = await runCliProcess(args, { env })
    expect(first.code).toBe(0)
    const firstJson = parseJson<Record<string, unknown>>(first.stdout)
    expect(firstJson.ok).toBe(true)
    expect((firstJson.sources as unknown[]).length).toBe(1)
    expect(firstJson.consolidation).toMatchObject({
      requested: false,
      status: "skipped",
    })
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request).not.toHaveProperty("tools")
    expect(request).not.toHaveProperty("tool_choice")
    expect(JSON.stringify(request)).toContain("untrustedChangedFiles")
    expect(JSON.stringify(request)).not.toContain(repository)

    const notes = noteFiles(noteRoot)
    expect(notes).toHaveLength(1)
    const note = readFileSync(join(noteRoot, notes[0]!), "utf8")
    expect(note).toContain("type: fleeting")
    expect(note).toContain("gitCapture:")
    expect(note).toContain(after)

    const checkpoint = readCheckpoint(
      noteRoot,
      captureRepositoryKey(repository),
    )
    expect(checkpoint.checkpoint?.status).toBe("captured")
    expect(checkpoint.checkpoint?.sources).toHaveLength(1)

    const second = await runCliProcess(args, { env })
    expect(second.code).toBe(0)
    expect(requests).toHaveLength(1)
    expect(noteFiles(noteRoot)).toHaveLength(1)

    // A fresh checkout carries the source note marker but not the local
    // checkpoint. Re-running must still not duplicate the source.
    rmSync(join(noteRoot, ".state", "git-capture"), {
      recursive: true,
      force: true,
    })
    const third = await runCliProcess(args, { env })
    expect(third.code).toBe(0)
    expect(requests).toHaveLength(2)
    expect(noteFiles(noteRoot)).toHaveLength(1)
    const thirdJson = parseJson<Record<string, unknown>>(third.stdout)
    expect(thirdJson.sources).toMatchObject([{ created: false }])

    expect(git(repository, ["status", "--porcelain", "--untracked-files=no"])).toBe("")
  }, 30_000)

  test("optional CLI consolidation drains the same maintenance worker immediately", async () => {
    const { repository, before, after } = makeRepository()
    const noteRoot = makeNoteRoot()
    const quote = "export const captureEvidence = \"after\""
    const requests: Array<Record<string, unknown>> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as Record<string, unknown>
        requests.push(body)
        const messages = body.messages as Array<{ content: string }>
        const prompt = messages[0]!.content
        if (prompt.includes("untrustedChangedFiles")) {
          return Response.json({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify(
                    captureModelResponse(after, "src/feature.ts", quote),
                  ),
                },
              },
            ],
          })
        }
        const parsed = JSON.parse(prompt) as {
          untrustedSources: Array<{ id: string }>
        }
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  operations: [
                    {
                      operation: "create",
                      title: "Capture fixture permanent",
                      content:
                        "The capture fixture creates a permanent only through the shared maintenance worker.",
                      tags: ["capture"],
                      sourceIds: [parsed.untrustedSources[0]!.id],
                    },
                  ],
                }),
              },
            },
          ],
        })
      },
    })
    servers.push(server)

    const env = {
      SLIPMEM_CAPTURE_PROVIDER: "openai-compatible",
      SLIPMEM_CAPTURE_MODEL: "capture-test-model",
      SLIPMEM_CAPTURE_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      SLIPMEM_CAPTURE_API_KEY: "capture-test-key",
    }

    const captured = await runCliProcess(
      [
        "capture",
        "git",
        "--before",
        before,
        "--after",
        after,
        "--repo",
        repository,
        "--dir",
        noteRoot,
        "--json",
      ],
      { env },
    )
    expect(captured.code).toBe(0)
    expect(requests).toHaveLength(1)
    expect(noteFiles(noteRoot)).toHaveLength(1)

    const consolidated = await runCliProcess(
      [
        "capture",
        "git",
        "--before",
        before,
        "--after",
        after,
        "--repo",
        repository,
        "--dir",
        noteRoot,
        "--consolidate",
        "--json",
      ],
      { env },
    )
    expect(consolidated.code).toBe(0)
    expect(requests).toHaveLength(2)
    const json = parseJson<Record<string, unknown>>(consolidated.stdout)
    expect(json.consolidation).toMatchObject({ requested: true, status: "applied" })
    const notes = noteFiles(noteRoot)
    expect(notes).toHaveLength(2)
    const permanent = notes
      .map((name) => readFileSync(join(noteRoot, name), "utf8"))
      .find((content) => content.includes("type: permanent"))
    expect(permanent).toBeDefined()
    expect(permanent).toContain("source: maintenance")

    const checkpoint = readCheckpoint(
      noteRoot,
      captureRepositoryKey(repository),
    )
    expect(checkpoint.checkpoint?.status).toBe("consolidated")
  }, 30_000)

  test("CLI consolidation uses the shared runtime lease and recovers a dead owner", () => {
    const noteRoot = makeNoteRoot()
    const leasePath = join(noteRoot, ".state", AUTOMATIC_MEMORY_LEASE_FILENAME)

    const acquired = acquireConsolidationLock(noteRoot, () => Date.now())
    if (!("lock" in acquired)) {
      throw new Error(acquired.error.message)
    }
    const record = JSON.parse(readFileSync(leasePath, "utf8")) as {
      pid: number
      token: string
    }
    expect(record.pid).toBe(process.pid)
    expect(record.token.length).toBeGreaterThan(0)

    const second = acquireConsolidationLock(noteRoot, () => Date.now())
    expect("error" in second && second.error.code).toBe("consolidation-locked")
    acquired.lock.release()
    expect(existsSync(leasePath)).toBe(false)

    mkdirSync(join(noteRoot, ".state"), { recursive: true })
    writeFileSync(
      leasePath,
      JSON.stringify({
        pid: 999_999,
        token: "dead",
        createdAt: new Date().toISOString(),
      }),
    )
    const recovered = acquireConsolidationLock(noteRoot, () => Date.now())
    if (!("lock" in recovered)) {
      throw new Error(recovered.error.message)
    }
    recovered.lock.release()
    expect(existsSync(leasePath)).toBe(false)
  })

  test("rejects --consolidate while a live runtime lease exists", async () => {
    const { repository, before, after } = makeRepository()
    const noteRoot = makeNoteRoot()
    const leasePath = join(noteRoot, ".state", AUTOMATIC_MEMORY_LEASE_FILENAME)
    mkdirSync(join(noteRoot, ".state"), { recursive: true })
    writeFileSync(
      leasePath,
      JSON.stringify({
        pid: process.pid,
        token: "live-runtime",
        createdAt: new Date().toISOString(),
      }),
    )

    let calls = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        calls++
        return Response.json({ choices: [{ message: { content: "{}" } }] })
      },
    })
    servers.push(server)

    const result = await runCliProcess(
      [
        "capture",
        "git",
        "--before",
        before,
        "--after",
        after,
        "--repo",
        repository,
        "--dir",
        noteRoot,
        "--consolidate",
        "--json",
      ],
      {
        env: {
          SLIPMEM_CAPTURE_PROVIDER: "openai-compatible",
          SLIPMEM_CAPTURE_MODEL: "capture-test-model",
          SLIPMEM_CAPTURE_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
        },
      },
    )

    expect(result.code).toBe(1)
    expect(calls).toBe(0)
    expect(noteFiles(noteRoot)).toHaveLength(0)
    const json = parseJson<{ error: { code: string; message: string } }>(
      result.stderr,
    )
    expect(json.error.code).toBe("consolidation-locked")
    expect(json.error.message).toContain("--consolidate is unsafe")
  }, 30_000)

  test("accepts the ingress-style SLIPMEM_DIR note root", async () => {
    const { repository, after } = makeRepository()
    const noteRoot = makeNoteRoot()
    const result = await runCliProcess(
      [
        "capture",
        "git",
        "--before",
        after,
        "--after",
        after,
        "--repo",
        repository,
        "--json",
      ],
      { env: { SLIPMEM_DIR: noteRoot } },
    )
    expect(result.code).toBe(0)
    const json = parseJson<Record<string, unknown>>(result.stdout)
    expect(json.reason).toBe("no-changes")
    expect(json.root).toBe(noteRoot)
  }, 30_000)

  test("rejects a HEAD mismatch before calling the model or writing notes", async () => {
    const { repository, before } = makeRepository()
    const noteRoot = makeNoteRoot()
    let calls = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        calls++
        return Response.json({ choices: [{ message: { content: "{}" } }] })
      },
    })
    servers.push(server)

    const result = await runCliProcess(
      [
        "capture",
        "git",
        "--before",
        before,
        "--after",
        before,
        "--repo",
        repository,
        "--dir",
        noteRoot,
        "--json",
      ],
      {
        env: {
          SLIPMEM_CAPTURE_PROVIDER: "openai-compatible",
          SLIPMEM_CAPTURE_MODEL: "capture-test-model",
          SLIPMEM_CAPTURE_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
        },
      },
    )
    expect(result.code).toBe(1)
    expect(calls).toBe(0)
    expect(noteFiles(noteRoot)).toHaveLength(0)
    const json = parseJson<{ error: { code: string } }>(result.stderr)
    expect(json.error.code).toBe("checkout-mismatch")
  }, 30_000)

  test("rejects unverified model evidence before writing any note", async () => {
    const { repository, before, after } = makeRepository()
    const noteRoot = makeNoteRoot()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify(
                  captureModelResponse(after, "src/not-changed.ts", "anything here"),
                ),
              },
            },
          ],
        })
      },
    })
    servers.push(server)

    const result = await runCliProcess(
      [
        "capture",
        "git",
        "--before",
        before,
        "--after",
        after,
        "--repo",
        repository,
        "--dir",
        noteRoot,
        "--json",
      ],
      {
        env: {
          SLIPMEM_CAPTURE_PROVIDER: "openai-compatible",
          SLIPMEM_CAPTURE_MODEL: "capture-test-model",
          SLIPMEM_CAPTURE_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
        },
      },
    )
    expect(result.code).toBe(1)
    expect(noteFiles(noteRoot)).toHaveLength(0)
    const json = parseJson<{ error: { code: string } }>(result.stderr)
    expect(json.error.code).toBe("evidence-invalid")
  }, 30_000)
})
