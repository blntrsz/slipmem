import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const record = join(here, "record.mjs")

const fixturePage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Tour fixture</title>
    <style>
      body { margin: 0; padding: 80px; font: 24px system-ui, sans-serif; background: #f4f1ea; color: #171717; }
      input, textarea { display: block; box-sizing: border-box; width: 480px; margin: 16px 0 32px; padding: 12px; font: inherit; }
    </style>
  </head>
  <body>
    <h1>Tour fixture</h1>
    <label for="secret">Secret field</label>
    <input id="secret" autocomplete="off" />
    <label for="note">Note field</label>
    <textarea id="note" rows="3"></textarea>
    <p><a id="external" href="http://127.0.0.1:1/">external link</a></p>
    <p id="done"></p>
  </body>
</html>`

const runRecorder = async (scriptPath, env) => {
  const proc = Bun.spawn([process.execPath, record, scriptPath], {
    cwd: here,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

let chromiumReady = false
try {
  const { chromium } = await import("playwright")
  const browser = await chromium.launch({ headless: true })
  await browser.close()
  chromiumReady = true
} catch {
  chromiumReady = false
}

const recordTest = chromiumReady ? test : test.skip

recordTest(
  "records a fixture, redacts inputs, contains artifacts, and blocks external navigation",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "slipmem-tour-record-"))
    const outputRoot = join(temp, "out")
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(fixturePage, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    })

    try {
      const scriptPath = join(temp, "fixture.script.json")
      await writeFile(
        scriptPath,
        JSON.stringify(
          {
            url: `http://127.0.0.1:${server.port}/`,
            output: "fixture.webm",
            width: 640,
            height: 480,
            steps: [
              { wait: 100 },
              { caption: "Fixture caption", hold: 300 },
              {
                fill: {
                  selector: "#secret",
                  value: "hunter2-fixture-secret",
                },
              },
              {
                type: {
                  selector: "#note",
                  text: "typed-fixture-secret",
                  delay: 1,
                },
              },
              { screenshot: "typed" },
              { wait: 100 },
            ],
          },
          null,
          2,
        ),
      )

      const result = await runRecorder(scriptPath, {
        TOUR_OUTPUT_ROOT: outputRoot,
      })
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)

      const video = await stat(join(outputRoot, "fixture.webm"))
      expect(video.size).toBeGreaterThan(0)
      const still = await stat(join(outputRoot, "stills", "typed.png"))
      expect(still.size).toBeGreaterThan(0)

      const logText = await readFile(
        join(outputRoot, "fixture.actions.json"),
        "utf8",
      )
      const log = JSON.parse(logText)
      expect(log.failure).toBeNull()
      expect(log.redactedInputs).toBe(true)
      expect(log.allowedOrigins).toEqual([
        `http://127.0.0.1:${server.port}`,
      ])
      expect(log.actions).toHaveLength(6)
      expect(log.actions[2].step.fill.value).toBe("<redacted>")
      expect(log.actions[3].step.type.text).toBe("<redacted>")
      expect(logText).not.toContain("hunter2-fixture-secret")
      expect(logText).not.toContain("typed-fixture-secret")

      const blockedScript = join(temp, "blocked.script.json")
      await writeFile(
        blockedScript,
        JSON.stringify({
          url: `http://127.0.0.1:${server.port}/`,
          output: "blocked.webm",
          width: 640,
          height: 480,
          steps: [{ wait: 50 }, { click: "#external" }],
        }),
      )
      const blocked = await runRecorder(blockedScript, {
        TOUR_OUTPUT_ROOT: outputRoot,
      })
      expect(blocked.code).not.toBe(0)
      expect(blocked.stderr).toContain("not allowed")
      const blockedLog = JSON.parse(
        await readFile(join(outputRoot, "blocked.actions.json"), "utf8"),
      )
      expect(blockedLog.failure).toContain("not allowed")
      const errorStill = await stat(join(outputRoot, "stills", "error.png"))
      expect(errorStill.size).toBeGreaterThan(0)
    } finally {
      server.stop(true)
      await rm(temp, { recursive: true, force: true })
    }
  },
  30000,
)

test("refuses an output path outside the configured output root before launching a browser", async () => {
  const temp = await mkdtemp(join(tmpdir(), "slipmem-tour-guard-"))
  const outputRoot = join(temp, "out")
  await mkdir(outputRoot, { recursive: true })

  try {
    const scriptPath = join(temp, "escape.script.json")
    await writeFile(
      scriptPath,
      JSON.stringify({
        url: "http://127.0.0.1:1/",
        output: "../escape.webm",
        steps: [{ wait: 10 }],
      }),
    )

    const result = await runRecorder(scriptPath, {
      TOUR_OUTPUT_ROOT: outputRoot,
    })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("output must stay inside")
    await expect(stat(join(temp, "escape.webm"))).rejects.toThrow()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("refuses file URLs and note-root output roots before launching a browser", async () => {
  const temp = await mkdtemp(join(tmpdir(), "slipmem-tour-guard-"))

  try {
    const fileScript = join(temp, "file.script.json")
    await writeFile(
      fileScript,
      JSON.stringify({
        url: "file:///tmp/fixture.html",
        output: "tour.webm",
        steps: [{ wait: 10 }],
      }),
    )
    const fileResult = await runRecorder(fileScript, {
      TOUR_OUTPUT_ROOT: join(temp, "out"),
    })
    expect(fileResult.code).not.toBe(0)
    expect(fileResult.stderr).toContain("http: or https:")

    const noteRoot = join(temp, "notes")
    await mkdir(noteRoot, { recursive: true })
    const noteScript = join(temp, "note.script.json")
    await writeFile(
      noteScript,
      JSON.stringify({
        url: "http://localhost:3000/",
        output: "tour.webm",
        steps: [{ wait: 10 }],
      }),
    )
    const noteResult = await runRecorder(noteScript, {
      TOUR_OUTPUT_ROOT: noteRoot,
      SLIPMEM_DIR: noteRoot,
    })
    expect(noteResult.code).not.toBe(0)
    expect(noteResult.stderr).toContain("note root")
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
