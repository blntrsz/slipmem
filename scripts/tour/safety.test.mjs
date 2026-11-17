import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  REDACTED_INPUT,
  TourSafetyError,
  assertNavigationAllowed,
  findNoteRoots,
  parseBaseUrl,
  redactStepForLog,
  resolveAllowedOrigins,
  resolveOutputPaths,
  resolveOutputRoot,
  resolveScreenshotPath,
} from "./safety.mjs"

let temp

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "slipmem-tour-safety-"))
})

afterEach(async () => {
  await rm(temp, { recursive: true, force: true })
})

const makeTour = async () => {
  const tourDir = join(temp, "project", "scripts", "tour")
  await mkdir(tourDir, { recursive: true })
  return tourDir
}

describe("output containment", () => {
  test("default output root is the dedicated child of the tour directory", async () => {
    const tourDir = await makeTour()
    const paths = await resolveOutputPaths({
      tourDir,
      output: "tour.webm",
      env: {},
      cwd: tourDir,
    })

    expect(paths.outputRoot).toBe(join(tourDir, "output"))
    expect(paths.outputPath).toBe(join(tourDir, "output", "tour.webm"))
    expect(paths.logPath).toBe(join(tourDir, "output", "tour.actions.json"))
    expect(paths.stillsDir).toBe(join(tourDir, "output", "stills"))
  })

  test("an explicit output root is allowed and relative output stays inside it", async () => {
    const tourDir = await makeTour()
    const outputRoot = join(temp, "tour-output")
    const paths = await resolveOutputPaths({
      tourDir,
      output: "nested/tour.webm",
      env: { TOUR_OUTPUT_ROOT: outputRoot },
      cwd: tourDir,
    })

    expect(paths.outputRoot).toBe(outputRoot)
    expect(paths.outputPath).toBe(join(outputRoot, "nested", "tour.webm"))
  })

  test("rejects paths that escape the output root", async () => {
    const tourDir = await makeTour()

    await expect(
      resolveOutputPaths({
        tourDir,
        output: "../escape.webm",
        env: {},
        cwd: tourDir,
      }),
    ).rejects.toThrow("output must stay inside")

    await expect(
      resolveOutputPaths({
        tourDir,
        output: "/tmp/absolute.webm",
        env: {},
        cwd: tourDir,
      }),
    ).rejects.toThrow("not absolute")
  })

  test("rejects non-webm output", async () => {
    const tourDir = await makeTour()
    await expect(
      resolveOutputPaths({ tourDir, output: "tour.mp4", env: {}, cwd: tourDir }),
    ).rejects.toThrow('end with ".webm"')
  })

  test("rejects a note-root output root and note-root output paths", async () => {
    const tourDir = await makeTour()
    const noteRoot = join(temp, "notes")
    await mkdir(noteRoot, { recursive: true })

    await expect(
      resolveOutputPaths({
        tourDir,
        output: "tour.webm",
        env: { TOUR_OUTPUT_ROOT: noteRoot, SLIPMEM_DIR: noteRoot },
        cwd: tourDir,
      }),
    ).rejects.toThrow("note root")

    await expect(
      resolveOutputPaths({
        tourDir,
        output: ".slipmem/tour.webm",
        env: {},
        cwd: tourDir,
      }),
    ).rejects.toThrow('".slipmem" note root')
  })

  test("rejects an output root that resolves through a symlink into note storage", async () => {
    const tourDir = await makeTour()
    const noteRoot = join(temp, "notes")
    const link = join(temp, "out-link")
    await mkdir(noteRoot, { recursive: true })
    await symlink(noteRoot, link)

    await expect(
      resolveOutputPaths({
        tourDir,
        output: "tour.webm",
        env: { TOUR_OUTPUT_ROOT: link, SLIPMEM_DIR: noteRoot },
        cwd: tourDir,
      }),
    ).rejects.toThrow("note root")
  })

  test("refuses to create an output root below an alias of a note root", async () => {
    const tourDir = await makeTour()
    const noteRoot = join(temp, "notes")
    const alias = join(temp, "notes-alias")
    const root = join(alias, "new-output")
    await mkdir(noteRoot, { recursive: true })
    await symlink(noteRoot, alias)

    await expect(
      resolveOutputPaths({
        tourDir,
        output: "tour.webm",
        env: { TOUR_OUTPUT_ROOT: root, SLIPMEM_DIR: noteRoot },
        cwd: tourDir,
      }),
    ).rejects.toThrow("note root")
    await expect(stat(root)).rejects.toThrow()
  })

  test("rejects writing through a symlink that escapes the output root", async () => {
    const tourDir = await makeTour()
    const outputRoot = join(temp, "out")
    const outside = join(temp, "outside")
    await mkdir(outputRoot, { recursive: true })
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(outputRoot, "link"))

    await expect(
      resolveOutputPaths({
        tourDir,
        output: "link/tour.webm",
        env: { TOUR_OUTPUT_ROOT: outputRoot },
        cwd: tourDir,
      }),
    ).rejects.toThrow("must stay inside the output directory")
  })

  test("refuses an output root that is the tour directory or its ancestor", async () => {
    const tourDir = await makeTour()

    expect(() =>
      resolveOutputRoot({
        tourDir,
        env: { TOUR_OUTPUT_ROOT: tourDir },
        cwd: tourDir,
      }),
    ).toThrow("dedicated output directory")

    expect(() =>
      resolveOutputRoot({
        tourDir,
        env: { TOUR_OUTPUT_ROOT: join(temp, "project") },
        cwd: tourDir,
      }),
    ).toThrow("dedicated output directory")
  })

  test("finds configured and ancestor note roots", async () => {
    const project = join(temp, "project")
    const tourDir = join(project, "scripts", "tour")
    await mkdir(join(project, ".slipmem"), { recursive: true })
    await mkdir(tourDir, { recursive: true })

    const roots = findNoteRoots({
      cwd: tourDir,
      env: { SLIPMEM_DIR: join(temp, "custom-notes") },
    })
    expect(roots).toContain(join(project, ".slipmem"))
    expect(roots).toContain(join(temp, "custom-notes"))
  })

  test("screenshot paths cannot escape the stills directory", async () => {
    const tourDir = await makeTour()
    const paths = await resolveOutputPaths({
      tourDir,
      output: "tour.webm",
      env: {},
      cwd: tourDir,
    })
    await mkdir(paths.stillsDir, { recursive: true })

    const target = await resolveScreenshotPath({
      outputRoot: paths.outputRootReal,
      stillsDir: paths.stillsDir,
      name: "nested/shot",
    })
    expect(target).toBe(join(paths.stillsDir, "nested", "shot.png"))

    await expect(
      resolveScreenshotPath({
        outputRoot: paths.outputRootReal,
        stillsDir: paths.stillsDir,
        name: "../escape",
      }),
    ).rejects.toThrow("stay inside the stills directory")
  })

  test("validation failures use a specific error type", () => {
    expect(() => parseBaseUrl("file:///etc/passwd")).toThrow(TourSafetyError)
  })
})

describe("navigation policy", () => {
  test("accepts http base URLs and rejects file, javascript, ftp, and credentials", () => {
    expect(parseBaseUrl("http://localhost:3317/").origin).toBe(
      "http://localhost:3317",
    )
    expect(parseBaseUrl("https://example.com/app").protocol).toBe("https:")

    for (const url of [
      "file:///tmp/fixture.html",
      "javascript:alert(1)",
      "ftp://example.com/",
      "http://user:secret@localhost:3317/",
    ]) {
      expect(() => parseBaseUrl(url)).toThrow(TourSafetyError)
    }
  })

  test("allows the recorded origin by default and explicit extras only", () => {
    const base = parseBaseUrl("http://localhost:3317/")
    expect(resolveAllowedOrigins(base, undefined)).toEqual([
      "http://localhost:3317",
    ])
    expect(
      resolveAllowedOrigins(base, ["https://example.com/"]),
    ).toEqual(["http://localhost:3317", "https://example.com"])

    expect(() =>
      resolveAllowedOrigins(base, ["https://example.com/path"]),
    ).toThrow("without a path")
    expect(() => resolveAllowedOrigins(base, ["file:///tmp"])).toThrow(
      "http: or https:",
    )
    expect(() => resolveAllowedOrigins(base, "https://example.com")).toThrow(
      "must be an array",
    )
  })

  test("rejects navigation outside the allowlist", () => {
    const base = parseBaseUrl("http://localhost:3317/")
    const allowed = resolveAllowedOrigins(base, ["https://example.com"])

    expect(
      assertNavigationAllowed("/notes", allowed, { base: base.href }).href,
    ).toBe("http://localhost:3317/notes")
    expect(
      assertNavigationAllowed("https://example.com/done", allowed).href,
    ).toBe("https://example.com/done")

    expect(() =>
      assertNavigationAllowed("http://127.0.0.1:3317/", allowed),
    ).toThrow("is not allowed")
    expect(() =>
      assertNavigationAllowed("file:///etc/passwd", allowed),
    ).toThrow("http: or https:")
  })
})

describe("action-log redaction", () => {
  test("redacts fill values and typed text without mutating the step", () => {
    const step = {
      fill: { selector: "#token", value: "hunter2" },
      extra: true,
    }
    const redacted = redactStepForLog(step)
    expect(redacted.fill).toEqual({ selector: "#token", value: REDACTED_INPUT })
    expect(redacted.extra).toBe(true)
    expect(step.fill.value).toBe("hunter2")

    const typed = redactStepForLog({
      type: { selector: "#note", text: "private words", delay: 10 },
    })
    expect(typed.type).toEqual({
      selector: "#note",
      text: REDACTED_INPUT,
      delay: 10,
    })
    expect(JSON.stringify(redacted) + JSON.stringify(typed)).not.toContain(
      "hunter2",
    )
    expect(JSON.stringify(typed)).not.toContain("private words")
  })

  test("keeps values only when explicitly requested", () => {
    const step = { fill: { selector: "#token", value: "hunter2" } }
    const logged = redactStepForLog(step, { includeInputValues: true })
    expect(logged).toEqual(step)
  })
})
