import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

export const repoRoot = resolve(import.meta.dir, "../../..")
export const cliEntry = join(repoRoot, "packages/cli/src/main.ts")

export interface CliProcessResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface CliProcessOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly stdin?: string
  /** Use the root `bun run slipmem --` script instead of the entrypoint. */
  readonly rootScript?: boolean
}

export const makeTempBase = (): string =>
  mkdtempSync(join(tmpdir(), "slipmem-cli-"))

export const runCliProcess = async (
  args: ReadonlyArray<string>,
  options: CliProcessOptions = {},
): Promise<CliProcessResult> => {
  const command =
    options.rootScript === true
      ? [process.execPath, "run", "slipmem", "--", ...args]
      : [process.execPath, cliEntry, ...args]
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries({
    ...process.env,
    ...options.env,
  })) {
    if (value !== undefined) {
      env[key] = value
    }
  }

  const processResult = Bun.spawn({
    cmd: command,
    cwd: options.cwd ?? repoRoot,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  if (options.stdin !== undefined) {
    processResult.stdin.write(options.stdin)
  }
  processResult.stdin.end()

  const [stdout, stderr, code] = await Promise.all([
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
    processResult.exited,
  ])

  return { code, stdout, stderr }
}

export const parseJson = <A = unknown>(text: string): A => {
  try {
    return JSON.parse(text) as A
  } catch (cause) {
    throw new Error(
      `Expected JSON output but received:\n${text}\n${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}
