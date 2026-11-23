import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  formatGitIngressNotice,
  GIT_INGRESS_PATH,
  makeGitIngressHandler,
  resolveGitIngressConfig,
  type GitIngressEnabled,
  type GitIngressRunInput,
} from "./git-ingress"

const TOKEN = "test-ingress-token-that-is-at-least-32-characters"
const BEFORE = "a".repeat(40)
const AFTER = "b".repeat(40)
const COMMIT = "c".repeat(40)

const enabledConfig = (
  overrides: Partial<GitIngressEnabled> = {},
): GitIngressEnabled => ({
  enabled: true,
  path: GIT_INGRESS_PATH,
  repository: "/tmp/trusted-worktree",
  token: TOKEN,
  command: ["capture", "--before", "{before}", "--after", "{after}"],
  timeoutMs: 5_000,
  maxCommits: 20,
  captureModel: "fixture at http://127.0.0.1:1",
  captureEgress: "local",
  ...overrides,
})

const request = (
  body: unknown,
  headers: Record<string, string> = {},
): Request =>
  new Request(`http://localhost${GIT_INGRESS_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: JSON.stringify(body),
  })

const call = async (
  handler: ReturnType<typeof makeGitIngressHandler>,
  input: Request,
): Promise<{ readonly status: number; readonly body: any }> => {
  const response = await Effect.runPromise(
    handler(HttpServerRequest.fromWeb(input)),
  )
  const web = HttpServerResponse.toWeb(response)
  return { status: web.status, body: await web.json() }
}

test("the ingress is disabled by default and adds no route", () => {
  expect(resolveGitIngressConfig({})).toEqual({ enabled: false })
  expect(formatGitIngressNotice({ enabled: false })).toBeUndefined()
})

test("enabling the ingress requires a token, trusted repo, command, and capture model", () => {
  expect(() =>
    resolveGitIngressConfig({ SLIPMEM_GIT_INGRESS: "on" }),
  ).toThrow("SLIPMEM_GIT_INGRESS_TOKEN")

  expect(() =>
    resolveGitIngressConfig({
      SLIPMEM_GIT_INGRESS: "on",
      SLIPMEM_GIT_INGRESS_TOKEN: "short",
    }),
  ).toThrow("at least 32 characters")

  expect(() =>
    resolveGitIngressConfig({
      SLIPMEM_GIT_INGRESS: "on",
      SLIPMEM_GIT_INGRESS_TOKEN: TOKEN,
      SLIPMEM_GIT_INGRESS_REPO: "/tmp",
    }),
  ).toThrow("must be a Git worktree")
})

test("an enabled ingress requires an explicit capture model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-git-ingress-config-"))
  try {
    await Bun.$`git init -q ${directory}`.quiet()
    const base = {
      SLIPMEM_GIT_INGRESS: "on",
      SLIPMEM_GIT_INGRESS_TOKEN: TOKEN,
      SLIPMEM_GIT_INGRESS_REPO: directory,
      SLIPMEM_GIT_INGRESS_COMMAND: JSON.stringify([
        "capture",
        "{before}",
        "{after}",
      ]),
    }
    expect(() =>
      resolveGitIngressConfig({
        ...base,
        SLIPMEM_GIT_INGRESS_COMMAND: JSON.stringify(["capture"]),
      }),
    ).toThrow("{before}")

    expect(() => resolveGitIngressConfig(base)).toThrow(
      "SLIPMEM_CAPTURE_PROVIDER=openai-compatible",
    )
    expect(() =>
      resolveGitIngressConfig({
        ...base,
        SLIPMEM_CAPTURE_PROVIDER: "openai-compatible",
      }),
    ).toThrow("SLIPMEM_CAPTURE_MODEL")
    expect(() =>
      resolveGitIngressConfig({
        ...base,
        SLIPMEM_CAPTURE_PROVIDER: "openai-compatible",
        SLIPMEM_CAPTURE_MODEL: "fixture",
      }),
    ).toThrow("SLIPMEM_CAPTURE_BASE_URL")

    // The shared serving chat model is the documented fallback, so one
    // operator configuration serves /mcp, consolidation, and capture.
    const shared = resolveGitIngressConfig({
      ...base,
      SLIPMEM_CHAT_PROVIDER: "openai-compatible",
      SLIPMEM_CHAT_MODEL: "shared-model",
      SLIPMEM_CHAT_BASE_URL: "https://chat.example/v1",
    })
    expect(shared.enabled).toBe(true)
    if (shared.enabled) {
      expect(shared.captureModel).toBe("shared-model at https://chat.example")
      expect(shared.captureEgress).toBe("remote")
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("an enabled ingress falls back to the shared primary chat model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-git-ingress-chat-"))
  try {
    await Bun.$`git init -q ${directory}`.quiet()
    const base = {
      SLIPMEM_GIT_INGRESS: "on",
      SLIPMEM_GIT_INGRESS_TOKEN: TOKEN,
      SLIPMEM_GIT_INGRESS_REPO: directory,
      SLIPMEM_GIT_INGRESS_COMMAND: JSON.stringify([
        "capture",
        "{before}",
        "{after}",
      ]),
      SLIPMEM_CHAT_PROVIDER: "openai-compatible",
      SLIPMEM_CHAT_MODEL: "shared-model",
      SLIPMEM_CHAT_BASE_URL: "http://127.0.0.1:1/v1",
    }
    const resolved = resolveGitIngressConfig(base)
    expect(resolved.enabled).toBe(true)
    if (resolved.enabled) {
      expect(resolved.captureModel).toBe("shared-model at http://127.0.0.1:1")
      expect(resolved.captureEgress).toBe("local")
    }

    const explicit = resolveGitIngressConfig({
      ...base,
      SLIPMEM_CAPTURE_PROVIDER: "openai-compatible",
      SLIPMEM_CAPTURE_MODEL: "capture-model",
      SLIPMEM_CAPTURE_BASE_URL: "https://capture.example/v1",
    })
    expect(explicit.enabled).toBe(true)
    if (explicit.enabled) {
      expect(explicit.captureModel).toBe("capture-model at https://capture.example")
      expect(explicit.captureEgress).toBe("remote")
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("a token file is accepted and inline/file tokens are mutually exclusive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-git-ingress-token-"))
  try {
    await Bun.$`git init -q ${directory}`.quiet()
    const tokenFile = join(directory, "token")
    await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 })
    const env = {
      SLIPMEM_GIT_INGRESS: "on",
      SLIPMEM_GIT_INGRESS_TOKEN_FILE: tokenFile,
      SLIPMEM_GIT_INGRESS_REPO: directory,
      SLIPMEM_GIT_INGRESS_COMMAND: JSON.stringify([
        "capture",
        "{before}",
        "{after}",
      ]),
      SLIPMEM_CAPTURE_PROVIDER: "openai-compatible",
      SLIPMEM_CAPTURE_MODEL: "fixture",
      SLIPMEM_CAPTURE_BASE_URL: "http://127.0.0.1:1/v1",
    }
    const resolved = resolveGitIngressConfig(env)
    expect(resolved.enabled).toBe(true)
    if (resolved.enabled) {
      expect(resolved.token).toBe(TOKEN)
      expect(resolved.captureEgress).toBe("local")
      const notice = formatGitIngressNotice(resolved, true)
      expect(notice).toContain("accepts only exact commit SHAs")
      expect(notice).not.toContain(TOKEN)
      expect(notice).not.toContain("SLIPMEM_CAPTURE_API_KEY")
    }

    expect(() =>
      resolveGitIngressConfig({
        ...env,
        SLIPMEM_GIT_INGRESS_TOKEN: TOKEN,
      }),
    ).toThrow("not both")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("missing or wrong bearer tokens are rejected before the capture command runs", async () => {
  let calls = 0
  const handler = makeGitIngressHandler({
    config: enabledConfig(),
    noteRoot: "/tmp/notes",
    run: async () => {
      calls += 1
      return { exitCode: 0, timedOut: false, outputTruncated: false }
    },
  })

  const missing = await call(handler, request({ before: BEFORE, after: AFTER }, {
    authorization: "",
  }))
  expect(missing.status).toBe(401)
  expect(missing.body.code).toBe("unauthorized")

  const wrong = await call(handler, request({ before: BEFORE, after: AFTER }, {
    authorization: "Bearer wrong-token",
  }))
  expect(wrong.status).toBe(401)
  expect(calls).toBe(0)
})

test("the caller may send only exact non-zero SHAs, never paths", async () => {
  const seen: GitIngressRunInput[] = []
  const handler = makeGitIngressHandler({
    config: enabledConfig(),
    noteRoot: "/tmp/notes",
    run: async (input) => {
      seen.push(input)
      return { exitCode: 0, timedOut: false, outputTruncated: false }
    },
  })

  for (const body of [
    { before: BEFORE, after: AFTER, repository: "/etc" },
    { before: BEFORE, after: AFTER, path: "../../etc" },
    { before: BEFORE, after: AFTER, commits: ["../../etc/passwd"] },
    { before: BEFORE.slice(0, 12), after: AFTER },
    { before: "0".repeat(40), after: AFTER },
    { before: BEFORE, after: "main" },
  ]) {
    const rejected = await call(handler, request(body))
    expect(rejected.status).toBe(400)
  }
  expect(seen).toHaveLength(0)
})

test("accepted SHAs reach the configured command exactly once", async () => {
  const seen: GitIngressRunInput[] = []
  const handler = makeGitIngressHandler({
    config: enabledConfig(),
    noteRoot: "/tmp/notes",
    maintenanceEnabled: true,
    run: async (input) => {
      seen.push(input)
      return { exitCode: 0, timedOut: false, outputTruncated: false }
    },
  })

  const response = await call(
    handler,
    request({
      before: BEFORE,
      after: AFTER,
      commits: [COMMIT, COMMIT, AFTER],
    }),
  )
  expect(response.status).toBe(200)
  expect(response.body).toEqual(
    expect.objectContaining({
      ok: true,
      before: BEFORE,
      after: AFTER,
      commits: [COMMIT, AFTER],
      durable: true,
      consolidation: "queued for the in-process maintenance watcher",
    }),
  )
  expect(seen).toHaveLength(1)
  expect(seen[0]).toEqual(
    expect.objectContaining({
      repository: "/tmp/trusted-worktree",
      noteRoot: "/tmp/notes",
      before: BEFORE,
      after: AFTER,
      commits: [COMMIT, AFTER],
    }),
  )
  expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
})

test("capture failures are reported without leaking command output", async () => {
  const handler = makeGitIngressHandler({
    config: enabledConfig(),
    noteRoot: "/tmp/notes",
    run: async () => ({
      exitCode: 1,
      timedOut: false,
      outputTruncated: false,
    }),
  })
  const response = await call(handler, request({ before: BEFORE, after: AFTER }))
  expect(response.status).toBe(502)
  expect(response.body.code).toBe("capture-failed")
  expect(JSON.stringify(response.body)).not.toContain("/tmp/trusted-worktree")
})

test("browser origins and non-JSON bodies are refused", async () => {
  let calls = 0
  const handler = makeGitIngressHandler({
    config: enabledConfig(),
    noteRoot: "/tmp/notes",
    run: async () => {
      calls += 1
      return { exitCode: 0, timedOut: false, outputTruncated: false }
    },
  })

  const origin = await call(
    handler,
    request({ before: BEFORE, after: AFTER }, { origin: "https://example.com" }),
  )
  expect(origin.status).toBe(403)

  const text = await call(
    handler,
    new Request(`http://localhost${GIT_INGRESS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        authorization: `Bearer ${TOKEN}`,
      },
      body: "before=x",
    }),
  )
  expect(text.status).toBe(415)
  expect(calls).toBe(0)
})

test("the production runner substitutes SHAs into trusted argv without a shell", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-git-ingress-run-"))
  const output = join(directory, "capture.out")
  const previousCaptureKey = process.env.SLIPMEM_CAPTURE_API_KEY
  const previousAmbient = process.env.SLIPMEM_TEST_AMBIENT_SECRET
  process.env.SLIPMEM_CAPTURE_API_KEY = "capture-test-key"
  process.env.SLIPMEM_TEST_AMBIENT_SECRET = "ambient-secret"
  try {
    const script = join(directory, "capture.sh")
    await writeFile(
      script,
      `#!/bin/sh\nprintf '%s|%s|%s|%s|%s|%s|%s|%s|%s' "$1" "$2" "$SLIPMEM_GIT_BEFORE" "$SLIPMEM_GIT_AFTER" "$SLIPMEM_GIT_REPOSITORY" "$SLIPMEM_DIR" "\${SLIPMEM_GIT_INGRESS_TOKEN-unset}" "\${SLIPMEM_CAPTURE_API_KEY-unset}" "\${SLIPMEM_TEST_AMBIENT_SECRET-unset}" > ${output}\n`,
      { mode: 0o700 },
    )
    const handler = makeGitIngressHandler({
      config: enabledConfig({
        repository: directory,
        command: ["/bin/sh", script, "{before}", "{after}"],
      }),
      noteRoot: "/tmp/notes",
    })
    const response = await call(handler, request({ before: BEFORE, after: AFTER }))
    expect(response.status).toBe(200)
    expect(await Bun.file(output).text()).toBe(
      `${BEFORE}|${AFTER}|${BEFORE}|${AFTER}|${directory}|/tmp/notes|unset|capture-test-key|unset`,
    )
  } finally {
    if (previousCaptureKey === undefined) {
      delete process.env.SLIPMEM_CAPTURE_API_KEY
    } else {
      process.env.SLIPMEM_CAPTURE_API_KEY = previousCaptureKey
    }
    if (previousAmbient === undefined) {
      delete process.env.SLIPMEM_TEST_AMBIENT_SECRET
    } else {
      process.env.SLIPMEM_TEST_AMBIENT_SECRET = previousAmbient
    }
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)

test("the route mounts beside the JSON API and is absent when not mounted", async () => {
  const { initializeNoteRoot } = await import("@slipmem/core")
  const { makeApiHandler } = await import("./app")
  const { makeGitIngressLayer } = await import("./git-ingress")
  const directory = await mkdtemp(join(tmpdir(), "slipmem-git-ingress-mount-"))
  const root = join(directory, ".slipmem")
  try {
    await Effect.runPromise(initializeNoteRoot(root))
    const body = JSON.stringify({ before: BEFORE, after: AFTER })

    const disabled = makeApiHandler(root, { disableLogger: true })
    try {
      const response = await disabled.handler(
        new Request(`http://localhost${GIT_INGRESS_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${TOKEN}`,
          },
          body,
        }),
      )
      expect(response.status).toBe(404)
    } finally {
      await disabled.dispose()
    }

    const enabled = makeApiHandler(root, {
      disableLogger: true,
      extraRoutes: makeGitIngressLayer({
        config: enabledConfig({ repository: directory }),
        noteRoot: root,
        run: async () => ({
          exitCode: 0,
          timedOut: false,
          outputTruncated: false,
        }),
      }),
    })
    try {
      const response = await enabled.handler(
        new Request(`http://localhost${GIT_INGRESS_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${TOKEN}`,
          },
          body,
        }),
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(
        expect.objectContaining({ ok: true, before: BEFORE, after: AFTER }),
      )
    } finally {
      await enabled.dispose()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)

test("an oversized streamed body is rejected at the byte cap", async () => {
  let calls = 0
  const handler = makeGitIngressHandler({
    config: enabledConfig(),
    noteRoot: "/tmp/notes",
    run: async () => {
      calls += 1
      return { exitCode: 0, timedOut: false, outputTruncated: false }
    },
  })
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"before":"'))
      controller.enqueue(new Uint8Array(32 * 1024))
      controller.close()
    },
  })
  const input = new Request(`http://localhost${GIT_INGRESS_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" })
  const response = await call(handler, input)
  expect(response.status).toBe(413)
  expect(calls).toBe(0)
}, 15_000)
