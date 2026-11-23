import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { builtinModules } from "node:module"
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"

/**
 * Small architecture guardrails for the workspace.
 *
 * This file lives at the repository root on purpose: `tsconfig.json` only
 * includes package `src` trees, so these checks do not become part of a
 * package's production build or published surface.
 */

const ROOT = import.meta.dir
const PACKAGES_DIRECTORY = join(ROOT, "packages")
const SOURCE_PATTERN = "packages/*/src/**/*.ts"

type PackageManifest = {
  readonly name?: string
  readonly exports?: unknown
  readonly main?: string
  readonly module?: string
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
}

type PackageInfo = {
  readonly name: string
  readonly directory: string
  readonly relativeDirectory: string
  readonly manifest: PackageManifest
}

type WorkspaceResolution = {
  readonly package: PackageInfo
  readonly subpath: string
  readonly target?: string
  readonly missingExport?: boolean
}

type ImportResolution =
  | {
      readonly kind: "relative" | "absolute"
      readonly target: string
    }
  | ({ readonly kind: "workspace" } & WorkspaceResolution)

const toPosix = (value: string): string => value.replaceAll("\\", "/")

const relativeToRoot = (absolutePath: string): string =>
  toPosix(relative(ROOT, absolutePath))

const readJson = <A>(path: string): A =>
  JSON.parse(readFileSync(path, "utf8")) as A

const loadPackages = (): ReadonlyArray<PackageInfo> =>
  readdirSync(PACKAGES_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PACKAGES_DIRECTORY, entry.name))
    .filter((directory) => existsSync(join(directory, "package.json")))
    .map((directory) => {
      const manifest = readJson<PackageManifest>(join(directory, "package.json"))
      return {
        name: manifest.name ?? toPosix(relative(ROOT, directory)),
        directory,
        relativeDirectory: toPosix(relative(ROOT, directory)),
        manifest,
      }
    })

const packages = loadPackages()
const packageByName = new Map(packages.map((pkg) => [pkg.name, pkg]))

const sourceFiles = [...new Bun.Glob(SOURCE_PATTERN).scanSync({ cwd: ROOT })]
  .map(toPosix)
  .sort()

const isTestSource = (file: string): boolean =>
  /\.(?:test|spec)\.tsx?$/.test(file)

const isTestSupport = (file: string): boolean =>
  /(?:^|\/)test-support\//.test(file)

const isProductionSource = (file: string): boolean =>
  !isTestSource(file) && !isTestSupport(file)

const readSource = (file: string): string =>
  readFileSync(join(ROOT, file), "utf8")

const transpiler = new Bun.Transpiler({ loader: "ts" })

/**
 * `scanImports` is AST-based, but Bun deliberately elides type-only imports.
 * Rewriting just the declaration keyword (not strings or arbitrary code) lets
 * the same scanner see `import type` / `export type` without a second parser.
 */
const normalizeTypeOnlyImports = (source: string): string =>
  source
    .replace(/^#![^\n]*\r?\n/, "")
    .replace(
      /(\b(?:import|export)\s+)type\s+((?:\{[^}]*\}|\*\s+as\s+\w+|\*|\w+)\s+from\s*["'][^"']+["'])/g,
      "$1$2",
    )
    .replace(
      /(\b(?:import|export)\s+(?:type\s+)?\{)([^}]*)(\})/g,
      (_match, open: string, bindings: string, close: string) =>
        open + bindings.replace(/\btype\s+/g, "") + close,
    )

const importSpecifiers = (source: string): ReadonlyArray<string> => {
  const normalized = normalizeTypeOnlyImports(source)
  return [...new Set(transpiler.scanImports(normalized).map((item) => item.path))]
}

const importedNamesFrom = (
  source: string,
  specifier: string,
): ReadonlyArray<string> => {
  const names = new Set<string>()
  const declaration =
    /\b(?:import|export)\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+[\w$]+|([\w$]+))?\s*from\s*["']([^"']+)["']/g

  for (const match of normalizeTypeOnlyImports(source).matchAll(declaration)) {
    if (match[4] !== specifier) continue
    for (const part of (match[2] ?? "").split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim()
      if (name) names.add(name)
    }
    if (match[3]) names.add(match[3])
  }

  return [...names]
}

const fileCandidates = (base: string): ReadonlyArray<string> => {
  const extension = extname(base)
  const withoutExtension =
    extension === "" ? base : base.slice(0, -extension.length)
  const candidates = [base]

  if (extension === ".js") {
    candidates.push(`${withoutExtension}.ts`, `${withoutExtension}.tsx`)
  } else if (extension === ".jsx") {
    candidates.push(`${withoutExtension}.tsx`, `${withoutExtension}.ts`)
  } else if (extension === ".mjs") {
    candidates.push(`${withoutExtension}.mts`)
  } else if (extension === ".cjs") {
    candidates.push(`${withoutExtension}.cts`)
  }

  candidates.push(
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  )

  return candidates
}

const resolveFileTarget = (base: string): string =>
  fileCandidates(base).find((candidate) => existsSync(candidate)) ?? base

const resolveRelativeImport = (file: string, specifier: string): string =>
  resolveFileTarget(resolve(dirname(join(ROOT, file)), specifier))

const pickExportTarget = (value: unknown): string | undefined => {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = pickExportTarget(item)
      if (target) return target
    }
    return undefined
  }
  if (value !== null && typeof value === "object") {
    for (const condition of [
      "types",
      "import",
      "default",
      "node",
      "browser",
      "require",
    ]) {
      const target = pickExportTarget(
        (value as Record<string, unknown>)[condition],
      )
      if (target) return target
    }
  }
  return undefined
}

const resolveExportTarget = (
  exportsField: unknown,
  subpath: string,
): string | undefined => {
  const key = subpath === "" ? "." : `./${subpath}`

  if (exportsField === undefined || exportsField === null) {
    return undefined
  }

  if (typeof exportsField === "string") {
    return subpath === "" ? exportsField : undefined
  }

  if (typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return undefined
  }

  const exportMap = exportsField as Record<string, unknown>
  const keys = Object.keys(exportMap)
  const isSubpathMap = keys.some((entry) => entry.startsWith("."))

  if (!isSubpathMap) {
    return subpath === "" ? pickExportTarget(exportMap) : undefined
  }

  const direct = pickExportTarget(exportMap[key])
  if (direct !== undefined) return direct

  for (const [pattern, value] of Object.entries(exportMap)) {
    if (!pattern.includes("*")) continue
    const [prefix, suffix] = pattern.split("*")
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue
    const wildcard = key.slice(prefix.length, key.length - suffix.length)
    return pickExportTarget(value)?.replaceAll("*", wildcard)
  }

  return undefined
}

const resolveWorkspaceSpecifier = (
  specifier: string,
): WorkspaceResolution | undefined => {
  const match = /^(@slipmem\/[^/]+)(?:\/(.+))?$/.exec(specifier)
  if (!match) return undefined

  const packageName = match[1]!
  const subpath = match[2] ?? ""
  const pkg = packageByName.get(packageName)
  if (!pkg) return undefined

  const exportTarget = resolveExportTarget(pkg.manifest.exports, subpath)
  const fallback =
    subpath === ""
      ? pkg.manifest.module ?? pkg.manifest.main ?? "src/index.ts"
      : undefined
  const target =
    exportTarget ??
    (pkg.manifest.exports === undefined ? fallback : undefined)

  if (target === undefined) {
    return { package: pkg, subpath, missingExport: true }
  }

  return {
    package: pkg,
    subpath,
    target: resolveFileTarget(resolve(pkg.directory, target)),
  }
}

const resolveImport = (
  file: string,
  specifier: string,
): ImportResolution | undefined => {
  if (specifier.startsWith(".")) {
    return { kind: "relative", target: resolveRelativeImport(file, specifier) }
  }
  if (isAbsolute(specifier)) {
    return { kind: "absolute", target: specifier }
  }

  const workspace = resolveWorkspaceSpecifier(specifier)
  return workspace === undefined
    ? undefined
    : { kind: "workspace", ...workspace }
}

const owningPackage = (file: string): PackageInfo => {
  const pkg = packages.find(
    (candidate) =>
      file === candidate.relativeDirectory ||
      file.startsWith(`${candidate.relativeDirectory}/`),
  )
  if (!pkg) throw new Error(`No package owns ${file}`)
  return pkg
}

const isInsideDirectory = (directory: string, target: string): boolean => {
  const relation = relative(directory, target)
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) &&
      relation !== ".." &&
      !isAbsolute(relation))
  )
}

/**
 * Retired SQLite note CRUD entry points. This is deliberately a list of the
 * concrete modules, not a ban on SQLite itself: the derived FTS search index
 * and migration infrastructure are allowed to use SQLite.
 */
const RETIRED_SQLITE_CRUD_MODULES: ReadonlyArray<RegExp> = [
  /^packages\/core\/src\/legacy\/sqlite\.ts$/,
  /^packages\/core\/src\/note-database\.ts$/,
  /^packages\/core\/src\/sqlite-note-operations\.ts$/,
  /^packages\/core\/src\/(?:fleeting-note|literature-note|permanent-note|note)\/sqlite[^/]*\.service\.ts$/i,
  /^packages\/server\/src\/database\.ts$/,
  /^packages\/server\/src\/legacy\.ts$/,
]

const isRetiredSqliteCrudModule = (file: string): boolean => {
  const normalized = toPosix(
    isAbsolute(file) ? relative(ROOT, file) : file,
  )
  return RETIRED_SQLITE_CRUD_MODULES.some((pattern) => pattern.test(normalized))
}

const RETIRED_SQLITE_CRUD_EXPORTS = new Set([
  "makeNoteDatabaseLayer",
  "NoteDatabaseLive",
  "NoteDatabaseService",
  "NoteDatabase",
  "NoteDatabaseConfig",
  "SQLiteFleetingNoteService",
  "SQLiteLiteratureNoteService",
  "SQLitePermanentNoteService",
  "SQLiteNoteService",
])

/**
 * Exact, temporary allowances. Keep each entry to one file/specifier pair and
 * a reason; do not turn these into directory or package wildcards.
 *
 * There are currently no cross-package relative allowances.
 */
const CROSS_PACKAGE_RELATIVE_ALLOWANCES = new Map<string, string>()

const RETIRED_CRUD_IMPORT_ALLOWANCES = new Map<string, string>()

type CrossPackageRelativeImport = {
  readonly key: string
  readonly target: string
  readonly pkg: PackageInfo
}

const crossPackageRelativeImports =
  (): ReadonlyArray<CrossPackageRelativeImport> => {
    const imports: CrossPackageRelativeImport[] = []

    for (const file of sourceFiles) {
      const pkg = owningPackage(file)
      for (const specifier of importSpecifiers(readSource(file))) {
        if (!specifier.startsWith(".")) continue
        const target = resolveRelativeImport(file, specifier)
        if (isInsideDirectory(pkg.directory, target)) continue

        imports.push({
          key: `${file} -> ${specifier}`,
          target,
          pkg,
        })
      }
    }

    return imports
  }

const crossPackageRelativeViolations = (): ReadonlyArray<string> =>
  crossPackageRelativeImports()
    .filter((entry) => !CROSS_PACKAGE_RELATIVE_ALLOWANCES.has(entry.key))
    .map(
      (entry) =>
        `${entry.key} resolves to ${relativeToRoot(entry.target)} outside ${entry.pkg.relativeDirectory}`,
    )

const privateSubpathViolations = (): ReadonlyArray<string> => {
  const violations: string[] = []

  for (const file of sourceFiles) {
    for (const specifier of importSpecifiers(readSource(file))) {
      const workspace = resolveWorkspaceSpecifier(specifier)
      if (!workspace) continue

      if (workspace.missingExport) {
        violations.push(
          `${file} imports unexported subpath ${specifier} from ${workspace.package.relativeDirectory}`,
        )
        continue
      }

      if (workspace.target && !existsSync(workspace.target)) {
        violations.push(
          `${file} imports ${specifier}, which does not resolve to a file`,
        )
      }
    }
  }

  return violations
}

const retiredCrudViolations = (): ReadonlyArray<string> => {
  const violations: string[] = []

  for (const file of sourceFiles.filter(isProductionSource)) {
    // Retired compatibility modules may compose with each other. The rule is
    // that active production code must not reach them.
    if (isRetiredSqliteCrudModule(file)) continue

    const source = readSource(file)
    for (const specifier of importSpecifiers(source)) {
      const resolution = resolveImport(file, specifier)
      if (!resolution) continue

      const key = `${file} -> ${specifier}`
      const allowed = RETIRED_CRUD_IMPORT_ALLOWANCES.has(key)

      if (
        resolution.kind !== "workspace" &&
        isRetiredSqliteCrudModule(resolution.target) &&
        !allowed
      ) {
        violations.push(
          `${key} imports retired SQLite note CRUD (${relativeToRoot(resolution.target)})`,
        )
        continue
      }

      if (
        resolution.kind === "workspace" &&
        resolution.target !== undefined &&
        isRetiredSqliteCrudModule(resolution.target) &&
        !allowed
      ) {
        violations.push(
          `${key} imports retired SQLite note CRUD (${relativeToRoot(resolution.target)})`,
        )
        continue
      }

      if (
        resolution.kind === "workspace" &&
        resolution.subpath === "" &&
        !allowed
      ) {
        for (const name of importedNamesFrom(source, specifier)) {
          if (RETIRED_SQLITE_CRUD_EXPORTS.has(name)) {
            violations.push(
              `${file} imports retired SQLite note CRUD export ${name} from ${specifier}`,
            )
          }
        }
      }
    }
  }

  return violations
}

const dependencyFields = (pkg: PackageInfo): Record<string, string> => ({
  ...pkg.manifest.dependencies,
  ...pkg.manifest.peerDependencies,
  ...pkg.manifest.optionalDependencies,
})

const isBuiltinSpecifier = (specifier: string): boolean =>
  specifier.startsWith("node:") ||
  specifier.startsWith("bun:") ||
  specifier.startsWith("#") ||
  builtinModules.includes(specifier) ||
  builtinModules.includes(specifier.split("/")[0]!)

const externalPackageName = (specifier: string): string =>
  specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0]!

const dependencyGraph = (): Map<string, Set<string>> => {
  const graph = new Map<string, Set<string>>(
    packages.map((pkg) => [pkg.name, new Set<string>()]),
  )

  const addEdge = (from: string, to: string): void => {
    graph.get(from)?.add(to)
  }

  for (const pkg of packages) {
    for (const dependency of Object.keys(dependencyFields(pkg))) {
      if (packageByName.has(dependency)) addEdge(pkg.name, dependency)
    }
  }

  for (const file of sourceFiles.filter(isProductionSource)) {
    const pkg = owningPackage(file)
    for (const specifier of importSpecifiers(readSource(file))) {
      if (specifier.startsWith(".") || isAbsolute(specifier)) continue
      const workspace = resolveWorkspaceSpecifier(specifier)
      if (workspace) addEdge(pkg.name, workspace.package.name)
    }
  }

  return graph
}

const findCycle = (
  graph: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyArray<string> | undefined => {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []

  const visit = (node: string): ReadonlyArray<string> | undefined => {
    if (visiting.has(node)) {
      return [...stack.slice(stack.indexOf(node)), node]
    }
    if (visited.has(node)) return undefined

    visiting.add(node)
    stack.push(node)
    for (const dependency of [...(graph.get(node) ?? [])].sort()) {
      const cycle = visit(dependency)
      if (cycle) return cycle
    }
    stack.pop()
    visiting.delete(node)
    visited.add(node)
    return undefined
  }

  for (const node of [...graph.keys()].sort()) {
    const cycle = visit(node)
    if (cycle) return cycle
  }

  return undefined
}

const dependencyViolations = (): ReadonlyArray<string> => {
  const violations: string[] = []

  for (const pkg of packages) {
    for (const dependency of Object.keys(dependencyFields(pkg))) {
      if (
        dependency.startsWith("@slipmem/") &&
        !packageByName.has(dependency)
      ) {
        violations.push(
          `${pkg.relativeDirectory}/package.json declares unknown workspace dependency ${dependency}`,
        )
      }
    }
  }

  for (const file of sourceFiles.filter(isProductionSource)) {
    const pkg = owningPackage(file)
    const declared = dependencyFields(pkg)

    for (const specifier of importSpecifiers(readSource(file))) {
      if (specifier.startsWith(".") || isAbsolute(specifier)) continue
      if (isBuiltinSpecifier(specifier)) continue

      const workspace = resolveWorkspaceSpecifier(specifier)
      if (workspace) {
        if (workspace.package.name === pkg.name) {
          violations.push(`${file} imports its own package ${specifier}`)
        }
        if (!(workspace.package.name in declared)) {
          violations.push(
            `${file} imports ${specifier}, but ${pkg.relativeDirectory}/package.json does not declare ${workspace.package.name}`,
          )
        }
        continue
      }

      const external = externalPackageName(specifier)
      if (external.startsWith("@slipmem/")) {
        violations.push(`${file} imports unknown workspace package ${specifier}`)
        continue
      }
      if (!(external in declared)) {
        violations.push(
          `${file} imports ${specifier}, but ${pkg.relativeDirectory}/package.json does not declare ${external}`,
        )
      }
    }
  }

  return violations
}

describe("architecture guardrails", () => {
  test("scans type-only imports as well as runtime imports", () => {
    expect(
      importSpecifiers(
        'import type { A } from "../a"\nexport type { B } from "../b"\nexport type * from "../c"',
      ),
    ).toEqual(["../a", "../b", "../c"])
  })

  test("forbids cross-package relative private imports", () => {
    expect(crossPackageRelativeViolations()).toEqual([])
  })

  test("keeps temporary cross-package allowances exact and self-cleaning", () => {
    const active = new Set(
      crossPackageRelativeImports().map((entry) => entry.key),
    )

    for (const key of CROSS_PACKAGE_RELATIVE_ALLOWANCES.keys()) {
      expect(active.has(key)).toBe(true)
    }
  })

  test("forbids unexported workspace package subpaths", () => {
    expect(privateSubpathViolations()).toEqual([])
  })

  test("keeps production package dependencies declared and acyclic", () => {
    expect(dependencyViolations()).toEqual([])
    expect(findCycle(dependencyGraph())).toBeUndefined()
  })

  test("detects a synthetic package dependency cycle", () => {
    expect(
      findCycle(
        new Map([
          ["a", new Set(["b"])],
          ["b", new Set(["a"])],
        ]),
      ),
    ).toEqual(["a", "b", "a"])
  })

  test("forbids live retired SQLite note CRUD imports", () => {
    expect(retiredCrudViolations()).toEqual([])
  })

  test("classifies the known retired SQLite CRUD modules", () => {
    for (const file of [
      "packages/core/src/legacy/sqlite.ts",
      "packages/core/src/note-database.ts",
      "packages/core/src/sqlite-note-operations.ts",
      "packages/core/src/fleeting-note/sqlite-fleeting-note.service.ts",
      "packages/core/src/literature-note/sqlite-literature-note.service.ts",
      "packages/core/src/permanent-note/sqlite-permanent-note.service.ts",
      "packages/core/src/note/SQLite-note.service.ts",
      "packages/server/src/database.ts",
      "packages/server/src/legacy.ts",
    ]) {
      expect(isRetiredSqliteCrudModule(file)).toBe(true)
    }
  })

  test("detects retired CRUD through either a package root or a subpath", () => {
    const root = resolveWorkspaceSpecifier("@slipmem/core")
    const subpath = resolveWorkspaceSpecifier("@slipmem/core/legacy/sqlite")
    const serverLegacy = resolveWorkspaceSpecifier("@slipmem/server/legacy")

    expect(root?.target && isRetiredSqliteCrudModule(root.target)).toBe(false)
    expect(subpath?.target && isRetiredSqliteCrudModule(subpath.target)).toBe(
      true,
    )
    expect(
      serverLegacy?.target && isRetiredSqliteCrudModule(serverLegacy.target),
    ).toBe(true)

    const syntheticRootImport = `import { SQLiteNoteService } from "@slipmem/core"`
    expect(importedNamesFrom(syntheticRootImport, "@slipmem/core")).toContain(
      "SQLiteNoteService",
    )
  })

  test("resolves runtime entry points without assuming a package or subpath shape", () => {
    const runtimes = ["@slipmem/core/runtime", "@slipmem/runtime"]
      .map(resolveWorkspaceSpecifier)
      .filter(
        (runtime): runtime is WorkspaceResolution => runtime !== undefined,
      )

    expect(runtimes.length).toBeGreaterThan(0)
    for (const runtime of runtimes) {
      expect(runtime.missingExport).toBeUndefined()
      expect(runtime.target && existsSync(runtime.target)).toBe(true)
      expect(runtime.target && isRetiredSqliteCrudModule(runtime.target)).toBe(
        false,
      )
    }
  })

  test("does not treat the derived SQLite FTS index as retired CRUD", () => {
    const searchIndex = "packages/core/src/markdown/search-index.ts"

    expect(importSpecifiers(readSource(searchIndex))).toContain("bun:sqlite")
    expect(isRetiredSqliteCrudModule(searchIndex)).toBe(false)
    expect(
      retiredCrudViolations().filter((entry) => entry.includes(searchIndex)),
    ).toEqual([])
  })
})
