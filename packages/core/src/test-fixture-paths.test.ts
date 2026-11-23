import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "../../..")
const hardcodedSandboxPath = ["", "tmp", "opencode"].join("/")

const ignoredDirectories = new Set([
  ".git",
  ".slipmem",
  ".turbo",
  ".cache",
  ".opencode",
  "build",
  "coverage",
  "dist",
  "node_modules",
])

const isFixtureFile = (name: string): boolean =>
  name.endsWith(".test.ts") ||
  name.endsWith(".test.tsx") ||
  /^test-.*\.ts$/.test(name)

// Walk the source tree directly so untracked fixtures and source archives
// without Git metadata are checked too. Generated and dependency directories
// are skipped so local build output cannot affect the guard.
const fixtureFiles = (directory: string): Array<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name)
        ? []
        : fixtureFiles(join(directory, entry.name))
    }
    return isFixtureFile(entry.name) ? [join(directory, entry.name)] : []
  })

test("source test fixtures use os.tmpdir instead of a hardcoded sandbox path", () => {
  const offenders = fixtureFiles(repoRoot)
    .filter((path) => readFileSync(path, "utf8").includes(hardcodedSandboxPath))
    .map((path) => relative(repoRoot, path))
    .sort()

  expect(offenders).toEqual([])
})
