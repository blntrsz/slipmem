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
import { terminateChild } from "./signals.js"

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
  /**
   * The signal aborts when the surrounding Effect is interrupted, so an editor
   * child is terminated instead of blocking cleanup or leaking the draft.
   */
  readonly openEditor: (path: string, signal?: AbortSignal) => Promise<number>
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

/**
 * Shell metacharacters that make an editor value a compound snippet rather
 * than a single command. Snippets keep the pre-`exec` shell behavior because
 * they cannot be replaced by a single process without losing their meaning.
 */
const SHELL_SNIPPET = /[;&|<>(){}\n`]|\$/

/** Leading `NAME=value` assignments, with quoted or bare values. */
const ASSIGNMENT_PREFIX =
  /^((?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"']+)\s+)+)([\s\S]+)$/

/**
 * Builds the `$SHELL -c` script used to open the editor. Simple commands use
 * `exec` so the tracked pid is the editor itself and forced termination reaches
 * it. Leading `NAME=value` assignments are preserved through `env`, which also
 * execs the editor. Compound snippets (pipes, `;`, substitutions) stay in the
 * shell; `exec` would be a syntax error for most of them.
 */
export const editorShellScript = (command: string): string => {
  if (SHELL_SNIPPET.test(command)) {
    return `${command} "$1"`
  }
  const assignments = ASSIGNMENT_PREFIX.exec(command)
  if (assignments !== null) {
    return `exec env ${assignments[1]}${assignments[2]} "$1"`
  }
  return `exec ${command} "$1"`
}

export const openProcessEditor = async (
  path: string,
  env: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<number> => {
  const command = editorCommand(env)
  if (command === undefined) {
    return -1
  }
  const shell = env.SHELL?.trim() || "/bin/sh"
  const child = Bun.spawn({
    cmd: [shell, "-c", editorShellScript(command), "slipmem-editor", path],
    stdio: ["inherit", "inherit", "inherit"],
  })
  let removeAbort: (() => void) | undefined
  const aborted =
    signal === undefined
      ? undefined
      : new Promise<number>((resolve) => {
          const onAbort = (): void => {
            const settle = (): void => {
              resolve(child.exitCode ?? 137)
            }
            void terminateChild(child).then(settle, settle)
          }
          if (signal.aborted) {
            onAbort()
            return
          }
          signal.addEventListener("abort", onAbort, { once: true })
          removeAbort = () => signal.removeEventListener("abort", onAbort)
        })
  try {
    return await (aborted === undefined
      ? child.exited
      : Promise.race([child.exited, aborted]))
  } finally {
    removeAbort?.()
  }
}

export const systemContext = (): CliContext => ({
  cwd: process.cwd(),
  env: process.env,
  io: processIo,
  now: Date.now,
  stdinIsTTY: process.stdin.isTTY === true,
  readStdin: readProcessStdin,
  openEditor: (path, signal) => openProcessEditor(path, process.env, signal),
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
