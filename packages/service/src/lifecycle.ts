import { randomUUID } from "node:crypto"
import {
  closeSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { dirname, resolve } from "node:path"

import { ServiceError } from "./errors"
import {
  canonicalServiceRoot,
  ensureServiceDirectory,
  fetchServiceHealth,
  isProcessAlive,
  matchesProcessIdentity,
  processStartIdentity,
  readServiceOwner,
  readServiceState,
  removeRegistrationOwnedBy,
  removeStaleRegistration,
  serviceLogPath,
  serviceStartLockPath,
  type ServiceHealth,
  type ServiceOwner,
  type ServiceState,
} from "./state"

export const DEFAULT_START_TIMEOUT_MS = 20_000
export const DEFAULT_STOP_TIMEOUT_MS = 10_000
export const START_LOCK_STALE_MS = 15_000

export interface ServiceStatus {
  readonly root: string
  readonly running: boolean
  readonly ready: boolean
  /** A child owns the root but has not answered readiness yet. */
  readonly starting: boolean
  readonly state?: ServiceState
  readonly pid?: number
  readonly url?: string
  readonly mcpUrl?: string
  readonly healthUrl?: string
  readonly startedAt?: string
  readonly reason?: string
}

export interface InspectServiceOptions {
  readonly healthTimeoutMs?: number
}

export interface StartServiceOptions {
  readonly root: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** 0 asks the operating system for a fresh loopback port. */
  readonly port?: number
  readonly timeoutMs?: number
}

export interface StartServiceResult {
  readonly status: "started" | "already-running"
  readonly state: ServiceState
  readonly endpoint: string
  readonly mcpUrl: string
}

export interface StopServiceOptions {
  readonly root: string
  readonly timeoutMs?: number
}

export interface StopServiceResult {
  readonly status: "stopped" | "not-running"
  readonly root: string
  readonly pid?: number
  readonly forced: boolean
  readonly reason?: string
}

interface StartLockRecord {
  readonly version: 1
  readonly pid: number
  readonly identity: string | null
  readonly token: string
  readonly createdAt: string
}

interface StartLock {
  readonly path: string
  readonly token: string
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

const healthMatches = (
  health: ServiceHealth,
  state: ServiceState,
  root: string,
): boolean =>
  health.root === root &&
  health.pid === state.pid &&
  health.instanceId === state.instanceId

const statusFromState = (
  root: string,
  state: ServiceState,
  health: ServiceHealth | null,
): ServiceStatus => {
  const base = {
    root,
    running: true,
    ready: health !== null && healthMatches(health, state, root),
    starting: false,
    state,
    pid: state.pid,
    url: state.url,
    mcpUrl: `${state.url}/mcp`,
    healthUrl: `${state.url}/service/health`,
    startedAt: state.startedAt,
  }
  return base.ready
    ? base
    : {
        ...base,
        reason:
          "The registered process is alive but its loopback health endpoint is not ready.",
      }
}

const statusFromOwner = (root: string, owner: ServiceOwner): ServiceStatus => ({
  root,
  running: true,
  ready: false,
  starting: true,
  pid: owner.pid,
  reason: "The background service is starting and has not reported readiness yet.",
})

const notRunning = (
  root: string,
  reason: string,
  state?: ServiceState,
): ServiceStatus => ({
  root,
  running: false,
  ready: false,
  starting: false,
  ...(state === undefined ? {} : { state, pid: state.pid, url: state.url }),
  reason,
})

/**
 * Inspect one canonical root. Registration identity and loopback readiness are
 * separate checks: a live-but-unready process is reported as starting rather
 * than silently replaced. Model configuration is deliberately never read here.
 */
export const inspectService = async (
  root: string,
  options: InspectServiceOptions = {},
): Promise<ServiceStatus> => {
  const canonical = canonicalServiceRoot(root)
  const state = readServiceState(canonical)
  const owner = readServiceOwner(canonical)
  const ownerLive =
    owner !== null &&
    owner.root === canonical &&
    matchesProcessIdentity(owner)

  const stateBelongsToLiveOwner =
    state !== null &&
    state.root === canonical &&
    matchesProcessIdentity(state) &&
    (owner === null || !ownerLive || owner.instanceId === state.instanceId)

  if (stateBelongsToLiveOwner) {
    const health = await fetchServiceHealth(
      state.url,
      options.healthTimeoutMs ?? 1_000,
    )
    return statusFromState(canonical, state, health)
  }

  if (ownerLive) {
    return statusFromOwner(canonical, owner)
  }

  if (state !== null && state.root === canonical) {
    return {
      ...notRunning(
        canonical,
        isProcessAlive(state.pid)
          ? "The registered PID is alive but is no longer the slipmem service."
          : "The registered service process is no longer running.",
        state,
      ),
      mcpUrl: `${state.url}/mcp`,
      healthUrl: `${state.url}/service/health`,
      startedAt: state.startedAt,
    }
  }

  return notRunning(canonical, "No background service is registered for this root.")
}

const readStartLock = (path: string): StartLockRecord | null => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null
    }
    const record = value as Record<string, unknown>
    if (
      record.version !== 1 ||
      typeof record.pid !== "number" ||
      !Number.isInteger(record.pid) ||
      !(typeof record.identity === "string" || record.identity === null) ||
      typeof record.token !== "string" ||
      typeof record.createdAt !== "string"
    ) {
      return null
    }
    return {
      version: 1,
      pid: record.pid,
      identity: record.identity,
      token: record.token,
      createdAt: record.createdAt,
    }
  } catch {
    return null
  }
}

const startLockIsStale = (path: string): boolean => {
  const record = readStartLock(path)
  if (record === null) {
    try {
      return Date.now() - statSync(path).mtimeMs > START_LOCK_STALE_MS
    } catch {
      return true
    }
  }
  return !matchesProcessIdentity(record)
}

const tryAcquireStartLock = (root: string): StartLock | null => {
  ensureServiceDirectory(root)
  const path = serviceStartLockPath(root)
  const record: StartLockRecord = {
    version: 1,
    pid: process.pid,
    identity: processStartIdentity(process.pid),
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  }

  let descriptor: number | null = null
  try {
    descriptor = openSync(path, "wx", 0o600)
    writeSync(descriptor, `${JSON.stringify(record)}\n`)
    closeSync(descriptor)
    descriptor = null
    return { path, token: record.token }
  } catch (cause) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // Ignore cleanup failure.
      }
    }
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (cause as { code?: unknown }).code === "EEXIST"
    ) {
      if (startLockIsStale(path)) {
        try {
          unlinkSync(path)
        } catch {
          // Another contender may have removed it first.
        }
      }
      return null
    }
    throw new ServiceError(
      "io",
      `Could not acquire the service start lock at ${path}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    )
  }
}

const releaseStartLock = (lock: StartLock): void => {
  const current = readStartLock(lock.path)
  if (current !== null && current.token === lock.token) {
    try {
      unlinkSync(lock.path)
    } catch {
      // Already released.
    }
  }
}

const numberFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number => {
  const raw = env[name]?.trim()
  if (raw === undefined || raw === "") {
    return fallback
  }
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

const resolvePort = (
  port: number | undefined,
  env: Readonly<Record<string, string | undefined>>,
): number => {
  const candidate =
    port ??
    (env.SLIPMEM_SERVICE_PORT === undefined
      ? 0
      : Number(env.SLIPMEM_SERVICE_PORT))
  if (
    !Number.isInteger(candidate) ||
    candidate < 0 ||
    candidate > 65_535
  ) {
    throw new ServiceError(
      "invalid-port",
      `The service port must be an integer between 0 and 65535, got ${String(candidate)}.`,
    )
  }
  return candidate
}

const validateServingConfig = async (
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> => {
  try {
    // Resolving validates the explicit provider configuration and constructs a
    // tool-less transport; it performs no request and starts no provider.
    const { resolveAutomaticMemoryRuntime, resolveRecallProvider } =
      await import("@slipmem/server")
    resolveAutomaticMemoryRuntime(env)
    resolveRecallProvider(env)
  } catch (cause) {
    throw new ServiceError(
      "config",
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    )
  }
}

const waitForReady = async (
  root: string,
  deadline: number,
): Promise<ServiceStatus | null> => {
  for (;;) {
    const status = await inspectService(root)
    if (status.running && status.ready) {
      return status
    }
    if (Date.now() >= deadline) {
      return null
    }
    await sleep(80)
  }
}

const readLogTail = (path: string, limit = 4_000): string => {
  try {
    const contents = readFileSync(path, "utf8")
    return contents.length <= limit ? contents : contents.slice(-limit)
  } catch {
    return ""
  }
}

const childEnvironment = (
  root: string,
  port: number,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  // The child is loopback-only by construction. Do not let an inherited web
  // bind setting move the unauthenticated API or MCP endpoint off loopback.
  delete result.HOST
  delete result.PORT
  result.SLIPMEM_DIR = root
  result.SLIPMEM_SERVICE_PORT = String(port)
  return result
}

const startLocked = async (
  root: string,
  options: StartServiceOptions,
  deadline: number,
): Promise<StartServiceResult> => {
  const current = await inspectService(root)
  if (current.running && current.ready && current.state !== undefined) {
    return {
      status: "already-running",
      state: current.state,
      endpoint: current.state.url,
      mcpUrl: `${current.state.url}/mcp`,
    }
  }

  if (current.running) {
    const ready = await waitForReady(root, deadline)
    if (ready !== null && ready.state !== undefined) {
      return {
        status: "already-running",
        state: ready.state,
        endpoint: ready.state.url,
        mcpUrl: `${ready.state.url}/mcp`,
      }
    }
    throw new ServiceError(
      "start-timeout",
      `A slipmem service process already owns ${root} but did not become ready within ${Math.max(0, deadline - Date.now())}ms.`,
    )
  }

  removeStaleRegistration(root)
  const port = resolvePort(options.port, options.env)
  await validateServingConfig(options.env)

  ensureServiceDirectory(root)
  const logPath = serviceLogPath(root)
  try {
    writeFileSync(logPath, "", { mode: 0o600 })
  } catch (cause) {
    throw new ServiceError(
      "io",
      `Could not prepare the service log at ${logPath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    )
  }

  const entrypoint = resolve(import.meta.dir, "server.ts")
  const logDescriptor = openSync(logPath, "a", 0o600)
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn({
      cmd: [process.execPath, entrypoint],
      cwd: dirname(root),
      env: childEnvironment(root, port, options.env),
      stdin: "ignore",
      stdout: logDescriptor,
      stderr: logDescriptor,
    })
    child.unref()
  } finally {
    try {
      closeSync(logDescriptor)
    } catch {
      // Ignore cleanup failure.
    }
  }

  for (;;) {
    const status = await inspectService(root)
    if (
      status.running &&
      status.ready &&
      status.state !== undefined &&
      status.state.pid === child.pid
    ) {
      return {
        status: "started",
        state: status.state,
        endpoint: status.state.url,
        mcpUrl: `${status.state.url}/mcp`,
      }
    }

    if (child.exitCode !== null) {
      const other = await inspectService(root)
      if (other.running && other.ready && other.state !== undefined) {
        return {
          status: "already-running",
          state: other.state,
          endpoint: other.state.url,
          mcpUrl: `${other.state.url}/mcp`,
        }
      }
      removeRegistrationOwnedBy(root, (record) => record.pid === child.pid)
      const tail = readLogTail(logPath)
      throw new ServiceError(
        "service-exited",
        `The background service exited before readiness (exit ${String(child.exitCode)}).${
          tail.trim() === "" ? "" : `\n${tail.trim()}`
        }`,
      )
    }

    if (Date.now() >= deadline) {
      try {
        process.kill(child.pid, "SIGTERM")
      } catch {
        // The child may have exited.
      }
      await sleep(250)
      if (isProcessAlive(child.pid)) {
        try {
          process.kill(child.pid, "SIGKILL")
        } catch {
          // The child may have exited.
        }
      }
      removeRegistrationOwnedBy(root, (record) => record.pid === child.pid)
      const tail = readLogTail(logPath)
      throw new ServiceError(
        "start-timeout",
        `The background service did not become ready within ${Math.max(0, deadline - Date.now())}ms.${
          tail.trim() === "" ? "" : `\n${tail.trim()}`
        }`,
      )
    }

    await sleep(80)
  }
}

/**
 * Start or reuse exactly one loopback service for one canonical note root.
 *
 * Concurrent starts coordinate through a short-lived start lock. The child then
 * holds a lifetime owner record, so a stale start lock cannot admit a second
 * consolidator. A failed start never leaves a ready registration behind.
 */
export const startService = async (
  options: StartServiceOptions,
): Promise<StartServiceResult> => {
  const root = canonicalServiceRoot(options.root)
  const timeoutMs =
    options.timeoutMs ??
    numberFromEnv(
      options.env,
      "SLIPMEM_SERVICE_START_TIMEOUT_MS",
      DEFAULT_START_TIMEOUT_MS,
    )
  const deadline = Date.now() + timeoutMs

  const initial = await inspectService(root)
  if (initial.running && initial.ready && initial.state !== undefined) {
    return {
      status: "already-running",
      state: initial.state,
      endpoint: initial.state.url,
      mcpUrl: `${initial.state.url}/mcp`,
    }
  }

  let lock: StartLock | null = null
  while (lock === null) {
    const current = await inspectService(root)
    if (current.running && current.ready && current.state !== undefined) {
      return {
        status: "already-running",
        state: current.state,
        endpoint: current.state.url,
        mcpUrl: `${current.state.url}/mcp`,
      }
    }
    lock = tryAcquireStartLock(root)
    if (lock !== null) {
      break
    }
    if (Date.now() >= deadline) {
      throw new ServiceError(
        "start-timeout",
        `Another slipmem service start is still in progress for ${root}.`,
      )
    }
    await sleep(50)
  }

  try {
    return await startLocked(root, options, deadline)
  } finally {
    releaseStartLock(lock)
  }
}

const removeOwnedRegistration = (
  root: string,
  pid: number,
  instanceId: string,
): void =>
  removeRegistrationOwnedBy(
    root,
    (record) => record.pid === pid && record.instanceId === instanceId,
  )

/**
 * Stop only the process this root's registration proves it owns. Status and
 * stop never resolve a model or contact a provider.
 */
export const stopService = async (
  options: StopServiceOptions,
): Promise<StopServiceResult> => {
  const root = canonicalServiceRoot(options.root)
  const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
  const status = await inspectService(root)

  if (!status.running) {
    removeStaleRegistration(root)
    return {
      status: "not-running",
      root,
      forced: false,
      ...(status.reason === undefined ? {} : { reason: status.reason }),
    }
  }

  const owner = readServiceOwner(root)
  const pid = status.pid ?? owner?.pid
  const matchingOwner =
    owner !== null && owner.pid === pid ? owner : null
  const registeredState = status.state ?? readServiceState(root)
  const state =
    registeredState !== null &&
    registeredState.pid === pid &&
    (matchingOwner === null ||
      matchingOwner.instanceId === registeredState.instanceId)
      ? registeredState
      : null
  const instanceId = state?.instanceId ?? matchingOwner?.instanceId

  if (pid === undefined || instanceId === undefined) {
    throw new ServiceError(
      "identity-mismatch",
      `The service registration for ${root} has no matching process identity; refusing to stop it.`,
    )
  }

  const record = state !== null ? state : matchingOwner
  if (record === null || !matchesProcessIdentity(record)) {
    throw new ServiceError(
      "identity-mismatch",
      `The registered PID ${pid} for ${root} is no longer the slipmem service; refusing to stop it.`,
    )
  }

  try {
    process.kill(pid, "SIGTERM")
  } catch (cause) {
    if (
      !(
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        (cause as { code?: unknown }).code === "ESRCH"
      )
    ) {
      throw new ServiceError(
        "io",
        `Could not send SIGTERM to the slipmem service at PID ${pid}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause },
      )
    }
  }

  const deadline = Date.now() + timeoutMs
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await sleep(50)
  }

  let forced = false
  if (isProcessAlive(pid)) {
    forced = true
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // The process may have exited between the check and the signal.
    }
    const killDeadline = Date.now() + 2_000
    while (isProcessAlive(pid) && Date.now() < killDeadline) {
      await sleep(50)
    }
    if (isProcessAlive(pid)) {
      throw new ServiceError(
        "stop-timeout",
        `The slipmem service at PID ${pid} did not exit after SIGTERM and SIGKILL.`,
      )
    }
  }

  removeOwnedRegistration(root, pid, instanceId)
  return { status: "stopped", root, pid, forced }
}
