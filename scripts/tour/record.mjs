#!/usr/bin/env bun
// Records a scripted, silent product tour with captions burned in by the
// browser overlay. App-specific selectors belong in the tour script, never in
// this driver.
//
// Usage:
//   cd scripts/tour
//   bun install
//   bun record.mjs tour.script.json

import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const defaultScript = join(here, "tour.script.json")

let chromium
try {
  ;({ chromium } = await import("playwright"))
} catch {
  console.error(
    "tour: playwright is not installed. Run `bun install` in scripts/tour first.",
  )
  process.exit(1)
}

const die = (message) => {
  console.error(`tour: ${message}`)
  process.exit(1)
}

const scriptArg = process.argv[2]
const scriptPath = scriptArg ? resolve(process.cwd(), scriptArg) : defaultScript

let config
try {
  config = JSON.parse(await readFile(scriptPath, "utf8"))
} catch (error) {
  die(`cannot read ${scriptPath}: ${error.message}`)
}

if (!Array.isArray(config.steps) || config.steps.length === 0) {
  die(`${scriptPath} must contain a non-empty "steps" array`)
}

const width = config.width ?? 1440
const height = config.height ?? 900
if (
  !Number.isInteger(width) ||
  !Number.isInteger(height) ||
  width < 2 ||
  height < 2
) {
  die("width and height must be integers of at least 2")
}
if (width % 2 !== 0 || height % 2 !== 0) {
  die("width and height must be even for H.264 encoding")
}

const baseUrl = config.url ?? "http://localhost:3000/"
const outputPath = resolve(
  here,
  config.output ?? "output/slipmem-tour.webm",
)
if (!outputPath.endsWith(".webm")) {
  die('output must end with ".webm"')
}

const outputDir = dirname(outputPath)
const rawDir = join(outputDir, ".raw")
const stillsDir = join(outputDir, "stills")
const logPath = outputPath.replace(/\.webm$/, ".actions.json")

const actionKeys = [
  "caption",
  "goto",
  "click",
  "fill",
  "type",
  "press",
  "waitFor",
  "wait",
  "hover",
  "screenshot",
  "scroll",
]

const requireString = (value, label) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

const requireMillis = (value, label) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`)
  }
  return value
}

await mkdir(outputDir, { recursive: true })
await rm(rawDir, { recursive: true, force: true })
await mkdir(rawDir, { recursive: true })

const browser = await chromium.launch({
  headless: true,
  args: ["--hide-scrollbars", "--force-color-profile=srgb"],
})
const context = await browser.newContext({
  viewport: { width, height },
  recordVideo: { dir: rawDir, size: { width, height } },
})
await context.addInitScript({ path: join(here, "overlay.js") })

const page = await context.newPage()
const video = page.video()
const startedAt = Date.now()
const actions = []

const mark = (step, index) => {
  const entry = { index, atMs: Date.now() - startedAt, step }
  actions.push(entry)
  return entry.atMs
}

const locatorFor = (selector, label) =>
  page.locator(requireString(selector, label)).first()

const pointAt = async (locator) => {
  await locator.waitFor({ state: "visible", timeout: 15000 })
  await locator.scrollIntoViewIfNeeded({ timeout: 15000 })
  const box = await locator.boundingBox()
  if (box === null) {
    return
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 18,
  })
  await page.waitForTimeout(180)
}

const runStep = async (step, index) => {
  const present = actionKeys.filter((key) => key in step)
  if (present.length !== 1) {
    throw new Error(
      `step ${index + 1} must contain exactly one action (${actionKeys.join(
        ", ",
      )}); found ${present.join(", ") || "none"}`,
    )
  }

  switch (present[0]) {
    case "caption": {
      if (step.caption !== null && typeof step.caption !== "string") {
        throw new Error("caption must be a string or null")
      }
      await page.evaluate((text) => {
        window.__slipmemTourCaption?.(text)
      }, step.caption)
      if ("hold" in step) {
        await page.waitForTimeout(requireMillis(step.hold, "caption.hold"))
        await page.evaluate(() => {
          window.__slipmemTourCaption?.(null)
        })
      }
      return
    }
    case "goto": {
      const target = new URL(requireString(step.goto, "goto"), baseUrl).href
      await page.goto(target, {
        waitUntil: step.waitUntil ?? "domcontentloaded",
      })
      return
    }
    case "click": {
      const locator = locatorFor(step.click, "click")
      await pointAt(locator)
      await locator.click()
      return
    }
    case "hover": {
      await pointAt(locatorFor(step.hover, "hover"))
      return
    }
    case "fill": {
      if (typeof step.fill !== "object" || step.fill === null) {
        throw new Error("fill must be an object with selector and value")
      }
      const locator = locatorFor(step.fill.selector, "fill.selector")
      await pointAt(locator)
      await locator.fill(requireString(step.fill.value, "fill.value"))
      return
    }
    case "type": {
      if (typeof step.type !== "object" || step.type === null) {
        throw new Error("type must be an object with selector and text")
      }
      const locator = locatorFor(step.type.selector, "type.selector")
      await pointAt(locator)
      await locator.click()
      await locator.pressSequentially(requireString(step.type.text, "type.text"), {
        delay: step.type.delay ?? 55,
      })
      return
    }
    case "press": {
      if (typeof step.press === "string") {
        await page.keyboard.press(requireString(step.press, "press"))
        return
      }
      if (typeof step.press !== "object" || step.press === null) {
        throw new Error("press must be a key string or an object with key")
      }
      const key = requireString(step.press.key, "press.key")
      if (step.press.selector === undefined) {
        await page.keyboard.press(key)
        return
      }
      await locatorFor(step.press.selector, "press.selector").press(key)
      return
    }
    case "waitFor": {
      const options =
        typeof step.waitFor === "string"
          ? { selector: step.waitFor }
          : step.waitFor
      if (typeof options !== "object" || options === null) {
        throw new Error("waitFor must be a selector string or an object")
      }
      await locatorFor(options.selector, "waitFor.selector").waitFor({
        state: options.state ?? "visible",
        timeout: options.timeout ?? 15000,
      })
      return
    }
    case "wait": {
      await page.waitForTimeout(requireMillis(step.wait, "wait"))
      return
    }
    case "scroll": {
      const options =
        typeof step.scroll === "number" ? { dy: step.scroll } : step.scroll
      if (typeof options !== "object" || options === null) {
        throw new Error("scroll must be a number or an object with dx/dy")
      }
      await page.mouse.move(width / 2, height / 2)
      await page.mouse.wheel(options.dx ?? 0, options.dy ?? 0)
      await page.waitForTimeout(250)
      return
    }
    case "screenshot": {
      const options =
        typeof step.screenshot === "string"
          ? { name: step.screenshot }
          : step.screenshot
      if (typeof options !== "object" || options === null) {
        throw new Error("screenshot must be a name string or an object")
      }
      const name = requireString(options.name, "screenshot.name")
      const fileName = name.endsWith(".png") ? name : `${name}.png`
      const target = resolve(stillsDir, fileName)
      if (!target.startsWith(`${stillsDir}/`)) {
        throw new Error("screenshot.name must stay inside the stills directory")
      }
      await mkdir(dirname(target), { recursive: true })
      await page.screenshot({ path: target, fullPage: options.fullPage ?? false })
      return
    }
    default:
      throw new Error(`unsupported action: ${present[0]}`)
  }
}

let failure
try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(500)

  for (const [index, step] of config.steps.entries()) {
    if (typeof step !== "object" || step === null || Array.isArray(step)) {
      throw new Error(`step ${index + 1} must be an object`)
    }
    const atMs = mark(step, index)
    process.stdout.write(`[${(atMs / 1000).toFixed(1)}s] step ${index + 1}\n`)
    await runStep(step, index)
  }

  // Keep the last frame readable before the video ends.
  await page.waitForTimeout(400)
} catch (error) {
  failure = error
  console.error(`tour: ${error.message}`)
  await mkdir(stillsDir, { recursive: true }).catch(() => undefined)
  await page
    .screenshot({ path: join(stillsDir, "error.png") })
    .catch(() => undefined)
  await writeFile(
    logPath,
    `${JSON.stringify({ baseUrl, width, height, actions, error: error.message }, null, 2)}\n`,
  ).catch(() => undefined)
}

await context.close().catch(() => undefined)
await browser.close().catch(() => undefined)

if (video !== null) {
  const rawPath = await video.path().catch(() => null)
  if (rawPath !== null) {
    await rename(rawPath, outputPath).catch((error) => {
      if (!failure) {
        failure = error
      }
      console.error(`tour: could not save video: ${error.message}`)
    })
  }
}
await rm(rawDir, { recursive: true, force: true })

await writeFile(
  logPath,
  `${JSON.stringify(
    {
      baseUrl,
      width,
      height,
      durationMs: Date.now() - startedAt,
      output: outputPath,
      failure: failure?.message ?? null,
      actions,
    },
    null,
    2,
  )}\n`,
)

if (failure) {
  console.error(`tour: failed; partial artifacts are in ${outputDir}`)
  process.exit(1)
}

console.log(`tour: wrote ${outputPath}`)
console.log(`tour: action log ${logPath}`)
