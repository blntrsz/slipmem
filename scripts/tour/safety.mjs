// Safety policy for the local tour recorder. These helpers are deliberately
// free of Playwright imports so they can be unit-tested without a browser.
//
// The recorder is an operator tool, not a sandbox. It should still refuse
// obviously destructive or surprising configurations: output (and therefore
// the temporary recording directory that is deleted) stays inside a dedicated
// output root, that root is never a note root, and navigation stays on the
// origin of the recorded app unless the script explicitly allows another one.

import { existsSync } from "node:fs"
import { lstat, mkdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path"

export const NOTE_DIRECTORY = ".slipmem"
export const REDACTED_INPUT = "<redacted>"
export const DEFAULT_URL = "http://localhost:3000/"
export const DEFAULT_OUTPUT_NAME = "slipmem-tour.webm"

const WEB_PROTOCOLS = new Set(["http:", "https:"])

export class TourSafetyError extends Error {
  constructor(message) {
    super(message)
    this.name = "TourSafetyError"
  }
}

const fail = (message) => {
  throw new TourSafetyError(message)
}

/** True when `child` is `parent` or a descendant of it, lexically. */
export const isInside = (parent, child) => {
  const rel = relative(resolve(parent), resolve(child))
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  )
}

export const hasNoteRootSegment = (path) =>
  resolve(path).split(sep).includes(NOTE_DIRECTORY)

/**
 * Note roots that apply to this recorder process: an explicit `SLIPMEM_DIR`
 * and the nearest existing `.slipmem/` ancestor, matching the app's frozen
 * resolution order closely enough to refuse writing into note storage.
 */
export const findNoteRoots = ({ cwd = process.cwd(), env = process.env } = {}) => {
  const roots = new Set()
  const configured = env.SLIPMEM_DIR?.trim()
  if (configured !== undefined && configured.length > 0) {
    roots.add(resolve(cwd, configured))
  }

  let current = resolve(cwd)
  while (true) {
    const candidate = join(current, NOTE_DIRECTORY)
    if (existsSync(candidate)) {
      roots.add(candidate)
    }
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  return [...roots]
}

const assertNotNotePath = (path, label, options) => {
  if (hasNoteRootSegment(path)) {
    fail(`${label} must not be inside a "${NOTE_DIRECTORY}" note root`)
  }
  for (const noteRoot of findNoteRoots(options)) {
    if (isInside(noteRoot, path)) {
      fail(`${label} must not be inside the slipmem note root (${noteRoot})`)
    }
  }
}

/**
 * Resolves the dedicated output root. It defaults to `<tour>/output`; an
 * operator may opt into another directory with `TOUR_OUTPUT_ROOT`.
 */
export const resolveOutputRoot = ({
  tourDir,
  env = process.env,
  cwd = process.cwd(),
} = {}) => {
  const configured = env.TOUR_OUTPUT_ROOT?.trim()
  const root =
    configured !== undefined && configured.length > 0
      ? resolve(cwd, configured)
      : join(tourDir, "output")

  if (root === parse(root).root) {
    fail("TOUR_OUTPUT_ROOT must not be the filesystem root")
  }
  if (root === resolve(homedir())) {
    fail("TOUR_OUTPUT_ROOT must not be the home directory")
  }
  if (isInside(root, tourDir)) {
    fail(
      "TOUR_OUTPUT_ROOT must not be the tour directory or one of its ancestors; choose a dedicated output directory",
    )
  }
  assertNotNotePath(root, "The output directory", { cwd, env })
  return root
}

const nearestExisting = async (path) => {
  let current = resolve(path)
  while (true) {
    try {
      await lstat(current)
      return current
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error
      }
    }
    const parent = dirname(current)
    if (parent === current) {
      return current
    }
    current = parent
  }
}

const assertExistingAncestorInside = async (rootReal, target, label) => {
  const existing = await nearestExisting(target)
  const existingReal = await realpath(existing)
  if (!isInside(rootReal, existingReal)) {
    fail(
      `${label} must stay inside the output directory (${rootReal}); ${target} resolves to ${existingReal}`,
    )
  }
}

/**
 * Creates `dir`, then verifies that its real path (following symlinks) is
 * still inside the already-validated output root.
 */
export const ensureDirectoryInside = async (rootReal, dir, label) => {
  await mkdir(dir, { recursive: true })
  const real = await realpath(dir)
  if (!isInside(rootReal, real)) {
    fail(`${label} must stay inside the output directory (${rootReal})`)
  }
  return real
}

/**
 * Validates the output location and creates the dedicated output root.
 *
 * The returned paths are absolute. Only `outputRoot` is created here; callers
 * create child directories with `ensureDirectoryInside` so every write is
 * checked against the real root.
 */
export const resolveOutputPaths = async ({
  tourDir,
  output = DEFAULT_OUTPUT_NAME,
  env = process.env,
  cwd = process.cwd(),
} = {}) => {
  const outputRoot = resolveOutputRoot({ tourDir, env, cwd })

  if (typeof output !== "string" || output.trim().length === 0) {
    fail("output must be a non-empty string")
  }
  if (isAbsolute(output)) {
    fail("output must be relative to the tour output directory, not absolute")
  }

  const outputPath = resolve(outputRoot, output)
  if (!isInside(outputRoot, outputPath) || outputPath === outputRoot) {
    fail("output must stay inside the tour output directory")
  }
  if (!outputPath.endsWith(".webm")) {
    fail('output must end with ".webm"')
  }
  assertNotNotePath(outputPath, "The output file", { cwd, env })

  // Check the nearest existing ancestor before creating anything, so an
  // alias/symlink cannot make us create directories inside a note root.
  const rootAncestorReal = await realpath(await nearestExisting(outputRoot))
  assertNotNotePath(rootAncestorReal, "The output directory", { cwd, env })

  try {
    await mkdir(outputRoot, { recursive: true })
  } catch (error) {
    fail(
      `cannot create the output directory ${outputRoot}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  const outputRootReal = await realpath(outputRoot)
  if (outputRootReal === parse(outputRootReal).root) {
    fail("The output directory must not resolve to the filesystem root")
  }
  if (outputRootReal === resolve(homedir())) {
    fail("The output directory must not resolve to the home directory")
  }
  const tourDirReal = await realpath(tourDir)
  if (isInside(outputRootReal, tourDirReal)) {
    fail(
      "The output directory must not resolve to the tour directory or one of its ancestors",
    )
  }
  assertNotNotePath(outputRootReal, "The output directory", { cwd, env })
  await assertExistingAncestorInside(outputRootReal, outputPath, "The output file")

  const existing = await lstat(outputPath).catch((error) => {
    if (error.code === "ENOENT") {
      return null
    }
    throw error
  })
  if (existing?.isDirectory()) {
    fail("output must name a file, not a directory")
  }

  return {
    outputRoot,
    outputRootReal,
    outputPath,
    outputDir: dirname(outputPath),
    stillsDir: join(dirname(outputPath), "stills"),
    logPath: outputPath.replace(/\.webm$/, ".actions.json"),
  }
}

/** Resolves a screenshot path and confirms it cannot escape the stills dir. */
export const resolveScreenshotPath = async ({
  outputRoot,
  stillsDir,
  name,
}) => {
  if (typeof name !== "string" || name.trim().length === 0) {
    fail("screenshot name must be a non-empty string")
  }
  const fileName = name.endsWith(".png") ? name : `${name}.png`
  const target = resolve(stillsDir, fileName)
  if (!isInside(stillsDir, target) || target === resolve(stillsDir)) {
    fail("screenshot name must stay inside the stills directory")
  }
  await mkdir(dirname(target), { recursive: true })
  await assertExistingAncestorInside(outputRoot, target, "The screenshot path")
  return target
}

export const parseBaseUrl = (value) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("url must be a non-empty string")
  }

  let url
  try {
    url = new URL(value)
  } catch {
    fail(`url is not a valid URL: ${value}`)
  }
  if (!WEB_PROTOCOLS.has(url.protocol)) {
    fail('url must use http: or https:; file: and other schemes are not allowed')
  }
  if (url.username !== "" || url.password !== "") {
    fail("url must not contain credentials")
  }
  return url
}

/**
 * The recorded origin is allowed by default. Additional origins must be listed
 * explicitly in the tour script's `allowedOrigins` array.
 */
export const resolveAllowedOrigins = (baseUrl, configured) => {
  const origins = new Set([baseUrl.origin])
  if (configured === undefined) {
    return [...origins]
  }
  if (!Array.isArray(configured)) {
    fail(
      'allowedOrigins must be an array of origins such as "https://example.com"',
    )
  }

  for (const entry of configured) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      fail("allowedOrigins entries must be non-empty origin strings")
    }
    let url
    try {
      url = new URL(entry)
    } catch {
      fail(`allowedOrigins entry is not a valid URL: ${entry}`)
    }
    if (!WEB_PROTOCOLS.has(url.protocol)) {
      fail(`allowedOrigins entry must use http: or https:; got ${entry}`)
    }
    if (url.username !== "" || url.password !== "") {
      fail(`allowedOrigins entry must not contain credentials: ${entry}`)
    }
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      fail(
        `allowedOrigins entry must be an origin without a path, query, or hash: ${entry}`,
      )
    }
    origins.add(url.origin)
  }

  return [...origins]
}

export const assertNavigationAllowed = (
  target,
  allowedOrigins,
  { base, label = "navigation" } = {},
) => {
  let url
  try {
    url = base === undefined ? new URL(target) : new URL(target, base)
  } catch {
    fail(`${label} target is not a valid URL: ${target}`)
  }

  if (!WEB_PROTOCOLS.has(url.protocol)) {
    fail(
      `${label} must use http: or https:; ${url.protocol} is not allowed`,
    )
  }
  if (url.username !== "" || url.password !== "") {
    fail(`${label} must not contain credentials`)
  }
  if (!allowedOrigins.includes(url.origin)) {
    fail(
      `${label} to ${url.origin} is not allowed. The recorder only navigates to ${allowedOrigins.join(
        ", ",
      )}. Add an explicit "allowedOrigins" entry to the tour script if this is intentional.`,
    )
  }
  return url
}

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Return the step as it should be written to the action log. Fill values and
 * typed text are redacted unless the operator explicitly asks to keep them.
 */
export const redactStepForLog = (step, { includeInputValues = false } = {}) => {
  if (includeInputValues || !isPlainObject(step)) {
    return step
  }

  const redacted = { ...step }
  if (isPlainObject(redacted.fill) && "value" in redacted.fill) {
    redacted.fill = { ...redacted.fill, value: REDACTED_INPUT }
  }
  if (isPlainObject(redacted.type) && "text" in redacted.type) {
    redacted.type = { ...redacted.type, text: REDACTED_INPUT }
  }
  return redacted
}
