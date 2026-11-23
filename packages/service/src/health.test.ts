import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { serviceHealthResponse } from "./health"
import type { ServiceState } from "./state"

const readyState: ServiceState = {
  version: 1,
  root: join(tmpdir(), "slipmem-health-test", ".slipmem"),
  pid: 4321,
  identity: "12345",
  instanceId: "instance-health-test",
  url: "http://127.0.0.1:4319",
  port: 4319,
  startedAt: "2026-11-23T00:00:00.000Z",
}

test("health only reports ok after the ready registration exists", async () => {
  const pending = serviceHealthResponse(undefined, undefined)
  expect(pending.status).toBe(503)
  expect(await pending.json()).toEqual({
    ok: false,
    service: "slipmem",
    error: "not-ready",
  })

  const failed = serviceHealthResponse(undefined, "index could not be built")
  expect(failed.status).toBe(503)
  expect(await failed.json()).toEqual({
    ok: false,
    service: "slipmem",
    error: "startup-failed",
    message: "index could not be built",
  })

  const ready = serviceHealthResponse(readyState, undefined)
  expect(ready.status).toBe(200)
  expect(await ready.json()).toEqual({
    ok: true,
    service: "slipmem",
    root: readyState.root,
    pid: readyState.pid,
    instanceId: readyState.instanceId,
    startedAt: readyState.startedAt,
    url: readyState.url,
  })
})
