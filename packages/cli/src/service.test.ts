import { initializeNoteRoot } from "@slipmem/core"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseJson, runCliProcess } from "./test-support"

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

const cleanEnv = (
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
  return { ...env, ...extra }
}

const startFakeProvider = () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 })
      }
      return Response.json({
        id: "chatcmpl-offline-cli-service",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "offline-cli-service-model",
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
  }
}

test(
  "service CLI starts, reports status, and stops without model config",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "slipmem-cli-service-"))
    const root = join(directory, ".slipmem")
    const provider = startFakeProvider()
    try {
      await Effect.runPromise(initializeNoteRoot(root))
      const startEnv = cleanEnv({
        SLIPMEM_CHAT_PROVIDER: "openai-compatible",
        SLIPMEM_CHAT_MODEL: "offline-cli-service-model",
        SLIPMEM_CHAT_BASE_URL: `${provider.baseUrl}/v1`,
        SLIPMEM_CHAT_API_KEY: "offline-cli-service-key",
        SLIPMEM_RECALL_PROVIDER: "off",
      })

      const started = await runCliProcess(
        ["service", "start", "--dir", root, "--json"],
        { env: startEnv },
      )
      expect(started.code).toBe(0)
      const startJson = parseJson<{
        readonly status?: string
        readonly pid?: number
        readonly mcpUrl?: string
      }>(started.stdout)
      expect(startJson.status).toBe("started")
      expect(startJson.pid).toBeGreaterThan(0)
      expect(startJson.mcpUrl).toStartWith("http://127.0.0.1:")

      const statusWithoutModel = await runCliProcess(
        ["service", "status", "--dir", root, "--json"],
        { env: cleanEnv() },
      )
      expect(statusWithoutModel.code).toBe(0)
      const statusJson = parseJson<{
        readonly running?: boolean
        readonly ready?: boolean
        readonly pid?: number
      }>(statusWithoutModel.stdout)
      expect(statusJson.running).toBe(true)
      expect(statusJson.ready).toBe(true)
      expect(statusJson.pid).toBe(startJson.pid)

      const stopped = await runCliProcess(
        ["service", "stop", "--dir", root, "--json"],
        { env: cleanEnv() },
      )
      expect(stopped.code).toBe(0)
      const stopJson = parseJson<{ readonly status?: string }>(stopped.stdout)
      expect(stopJson.status).toBe("stopped")

      const after = await runCliProcess(
        ["service", "status", "--dir", root, "--json"],
        { env: cleanEnv() },
      )
      expect(after.code).toBe(0)
      expect(parseJson<{ readonly running?: boolean }>(after.stdout).running).toBe(
        false,
      )
    } finally {
      provider.server.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  },
  20_000,
)

test(
  "service CLI start reports a missing model instead of running model-free",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "slipmem-cli-service-"))
    const root = join(directory, ".slipmem")
    try {
      await Effect.runPromise(initializeNoteRoot(root))
      const started = await runCliProcess(
        ["service", "start", "--dir", root, "--json"],
        { env: cleanEnv() },
      )
      expect(started.code).not.toBe(0)
      expect(started.stderr).toContain("serving requires a primary chat model")
      expect(existsSync(join(root, ".state", "service", "state.json"))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  20_000,
)
