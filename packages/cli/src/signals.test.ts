import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { terminateChild } from "./signals.js"

const bases: string[] = []
const children: Array<ReturnType<typeof Bun.spawn>> = []

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL")
    } catch {
      // The child already exited.
    }
  }
  while (bases.length > 0) {
    rmSync(bases.pop()!, { recursive: true, force: true })
  }
})

/**
 * Starts a child and waits for it to install its signal handler. Sending
 * SIGTERM before that point would use the platform default and defeat the
 * escalation case under test.
 */
const spawnReadyChild = async (
  script: string,
): Promise<ReturnType<typeof Bun.spawn>> => {
  const base = mkdtempSync("/tmp/opencode/slipmem-signals-")
  bases.push(base)
  const marker = join(base, "ready")
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1");${script}`,
    ],
    stdio: ["ignore", "ignore", "ignore"],
  })
  children.push(child)
  const deadline = Date.now() + 10000
  while (!existsSync(marker)) {
    if (Date.now() > deadline) {
      throw new Error("The child did not become ready.")
    }
    await Bun.sleep(10)
  }
  return child
}

describe("terminateChild", () => {
  test("escalates to SIGKILL after the grace period", async () => {
    const child = await spawnReadyChild(
      `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`,
    )
    const started = Date.now()
    await terminateChild(child, 100)
    const elapsed = Date.now() - started

    expect(elapsed).toBeGreaterThanOrEqual(80)
    expect(elapsed).toBeLessThan(5000)
    expect(child.signalCode).toBe("SIGKILL")
  })

  test("returns as soon as a cooperative child exits", async () => {
    const child = await spawnReadyChild(
      `process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)`,
    )
    const started = Date.now()
    await terminateChild(child, 5000)

    expect(Date.now() - started).toBeLessThan(2000)
    expect(child.exitCode).toBe(0)
  })
})
