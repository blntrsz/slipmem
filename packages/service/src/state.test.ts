import { afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ServiceError } from "./errors"
import {
  acquireServiceOwner,
  readServiceOwner,
  readServiceState,
  removeStaleRegistration,
  SERVICE_OWNER_FILENAME,
  SERVICE_STATE_FILENAME,
  SERVICE_STATE_VERSION,
  serviceUrl,
  writeServiceState,
} from "./state"

const rootPrefix = join(tmpdir(), "slipmem-service-state-")
const temporaryDirectories: Array<string> = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(rootPrefix)
  temporaryDirectories.push(directory)
  return directory
}

const serviceError = (run: () => unknown): ServiceError | null => {
  try {
    run()
    return null
  } catch (cause) {
    return cause instanceof ServiceError ? cause : null
  }
}

const serviceState = (root: string) => ({
  version: SERVICE_STATE_VERSION,
  root,
  pid: process.pid,
  identity: null,
  instanceId: "state-containment-test",
  url: serviceUrl(1),
  port: 1,
  startedAt: new Date().toISOString(),
})

const serviceOwner = (root: string) => ({
  version: SERVICE_STATE_VERSION,
  root,
  pid: process.pid,
  identity: null,
  instanceId: "state-containment-test",
  startedAt: new Date().toISOString(),
})

/** A dead PID makes both registrations stale under removeStaleRegistration. */
const dead = <T extends { readonly pid: number }>(record: T): T => ({
  ...record,
  pid: 999_999,
})

describe("service state path containment", () => {
  test("a symlinked .state is rejected without writing a registration outside", () => {
    const base = temporaryDirectory()
    const root = join(base, ".slipmem")
    const outside = join(base, "outside")
    mkdirSync(root, { recursive: true })
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(root, ".state"))

    const ownerError = serviceError(() => acquireServiceOwner(root))
    const stateError = serviceError(() =>
      writeServiceState(root, serviceState(root)),
    )

    expect(ownerError?.code).toBe("io")
    expect(stateError?.code).toBe("io")
    expect(readdirSync(outside)).toEqual([])
  })

  test("a symlinked .state/service is rejected without writing a registration outside", () => {
    const base = temporaryDirectory()
    const root = join(base, ".slipmem")
    const outside = join(base, "outside")
    mkdirSync(join(root, ".state"), { recursive: true })
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(root, ".state", "service"))

    const ownerError = serviceError(() => acquireServiceOwner(root))
    const stateError = serviceError(() =>
      writeServiceState(root, serviceState(root)),
    )

    expect(ownerError?.code).toBe("io")
    expect(stateError?.code).toBe("io")
    expect(readdirSync(outside)).toEqual([])
  })

  test("reads and stale cleanup do not create a missing .state", () => {
    const base = temporaryDirectory()
    const root = join(base, ".slipmem")
    mkdirSync(root, { recursive: true })

    expect(readServiceState(root)).toBeNull()
    expect(readServiceOwner(root)).toBeNull()
    removeStaleRegistration(root)

    expect(existsSync(join(root, ".state"))).toBe(false)
  })

  test("reads and stale cleanup never follow a symlinked .state", () => {
    const base = temporaryDirectory()
    const root = join(base, ".slipmem")
    const outside = join(base, "outside")
    mkdirSync(root, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const stateBody = JSON.stringify(dead(serviceState(root)))
    const ownerBody = JSON.stringify(dead(serviceOwner(root)))
    writeFileSync(join(outside, SERVICE_STATE_FILENAME), stateBody)
    writeFileSync(join(outside, SERVICE_OWNER_FILENAME), ownerBody)
    symlinkSync(outside, join(root, ".state"))

    expect(readServiceState(root)).toBeNull()
    expect(readServiceOwner(root)).toBeNull()
    removeStaleRegistration(root)

    expect(
      readFileSync(join(outside, SERVICE_STATE_FILENAME), "utf8"),
    ).toBe(stateBody)
    expect(
      readFileSync(join(outside, SERVICE_OWNER_FILENAME), "utf8"),
    ).toBe(ownerBody)
  })

  test("reads and stale cleanup never follow a symlinked .state/service", () => {
    const base = temporaryDirectory()
    const root = join(base, ".slipmem")
    const outside = join(base, "outside")
    mkdirSync(join(root, ".state"), { recursive: true })
    mkdirSync(outside, { recursive: true })
    const stateBody = JSON.stringify(dead(serviceState(root)))
    const ownerBody = JSON.stringify(dead(serviceOwner(root)))
    writeFileSync(join(outside, SERVICE_STATE_FILENAME), stateBody)
    writeFileSync(join(outside, SERVICE_OWNER_FILENAME), ownerBody)
    symlinkSync(outside, join(root, ".state", "service"))

    expect(readServiceState(root)).toBeNull()
    expect(readServiceOwner(root)).toBeNull()
    removeStaleRegistration(root)

    expect(
      readFileSync(join(outside, SERVICE_STATE_FILENAME), "utf8"),
    ).toBe(stateBody)
    expect(
      readFileSync(join(outside, SERVICE_OWNER_FILENAME), "utf8"),
    ).toBe(ownerBody)
  })

  test("reads never follow a symlinked registration file", () => {
    const base = temporaryDirectory()
    const root = join(base, ".slipmem")
    const outside = join(base, "outside.json")
    mkdirSync(join(root, ".state", "service"), { recursive: true })
    const body = JSON.stringify(dead(serviceState(root)))
    writeFileSync(outside, body)
    symlinkSync(
      outside,
      join(root, ".state", "service", SERVICE_STATE_FILENAME),
    )

    expect(readServiceState(root)).toBeNull()
    removeStaleRegistration(root)
    expect(readFileSync(outside, "utf8")).toBe(body)
  })
})
