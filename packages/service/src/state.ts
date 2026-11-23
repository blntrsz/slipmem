import { STATE_DIRECTORY } from "@slipmem/core"
import { randomUUID } from "node:crypto"
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { join, resolve } from "node:path"

import { ServiceError } from "./errors"

export const SERVICE_STATE_VERSION = 1 as const
export const SERVICE_DIRECTORY = "service"
export const SERVICE_STATE_FILENAME = "state.json"
export const SERVICE_OWNER_FILENAME = "owner.json"
export const SERVICE_START_LOCK_FILENAME = "start.lock"
export const SERVICE_LOG_FILENAME = "service.log"
export const LOOPBACK_HOST = "127.0.0.1"

/** One canonical note root, one background server. */
export interface ServiceState {
  readonly version: typeof SERVICE_STATE_VERSION
  readonly root: string
  readonly pid: number
  readonly identity: string | null
  readonly instanceId: string
  readonly url: string
  readonly port: number
  readonly startedAt: string
}

/**
 * The lifetime lock a child holds while it owns one root. It is separate from
 * `state.json` so a process that has not finished binding yet is still
 * discoverable and cannot be duplicated.
 */
export interface ServiceOwner {
  readonly version: typeof SERVICE_STATE_VERSION
  readonly root: string
  readonly pid: number
  readonly identity: string | null
  readonly instanceId: string
  readonly startedAt: string
}

export interface ServiceOwnerHandle {
  readonly record: ServiceOwner
  /** Remove only this owner record, never a replacement's. */
  readonly release: () => void
}

export interface ServiceHealth {
  readonly ok: boolean
  readonly service: "slipmem"
  readonly root: string
  readonly pid: number
  readonly instanceId: string
  readonly startedAt: string
  readonly url: string
}

export const serviceDirectory = (root: string): string =>
  join(root, STATE_DIRECTORY, SERVICE_DIRECTORY)

export const serviceStatePath = (root: string): string =>
  join(serviceDirectory(root), SERVICE_STATE_FILENAME)

export const serviceOwnerPath = (root: string): string =>
  join(serviceDirectory(root), SERVICE_OWNER_FILENAME)

export const serviceStartLockPath = (root: string): string =>
  join(serviceDirectory(root), SERVICE_START_LOCK_FILENAME)

export const serviceLogPath = (root: string): string =>
  join(serviceDirectory(root), SERVICE_LOG_FILENAME)

export const serviceUrl = (port: number): string =>
  `http://${LOOPBACK_HOST}:${port}`

/**
 * Resolve the canonical placement before reading or writing any registration.
 * A symlinked parent must not produce a second service for the same files.
 */
export const canonicalServiceRoot = (root: string): string => {
  const resolved = resolve(root)
  let canonical: string
  try {
    const stat = statSync(resolved)
    if (!stat.isDirectory()) {
      throw new ServiceError(
        "invalid-root",
        `The note root at ${resolved} is not a directory.`,
      )
    }
    canonical = realpathSync(resolved)
  } catch (cause) {
    if (cause instanceof ServiceError) {
      throw cause
    }
    throw new ServiceError(
      "invalid-root",
      `No Markdown note repository at ${resolved}. Run "slipmem init" or set SLIPMEM_DIR to an existing .slipmem directory.`,
      { cause },
    )
  }
  return canonical
}

export const ensureServiceDirectory = (root: string): void => {
  try {
    mkdirSync(serviceDirectory(root), { recursive: true, mode: 0o700 })
  } catch (cause) {
    throw new ServiceError(
      "io",
      `Could not create the service state directory under ${serviceDirectory(root)}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    )
  }
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown
  } catch {
    return undefined
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0

const isLoopbackServiceUrl = (url: string, port: number): boolean => {
  try {
    const parsed = new URL(url)
    const parsedPort = parsed.port === "" ? 80 : Number(parsed.port)
    return (
      parsed.protocol === "http:" &&
      parsed.hostname === LOOPBACK_HOST &&
      parsedPort === port &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.username === "" &&
      parsed.password === ""
    )
  } catch {
    return false
  }
}

const asState = (value: unknown): ServiceState | null => {
  if (!isRecord(value)) {
    return null
  }
  if (
    value.version !== SERVICE_STATE_VERSION ||
    typeof value.root !== "string" ||
    !isPositiveInteger(value.pid) ||
    !(typeof value.identity === "string" || value.identity === null) ||
    typeof value.instanceId !== "string" ||
    typeof value.url !== "string" ||
    !isPositiveInteger(value.port) ||
    !isLoopbackServiceUrl(value.url, value.port) ||
    typeof value.startedAt !== "string"
  ) {
    return null
  }
  return {
    version: SERVICE_STATE_VERSION,
    root: value.root,
    pid: value.pid,
    identity: value.identity,
    instanceId: value.instanceId,
    url: value.url,
    port: value.port,
    startedAt: value.startedAt,
  }
}

const asOwner = (value: unknown): ServiceOwner | null => {
  if (!isRecord(value)) {
    return null
  }
  if (
    value.version !== SERVICE_STATE_VERSION ||
    typeof value.root !== "string" ||
    !isPositiveInteger(value.pid) ||
    !(typeof value.identity === "string" || value.identity === null) ||
    typeof value.instanceId !== "string" ||
    typeof value.startedAt !== "string"
  ) {
    return null
  }
  return {
    version: SERVICE_STATE_VERSION,
    root: value.root,
    pid: value.pid,
    identity: value.identity,
    instanceId: value.instanceId,
    startedAt: value.startedAt,
  }
}

export const readServiceState = (root: string): ServiceState | null =>
  asState(readJson(serviceStatePath(root)))

export const readServiceOwner = (root: string): ServiceOwner | null =>
  asOwner(readJson(serviceOwnerPath(root)))

export const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
  } catch (cause) {
    return (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (cause as { code?: unknown }).code === "EPERM"
    )
  }
  try {
    // A zombie still accepts signal 0 until its parent reaps it. It owns no
    // listener and no worker, so status/stop must treat it as gone.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const commandEnd = stat.lastIndexOf(")")
    return commandEnd < 0 || stat.slice(commandEnd + 2, commandEnd + 3) !== "Z"
  } catch {
    return true
  }
}

/**
 * Linux process start time in clock ticks since boot. It survives PID reuse and
 * is the identity half of the registration, distinct from readiness. Platforms
 * without `/proc` return `null`; teardown then requires the HTTP instance ID.
 */
export const processStartIdentity = (pid: number): string | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const commandEnd = stat.lastIndexOf(")")
    if (commandEnd < 0) {
      return null
    }
    // Field 22 (starttime) after the command field. The slice begins at field 3
    // (state), so field 22 is index 19.
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/)
    const starttime = fields[19]
    return starttime === undefined || starttime === "" ? null : starttime
  } catch {
    return null
  }
}

/**
 * True when the PID is alive and, when the platform can prove it, still the
 * same process that registered. A `null` stored identity falls back to the live
 * PID plus the HTTP instance check.
 */
export const matchesProcessIdentity = (record: {
  readonly pid: number
  readonly identity: string | null
}): boolean => {
  if (!isProcessAlive(record.pid)) {
    return false
  }
  if (record.identity === null) {
    return true
  }
  const current = processStartIdentity(record.pid)
  return current === null || current === record.identity
}

const writeJsonAtomic = (
  path: string,
  value: ServiceState | ServiceOwner,
): void => {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    })
    renameSync(temporary, path)
  } catch (cause) {
    try {
      unlinkSync(temporary)
    } catch {
      // Best effort cleanup.
    }
    throw new ServiceError(
      "io",
      `Could not write the service registration at ${path}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    )
  }
}

export const writeServiceState = (root: string, state: ServiceState): void => {
  ensureServiceDirectory(root)
  writeJsonAtomic(serviceStatePath(root), state)
}

/**
 * Atomically claim the per-root lifetime lock. A live matching owner is an
 * honest "already running" result; a dead or PID-reused owner is stale and is
 * replaced. The record is written after the exclusive create so no contender
 * can observe an empty lock file and mistake it for an owner.
 */
export const acquireServiceOwner = (root: string): ServiceOwnerHandle => {
  ensureServiceDirectory(root)
  const path = serviceOwnerPath(root)
  const startedAt = new Date().toISOString()
  const record: ServiceOwner = {
    version: SERVICE_STATE_VERSION,
    root,
    pid: process.pid,
    identity: processStartIdentity(process.pid),
    instanceId: randomUUID(),
    startedAt,
  }

  for (;;) {
    let descriptor: number | null = null
    try {
      descriptor = openSync(path, "wx", 0o600)
      writeSync(descriptor, `${JSON.stringify(record)}\n`)
      closeSync(descriptor)
      descriptor = null
      return {
        record,
        release: () => {
          const current = readServiceOwner(root)
          if (
            current !== null &&
            current.instanceId === record.instanceId &&
            current.pid === record.pid
          ) {
            try {
              unlinkSync(path)
            } catch {
              // Already released.
            }
          }
        },
      }
    } catch (cause) {
      if (descriptor !== null) {
        try {
          closeSync(descriptor)
        } catch {
          // Ignore cleanup failure.
        }
      }
      if (
        !(
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          (cause as { code?: unknown }).code === "EEXIST"
        )
      ) {
        throw new ServiceError(
          "io",
          `Could not acquire the service owner lock at ${path}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          { cause },
        )
      }
      const current = readServiceOwner(root)
      if (
        current !== null &&
        current.root === root &&
        matchesProcessIdentity(current)
      ) {
        throw new ServiceError(
          "already-running",
          `A slipmem service is already running for ${root} at PID ${current.pid}.`,
        )
      }
      try {
        unlinkSync(path)
      } catch {
        // Another contender may have removed it first.
      }
    }
  }
}

export const removeRegistrationOwnedBy = (
  root: string,
  predicate: (record: ServiceState | ServiceOwner) => boolean,
): void => {
  const state = readServiceState(root)
  if (state !== null && predicate(state)) {
    try {
      unlinkSync(serviceStatePath(root))
    } catch {
      // Already removed.
    }
  }
  const owner = readServiceOwner(root)
  if (owner !== null && predicate(owner)) {
    try {
      unlinkSync(serviceOwnerPath(root))
    } catch {
      // Already removed.
    }
  }
}

/**
 * Remove only registrations whose process is no longer the registered process.
 * A live, matching service is never evicted by a status or start command.
 */
export const removeStaleRegistration = (root: string): void => {
  removeRegistrationOwnedBy(
    root,
    (record) => !matchesProcessIdentity(record),
  )
}

export const fetchServiceHealth = async (
  url: string,
  timeoutMs = 1_000,
): Promise<ServiceHealth | null> => {
  try {
    const response = await fetch(`${url}/service/health`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      return null
    }
    const body = (await response.json()) as unknown
    if (!isRecord(body)) {
      return null
    }
    if (
      body.ok !== true ||
      body.service !== "slipmem" ||
      typeof body.root !== "string" ||
      !isPositiveInteger(body.pid) ||
      typeof body.instanceId !== "string" ||
      typeof body.startedAt !== "string" ||
      typeof body.url !== "string"
    ) {
      return null
    }
    return {
      ok: true,
      service: "slipmem",
      root: body.root,
      pid: body.pid,
      instanceId: body.instanceId,
      startedAt: body.startedAt,
      url: body.url,
    }
  } catch {
    return null
  }
}
