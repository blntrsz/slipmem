import {
  defaultBackupDirectory,
  defaultIndexCacheDirectory,
  makeMarkdownNoteRepository,
  resolveNoteRoot,
  type MarkdownError,
  type MarkdownNoteRepositoryShape,
  type MarkdownSearchIndexConfig,
  type NoteRootResolution,
} from "@slipmem/core"
import { Effect } from "effect"
import { processIo, type CliIo } from "./output.js"

export interface CliContext {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly io: CliIo
  readonly now: () => number
  /**
   * The real process stdin. Tests inject a deterministic reader; interactive
   * editor/confirmation decisions are still driven by the TTY flag.
   */
  readonly stdinIsTTY: boolean
  readonly readStdin: () => Promise<string>
  readonly openEditor: (path: string) => Promise<number>
}

const readProcessStdin = async (): Promise<string> => {
  const chunks: string[] = []
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    if (value !== undefined) {
      chunks.push(decoder.decode(value, { stream: true }))
    }
  }
  chunks.push(decoder.decode())
  return chunks.join("")
}

const editorCommand = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  for (const name of ["SLIPMEM_EDITOR", "VISUAL", "EDITOR"] as const) {
    const value = env[name]?.trim()
    if (value !== undefined && value.length > 0) {
      return value
    }
  }
  return undefined
}

export const hasEditor = (
  env: Readonly<Record<string, string | undefined>>,
): boolean => editorCommand(env) !== undefined

export const openProcessEditor = async (
  path: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> => {
  const command = editorCommand(env)
  if (command === undefined) {
    return -1
  }
  const shell = env.SHELL?.trim() || "/bin/sh"
  const result = Bun.spawnSync({
    cmd: [shell, "-c", `${command} "$1"`, "slipmem-editor", path],
    stdio: ["inherit", "inherit", "inherit"],
  })
  return result.exitCode ?? 1
}

export const systemContext = (): CliContext => ({
  cwd: process.cwd(),
  env: process.env,
  io: processIo,
  now: Date.now,
  stdinIsTTY: process.stdin.isTTY === true,
  readStdin: readProcessStdin,
  openEditor: (path) => openProcessEditor(path, process.env),
})

/** `--dir` behaves exactly like `SLIPMEM_DIR` for one invocation. */
export const resolveRoot = (
  context: CliContext,
  dir: string | undefined,
  init = false,
): Effect.Effect<NoteRootResolution, MarkdownError> => {
  const env =
    dir === undefined ? context.env : { ...context.env, SLIPMEM_DIR: dir }
  return resolveNoteRoot({
    cwd: context.cwd,
    env,
    ...(init ? { init: true } : {}),
  })
}

/** Opens the Markdown repository with CLI provenance and an injectable clock. */
export const openRepository = (
  context: CliContext,
  root: string,
): Effect.Effect<MarkdownNoteRepositoryShape, MarkdownError> =>
  makeMarkdownNoteRepository({
    root,
    now: context.now,
    backupDir: defaultBackupDirectory(root, context.env),
  })

/** The disposable index always lives outside the note root. */
export const indexConfig = (
  context: CliContext,
  root: string,
): MarkdownSearchIndexConfig => ({
  root,
  cacheDir: defaultIndexCacheDirectory(root, context.env),
})
