#!/usr/bin/env bun
// Prepares the disposable, real-data scenario used by the product tour.
//
// Everything here is local operator tooling:
// - all notes are seeded through the real `slipmem` CLI;
// - the pending permanent proposal is submitted through the real HTTP MCP
//   endpoint, not by writing proposal JSON;
// - the work root is disposable (/tmp/opencode/slipmem-tour by default) and
//   must be inside the OS temp directory or scripts/tour/output;
// - generated notes, index, state, and media stay outside version control.
//
// Usage:
//   bun scenario.mjs prepare [--work-root <path>]
//   bun scenario.mjs propose [--base-url <url>] [--work-root <path>]
//   bun scenario.mjs setup   [--base-url <url>] [--work-root <path>]
//
// `prepare` resets the work root and seeds demo notes with the real CLI.
// `propose` needs a running slipmem server for the same work root. It submits
// one create_permanent_note proposal and verifies that no note file exists.
// `verify` checks the post-tour state: the approved note exists, the proposal
// queue is empty, and the flat repository invariants still hold.
// `setup` does prepare + propose (the server must already be running).

import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const here = fileURLToPath(new URL(".", import.meta.url))
const repoRoot = resolve(here, "../..")
const defaultWorkRoot = "/tmp/opencode/slipmem-tour"
const defaultBaseUrl = "http://127.0.0.1:3317"
const outputRoot = resolve(repoRoot, "scripts/tour/output")

const demoFleeting = {
  type: "fleeting",
  title: "Demo capture: question about agent memory",
  content:
    "Demo capture from a working session: should an agent recall permanent notes before raw conversation? Follow up later.",
  topics: ["inbox"],
}

const demoNotes = [
  demoFleeting,
  {
    type: "permanent",
    title: "Demo: Bounded recall keeps memory inspectable",
    content:
      "Demo note. Agent memory is recalled in bounded, cited slices. Recall results name the note ID and file that are their source instead of hiding a database row.",
    topics: ["agent-memory", "retrieval"],
  },
  {
    type: "permanent",
    title: "Demo: Permanent notes require human approval",
    content:
      "Demo note. An agent may capture fleeting and literature notes directly. Permanent knowledge is written only after a human reviews the proposed diff.",
    topics: ["agent-memory", "approval"],
  },
  {
    type: "literature",
    title: "Demo source: Local-first note systems",
    content:
      "Demo literature note. Local-first tools keep the source of truth in portable files and treat the search index as a rebuildable cache. Recall remains inspectable.",
    reference: "https://example.com/local-first-notes",
    topics: ["agent-memory", "local-first"],
  },
  {
    type: "permanent",
    title: "Demo: Markdown is the source of truth",
    content:
      "Demo note. Notes live as flat .md files under .slipmem/. The index is disposable, and recall can be rebuilt from the files at any time.",
    topics: ["agent-memory", "storage", "git"],
  },
]

const proposal = {
  title: "Demo proposal: Recall should cite its sources",
  content:
    "Demo proposal from an MCP client. Recall should always include the note ID and file path that support a result.",
  topics: ["agent-memory", "citations"],
}

const fail = (message) => {
  console.error(`scenario: ${message}`)
  process.exit(1)
}

const parseArgs = (argv) => {
  const [command, ...rest] = argv
  const options = {
    command,
    workRoot: process.env.TOUR_WORK_ROOT ?? defaultWorkRoot,
    baseUrl: process.env.TOUR_BASE_URL ?? defaultBaseUrl,
  }
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === "--work-root") {
      options.workRoot = requireValue(rest, ++index, "--work-root")
    } else if (arg.startsWith("--work-root=")) {
      options.workRoot = arg.slice("--work-root=".length)
    } else if (arg === "--base-url") {
      options.baseUrl = requireValue(rest, ++index, "--base-url")
    } else if (arg.startsWith("--base-url=")) {
      options.baseUrl = arg.slice("--base-url=".length)
    } else if (arg === "--help" || arg === "-h") {
      options.command = "help"
    } else {
      fail(`unknown option ${arg}`)
    }
  }
  return options
}

const requireValue = (argv, index, flag) => {
  const value = argv[index]
  if (value === undefined || value.startsWith("--")) {
    fail(`${flag} requires a value`)
  }
  return value
}

const isInside = (child, parent) => {
  const rel = relative(resolve(parent), resolve(child))
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep))
}

const assertDisposableRoot = (path) => {
  const resolved = resolve(path)
  if (
    resolved === "/" ||
    resolved === resolve(homedir()) ||
    resolved === resolve(repoRoot) ||
    resolved === resolve(here)
  ) {
    fail(`refusing to reset unsafe work root ${resolved}`)
  }
  const inTemp = isInside(resolved, tmpdir())
  const inTourOutput = isInside(resolved, outputRoot)
  if (!inTemp && !inTourOutput) {
    fail(
      `work root must be inside ${tmpdir()} or ${outputRoot}; got ${resolved}`,
    )
  }
  if (!basename(resolved).includes("slipmem-tour")) {
    fail(
      `work root basename must contain "slipmem-tour" so a typo cannot delete another temp directory; got ${resolved}`,
    )
  }
  return resolved
}

const scenarioPaths = (workRoot) => {
  const root = assertDisposableRoot(workRoot)
  return {
    workRoot: root,
    noteRoot: join(root, ".slipmem"),
    home: join(root, "home"),
    cache: join(root, "cache"),
    state: join(root, "state"),
    data: join(root, "data"),
    config: join(root, "config"),
    manifest: join(root, "scenario.json"),
  }
}

const isolatedEnv = (paths) => {
  const env = {
    ...process.env,
    HOME: paths.home,
    XDG_CACHE_HOME: paths.cache,
    XDG_STATE_HOME: paths.state,
    XDG_DATA_HOME: paths.data,
    XDG_CONFIG_HOME: paths.config,
    SLIPMEM_DIR: paths.noteRoot,
  }
  delete env.SLIPMEM_DB_PATH
  return env
}

const prepareDirectories = (paths) => {
  for (const directory of [
    paths.home,
    paths.cache,
    paths.state,
    paths.data,
    paths.config,
  ]) {
    mkdirSync(directory, { recursive: true })
  }
}

const runCli = (paths, args) => {
  try {
    return execFileSync("bun", ["run", "slipmem", "--", ...args], {
      cwd: repoRoot,
      env: isolatedEnv(paths),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (error) {
    const stderr = error.stderr?.toString() ?? ""
    const stdout = error.stdout?.toString() ?? ""
    fail(
      `slipmem ${args.join(" ")} failed\n${stdout}${stderr}`.trim(),
    )
  }
}

const noteFilenamePattern = /^\d{14}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/

const frontmatterTitle = (frontmatter) => {
  const line = frontmatter
    .split("\n")
    .find((candidate) => candidate.startsWith("title:"))
  if (line === undefined) {
    return undefined
  }
  const raw = line.slice("title:".length).trim()
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return JSON.parse(raw)
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replaceAll("''", "'")
  }
  return raw
}

const readNoteFiles = (noteRoot) =>
  readdirSync(noteRoot)
    .filter((name) => noteFilenamePattern.test(name))
    .sort()
    .map((name) => {
      const path = join(noteRoot, name)
      const text = readFileSync(path, "utf8")
      const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
      if (frontmatter === null) {
        fail(`seeded note ${path} has no frontmatter`)
      }
      return {
        id: name.slice(0, -".md".length),
        path,
        text,
        frontmatter: frontmatter[1],
        body: frontmatter[2],
      }
    })

const assertSeededRepository = (paths) => {
  if (!existsSync(paths.noteRoot)) {
    fail(`the CLI did not create ${paths.noteRoot}`)
  }
  const files = readNoteFiles(paths.noteRoot)
  if (files.length !== demoNotes.length) {
    fail(
      `expected ${demoNotes.length} seeded notes, found ${files.length} in ${paths.noteRoot}`,
    )
  }
  const directoryEntries = readdirSync(paths.noteRoot, {
    withFileTypes: true,
  }).filter((entry) => entry.isDirectory())
  if (directoryEntries.some((entry) => entry.name !== ".state")) {
    fail(
      `unexpected note-root directories: ${directoryEntries
        .map((entry) => entry.name)
        .join(", ")}`,
    )
  }
  for (const file of files) {
    if (!/provenance:\n\s+source: cli/.test(file.frontmatter)) {
      fail(`seeded note ${file.path} does not carry CLI provenance`)
    }
    if (!file.body.trim()) {
      fail(`seeded note ${file.path} has an empty body`)
    }
  }
  const approved = files.find((file) =>
    file.text.includes(proposal.title),
  )
  if (approved !== undefined) {
    fail(`proposal title already exists as a note: ${approved.path}`)
  }
  return files
}

const prepare = (paths) => {
  rmSync(paths.workRoot, { recursive: true, force: true })
  prepareDirectories(paths)

  runCli(paths, ["init"])
  for (const note of demoNotes) {
    const args = [
      "new",
      "--type",
      note.type,
      "--title",
      note.title,
      "--content",
      note.content,
      "--topics",
      note.topics.join(","),
    ]
    if (note.type === "literature") {
      args.push("--reference", note.reference)
    }
    runCli(paths, args)
  }

  const files = assertSeededRepository(paths)
  const manifest = {
    kind: "slipmem-product-tour-scenario",
    generatedAt: new Date().toISOString(),
    workRoot: paths.workRoot,
    noteRoot: paths.noteRoot,
    env: {
      HOME: paths.home,
      XDG_CACHE_HOME: paths.cache,
      XDG_STATE_HOME: paths.state,
      XDG_DATA_HOME: paths.data,
      XDG_CONFIG_HOME: paths.config,
      SLIPMEM_DIR: paths.noteRoot,
    },
    notes: demoNotes.map((note) => {
      const file = files.find(
        (candidate) => frontmatterTitle(candidate.frontmatter) === note.title,
      )
      return {
        type: note.type,
        title: note.title,
        id: file?.id ?? null,
        path: file?.path ?? null,
      }
    }),
    proposal: { status: "not_submitted" },
  }
  writeManifest(paths, manifest)
  console.log(
    `scenario: seeded ${files.length} demo notes in ${paths.noteRoot}`,
  )
  return manifest
}

const writeManifest = (paths, manifest) => {
  writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`)
}

const readManifest = (paths) => {
  if (!existsSync(paths.manifest)) {
    fail(`missing ${paths.manifest}; run "bun scenario.mjs prepare" first`)
  }
  return JSON.parse(readFileSync(paths.manifest, "utf8"))
}

const parseMcpBody = (text, contentType) => {
  if (contentType?.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter(Boolean)
    return JSON.parse(data[data.length - 1])
  }
  return JSON.parse(text)
}

const mcpCall = async (baseUrl, sessionId, id, name, args) => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  })
  const text = await response.text()
  if (!response.ok) {
    fail(`MCP ${name} returned HTTP ${response.status}: ${text.slice(0, 500)}`)
  }
  const json = parseMcpBody(text, response.headers.get("content-type"))
  if (json.result === undefined) {
    fail(`MCP ${name} returned no result: ${text.slice(0, 500)}`)
  }
  const structured =
    json.result.structuredContent ??
    (json.result.content?.[0]?.text
      ? JSON.parse(json.result.content[0].text)
      : undefined)
  return { json, structured }
}

const propose = async (paths, baseUrl) => {
  const manifest = readManifest(paths)
  if (resolve(manifest.noteRoot) !== resolve(paths.noteRoot)) {
    fail(
      `manifest note root ${manifest.noteRoot} does not match ${paths.noteRoot}`,
    )
  }

  const healthResponse = await fetch(`${baseUrl}/api/health`)
  if (!healthResponse.ok) {
    fail(`server is not healthy at ${baseUrl}/api/health`)
  }
  const health = await healthResponse.json()
  if (resolve(health.noteRoot) !== resolve(paths.noteRoot)) {
    fail(
      `server note root ${health.noteRoot} does not match the seeded root ${paths.noteRoot}; start the server with SLIPMEM_DIR=${paths.noteRoot}`,
    )
  }

  const initResponse = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "slipmem-tour-scenario", version: "1.0" },
      },
    }),
  })
  if (!initResponse.ok) {
    fail(
      `MCP initialize returned HTTP ${initResponse.status}: ${(
        await initResponse.text()
      ).slice(0, 500)}`,
    )
  }
  const sessionId = initResponse.headers.get("mcp-session-id")
  if (!sessionId) {
    fail("MCP initialize did not return mcp-session-id")
  }

  const result = await mcpCall(
    baseUrl,
    sessionId,
    2,
    "create_permanent_note",
    proposal,
  )
  if (result.structured?.status !== "pending_approval") {
    fail(
      `expected pending_approval, got ${JSON.stringify(result.structured)}`,
    )
  }
  const proposalId = result.structured.proposalId
  if (typeof proposalId !== "string" || proposalId.length === 0) {
    fail("pending proposal did not include a proposalId")
  }

  const fileAfterProposal = readNoteFiles(paths.noteRoot).find((file) =>
    file.text.includes(proposal.title),
  )
  if (fileAfterProposal !== undefined) {
    fail(
      `MCP permanent proposal wrote a note file before approval: ${fileAfterProposal.path}`,
    )
  }

  const pendingResponse = await fetch(`${baseUrl}/api/pending`)
  if (!pendingResponse.ok) {
    fail(`GET /api/pending returned ${pendingResponse.status}`)
  }
  const pending = await pendingResponse.json()
  const saved = pending.proposals?.find(
    (candidate) => candidate.id === proposalId,
  )
  if (saved === undefined) {
    fail(`proposal ${proposalId} is missing from /api/pending`)
  }
  if (saved.stale || saved.expired) {
    fail(`proposal ${proposalId} is stale or expired before recording`)
  }
  if (!saved.diff?.includes("+---") || !saved.diff.includes("source: mcp")) {
    fail("pending diff is missing created frontmatter or MCP provenance")
  }
  if (!saved.summary?.includes(proposal.title)) {
    fail(`pending summary does not mention ${proposal.title}`)
  }

  manifest.proposal = {
    status: "pending_approval",
    id: proposalId,
    summary: saved.summary,
    path: saved.path,
  }
  writeManifest(paths, manifest)
  console.log(
    `scenario: submitted MCP permanent proposal ${proposalId} (no note file written)`,
  )
  return manifest
}

const verify = (paths) => {
  const manifest = readManifest(paths)
  if (manifest.proposal?.status !== "pending_approval") {
    fail("manifest does not describe a pending proposal")
  }
  if (!existsSync(paths.noteRoot)) {
    fail(`missing note root ${paths.noteRoot}`)
  }
  const files = readNoteFiles(paths.noteRoot)
  if (files.length !== demoNotes.length + 1) {
    fail(
      `expected ${demoNotes.length + 1} notes after approval, found ${files.length}`,
    )
  }
  const approved = files.find((file) => file.text.includes(proposal.title))
  if (approved === undefined) {
    fail(`approved note for "${proposal.title}" is missing`)
  }
  if (!/provenance:\n\s+source: mcp/.test(approved.frontmatter)) {
    fail(`approved note ${approved.path} does not carry MCP provenance`)
  }
  if (!approved.text.includes('type: permanent')) {
    fail(`approved note ${approved.path} is not permanent`)
  }

  const pendingDirectory = join(paths.noteRoot, ".state", "pending")
  if (existsSync(pendingDirectory)) {
    const remaining = readdirSync(pendingDirectory).filter((name) =>
      name.endsWith(".json"),
    )
    if (remaining.length !== 0) {
      fail(
        `proposal queue is not empty after approval: ${remaining.join(", ")}`,
      )
    }
  }

  const directoryEntries = readdirSync(paths.noteRoot, {
    withFileTypes: true,
  }).filter((entry) => entry.isDirectory())
  if (directoryEntries.some((entry) => entry.name !== ".state")) {
    fail(
      `unexpected note-root directories: ${directoryEntries
        .map((entry) => entry.name)
        .join(", ")}`,
    )
  }

  console.log(
    `scenario: verified ${files.length} flat notes, MCP approval applied, no pending proposals`,
  )
  return manifest
}

const printHelp = () => {
  console.log(
    [
      "usage: bun scenario.mjs <prepare|propose|verify|setup> [options]",
      "",
      `  --work-root <path>  disposable root (default ${defaultWorkRoot})`,
      `  --base-url <url>    running server (default ${defaultBaseUrl})`,
      "",
      "prepare  reset the work root, seed demo notes with the real CLI",
      "propose  submit one create_permanent_note through HTTP MCP",
      "verify   check the approved note and flat-repository invariants",
      "setup    prepare + propose (the server must already be running)",
    ].join("\n"),
  )
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === "help" || options.command === undefined) {
    printHelp()
    return
  }
  const paths = scenarioPaths(options.workRoot)

  if (options.command === "prepare") {
    prepare(paths)
    return
  }
  if (options.command === "propose") {
    await propose(paths, options.baseUrl)
    return
  }
  if (options.command === "verify") {
    verify(paths)
    return
  }
  if (options.command === "setup") {
    prepare(paths)
    await propose(paths, options.baseUrl)
    return
  }
  fail(`unknown command ${options.command}`)
}

await main()
