import { initializeNoteRoot } from "@slipmem/core"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { inspectService, startService, stopService } from "./lifecycle"
import {
  acquireServiceOwner,
  serviceDirectory,
  serviceLogPath,
  serviceOwnerPath,
  serviceStartLockPath,
  serviceStatePath,
} from "./state"

/**
 * Process-level tests for the per-root service lifecycle.
 *
 * Every test uses a disposable note root and a loopback OpenAI-compatible fake.
 * No ambient provider credential is inherited and no real provider is called.
 */

const rootPrefix = join(tmpdir(), "slipmem-service-")

const providerEnvKeys = [
  "SLIPMEM_AUTO_MEMORY",
  "SLIPMEM_AUTO_MEMORY_INTERVAL_MS",
  "SLIPMEM_AUTO_MEMORY_RUN_ON_START",
  "SLIPMEM_CHAT_PROVIDER",
  "SLIPMEM_CHAT_BASE_URL",
  "SLIPMEM_CHAT_MODEL",
  "SLIPMEM_CHAT_API_KEY",
  "SLIPMEM_MAINTENANCE_PROVIDER",
  "SLIPMEM_MAINTENANCE_BASE_URL",
  "SLIPMEM_MAINTENANCE_MODEL",
  "SLIPMEM_MAINTENANCE_API_KEY",
  "SLIPMEM_RECALL_PROVIDER",
  "SLIPMEM_RECALL_JEV_MODEL",
  "SLIPMEM_CAPTURE_PROVIDER",
  "SLIPMEM_CAPTURE_BASE_URL",
  "SLIPMEM_CAPTURE_MODEL",
  "SLIPMEM_CAPTURE_API_KEY",
  "SLIPMEM_SERVICE_PORT",
  "TYPESAFE_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
] as const

const baseEnv = (
  root: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  for (const key of providerEnvKeys) {
    delete env[key]
  }
  delete env.HOST
  delete env.PORT
  return {
    ...env,
    SLIPMEM_DIR: root,
    XDG_CACHE_HOME: join(root, "..", "cache"),
    XDG_STATE_HOME: join(root, "..", "state"),
    ...extra,
  }
}

const modelEnv = (
  root: string,
  baseUrl: string,
): Record<string, string> =>
  baseEnv(root, {
    SLIPMEM_CHAT_PROVIDER: "openai-compatible",
    SLIPMEM_CHAT_MODEL: "offline-service-test-model",
    SLIPMEM_CHAT_BASE_URL: `${baseUrl}/v1`,
    SLIPMEM_CHAT_API_KEY: "offline-service-test-key",
    SLIPMEM_RECALL_PROVIDER: "off",
  })

const startFakeProvider = () => {
  let calls = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 })
      }
      calls += 1
      let model = "offline-service-test-model"
      try {
        const body = (await request.json()) as { readonly model?: unknown }
        if (typeof body.model === "string") {
          model = body.model
        }
      } catch {
        // The transport always sends JSON; a malformed fixture gets a bounded
        // empty operation list below rather than an accidental live call.
      }
      return Response.json({
        id: `chatcmpl-offline-service-${calls}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: '{"operations":[]}' },
            finish_reason: "stop",
          },
        ],
      })
    },
  })
  if (server.port === undefined) {
    server.stop(true)
    throw new Error("The loopback fake provider did not receive a port.")
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.port}`,
    calls: () => calls,
  }
}

const makeRoot = async (): Promise<{ directory: string; root: string }> => {
  const directory = await mkdtemp(rootPrefix)
  const root = join(directory, ".slipmem")
  await Effect.runPromise(initializeNoteRoot(root))
  return { directory, root }
}

test(
  "two simultaneous starts produce one per-root service",
  async () => {
    const { directory, root } = await makeRoot()
    const provider = startFakeProvider()
    try {
      // An inherited web bind must not move the unauthenticated API or MCP
      // endpoint off loopback; the service owns its own host and port.
      const env = {
        ...modelEnv(root, provider.baseUrl),
        HOST: "0.0.0.0",
        PORT: "45678",
      }
      const [first, second] = await Promise.all([
        startService({ root, env }),
        startService({ root, env }),
      ])

      expect([first.status, second.status].sort()).toEqual([
        "already-running",
        "started",
      ])
      expect(first.state.pid).toBe(second.state.pid)
      expect(first.state.instanceId).toBe(second.state.instanceId)
      expect(first.state.url).toBe(second.state.url)
      expect(first.state.url).toStartWith("http://127.0.0.1:")

      const health = (await fetch(`${first.state.url}/service/health`).then(
        (response) => response.json(),
      )) as {
        readonly ok?: unknown
        readonly root?: unknown
        readonly pid?: unknown
        readonly instanceId?: unknown
      }
      expect(health.ok).toBe(true)
      expect(health.root).toBe(first.state.root)
      expect(health.pid).toBe(first.state.pid)
      expect(health.instanceId).toBe(first.state.instanceId)

      // status and stop must work without any model configuration.
      const status = await inspectService(root)
      expect(status.running).toBe(true)
      expect(status.ready).toBe(true)
      expect(status.pid).toBe(first.state.pid)

      const stopped = await stopService({ root, timeoutMs: 5_000 })
      expect(stopped.status).toBe("stopped")
      expect((await inspectService(root)).running).toBe(false)
    } finally {
      provider.server.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  },
  20_000,
)

test(
  "the service survives an MCP client disconnect",
  async () => {
    const { directory, root } = await makeRoot()
    const provider = startFakeProvider()
    try {
      const started = await startService({
        root,
        env: modelEnv(root, provider.baseUrl),
      })

      const initialize = await fetch(`${started.mcpUrl}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: {
              name: "slipmem-service-disconnect-test",
              version: "0.0.0",
            },
          },
        }),
      })
      expect(initialize.status).toBe(200)
      expect(await initialize.text()).toContain("slipmem")

      // A second client starts a request and drops it. Closing the transport
      // must not stop the server or its scoped consolidation worker.
      const controller = new AbortController()
      const dropped = fetch(`${started.mcpUrl}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
        signal: controller.signal,
      }).catch(() => undefined)
      controller.abort()
      await dropped
      await Bun.sleep(300)

      expect(() => process.kill(started.state.pid, 0)).not.toThrow()
      const status = await inspectService(root)
      expect(status.running).toBe(true)
      expect(status.ready).toBe(true)
      expect(status.pid).toBe(started.state.pid)

      const stopped = await stopService({ root, timeoutMs: 5_000 })
      expect(stopped.status).toBe("stopped")
    } finally {
      provider.server.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  },
  20_000,
)

test(
  "start fails closed without a serving chat model and leaves no registration",
  async () => {
    const { directory, root } = await makeRoot()
    try {
      const env = baseEnv(root)
      await expect(startService({ root, env })).rejects.toThrow(
        "serving requires a primary chat model",
      )

      const status = await inspectService(root)
      expect(status.running).toBe(false)
      expect(status.ready).toBe(false)
      expect(existsSync(serviceStatePath(root))).toBe(false)
      expect(existsSync(serviceOwnerPath(root))).toBe(false)
      expect(existsSync(serviceStartLockPath(root))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  20_000,
)

test(
  "a symlinked service log fails closed without truncating the target",
  async () => {
    const { directory, root } = await makeRoot()
    const outsideLog = join(directory, "outside.log")
    const sentinel = "sentinel log contents\n"
    writeFileSync(outsideLog, sentinel)
    mkdirSync(join(root, ".state", "service"), { recursive: true })
    symlinkSync(outsideLog, serviceLogPath(root))

    try {
      await expect(
        startService({
          root,
          env: baseEnv(root, {
            SLIPMEM_CHAT_PROVIDER: "openai-compatible",
            SLIPMEM_CHAT_MODEL: "offline-service-test-model",
            SLIPMEM_CHAT_BASE_URL: "http://127.0.0.1:9/v1",
            SLIPMEM_RECALL_PROVIDER: "off",
          }),
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(/service log/i)

      expect(readFileSync(outsideLog, "utf8")).toBe(sentinel)
      expect(existsSync(serviceStartLockPath(root))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  20_000,
)

test(
  "a broken application layer fails startup instead of reporting ready",
  async () => {
    // The note root and serving config are valid, so root resolution and
    // config validation pass. The layered application then fails while it
    // builds the disposable index, after the loopback listener is bound.
    const { directory, root } = await makeRoot()
    const cacheFile = join(directory, "cache-is-a-file")
    writeFileSync(cacheFile, "")
    const provider = startFakeProvider()
    try {
      await expect(
        startService({
          root,
          env: {
            ...modelEnv(root, provider.baseUrl),
            XDG_CACHE_HOME: cacheFile,
          },
          timeoutMs: 15_000,
        }),
      ).rejects.toThrow(/application layer was not ready/i)

      const status = await inspectService(root)
      expect(status.running).toBe(false)
      expect(status.ready).toBe(false)
      expect(existsSync(serviceStatePath(root))).toBe(false)
      expect(existsSync(serviceOwnerPath(root))).toBe(false)
      expect(existsSync(serviceStartLockPath(root))).toBe(false)
    } finally {
      provider.server.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  },
  20_000,
)

test("an unremovable stale owner lock fails fast instead of spinning", async () => {
  const directory = await mkdtemp(rootPrefix)
  const root = join(directory, ".slipmem")
  try {
    mkdirSync(serviceDirectory(root), { recursive: true })
    // A directory cannot be read as an owner record and cannot be unlinked.
    // The old loop swallowed every unlink error and retried forever.
    mkdirSync(serviceOwnerPath(root), { recursive: true })

    expect(() => acquireServiceOwner(root)).toThrow(
      "Could not remove the stale service owner lock",
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test(
  "separate canonical roots get separate services",
  async () => {
    const first = await makeRoot()
    const second = await makeRoot()
    const provider = startFakeProvider()
    try {
      const envFirst = modelEnv(first.root, provider.baseUrl)
      const envSecond = modelEnv(second.root, provider.baseUrl)
      const [a, b] = await Promise.all([
        startService({ root: first.root, env: envFirst }),
        startService({ root: second.root, env: envSecond }),
      ])

      expect(a.state.root).not.toBe(b.state.root)
      expect(a.state.pid).not.toBe(b.state.pid)
      expect(a.state.url).not.toBe(b.state.url)

      const healthA = await inspectService(first.root)
      const healthB = await inspectService(second.root)
      expect(healthA.running).toBe(true)
      expect(healthB.running).toBe(true)
      expect(healthA.state?.root).toBe(first.root)
      expect(healthB.state?.root).toBe(second.root)

      expect((await stopService({ root: first.root, timeoutMs: 5_000 })).status).toBe(
        "stopped",
      )
      expect((await stopService({ root: second.root, timeoutMs: 5_000 })).status).toBe(
        "stopped",
      )
    } finally {
      provider.server.stop(true)
      await rm(first.directory, { recursive: true, force: true })
      await rm(second.directory, { recursive: true, force: true })
    }
  },
  20_000,
)
