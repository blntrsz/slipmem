import { spawnSync } from "node:child_process"
import { isAbsolute, resolve } from "node:path"
import { isPathInside } from "../markdown/root.js"

export const SANDBOX_PROBE_TIMEOUT_MS = 2_000
export const SANDBOX_SAFE_PATH = "/usr/local/bin:/usr/bin:/bin"
/** The only inherited environment keys a synthesis process may receive. */
export const SANDBOX_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
] as const

export interface AgentSandbox {
  readonly kind: "bubblewrap"
  readonly command: string
}

/**
 * Returns the smallest environment a synthesizer needs. In particular, API
 * keys, tokens, and other unrelated process secrets are never inherited by the
 * configured agent, sandboxed or not.
 */
export const agentEnvironment = (
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const key of SANDBOX_ENV_KEYS) {
    const value = source[key]
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}

const probeArgs: ReadonlyArray<string> = [
  "--unshare-all",
  "--die-with-parent",
  "--ro-bind",
  "/",
  "/",
  "--",
  "/bin/true",
]

/**
 * Probes bubblewrap rather than checking that the binary exists. Containers
 * often ship `bwrap` without permitting user namespaces; treating a present
 * binary as a working sandbox would be a false security claim.
 */
export const detectAgentSandbox = (): AgentSandbox | null => {
  try {
    const result = spawnSync("bwrap", [...probeArgs], {
      timeout: SANDBOX_PROBE_TIMEOUT_MS,
      stdio: "ignore",
      env: agentEnvironment(),
    })
    return result.error === undefined && result.status === 0
      ? { kind: "bubblewrap", command: "bwrap" }
      : null
  } catch {
    return null
  }
}

export interface SandboxInvocationInput {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string
  /** Paths hidden from the process, normally the note root. */
  readonly hidePaths?: ReadonlyArray<string>
}

/**
 * Builds the bubblewrap argv: no network, no new privileges (via user
 * namespaces), a read-only root, writable only in a fresh /tmp, a cleared
 * environment, and the note root hidden when it does not contain the
 * executable. The process still reads other world-readable files; this is
 * isolation from writes, the network, and accidental secret inheritance, not a
 * complete confidentiality boundary.
 */
export const bubblewrapArgs = (
  input: SandboxInvocationInput,
): ReadonlyArray<string> => {
  const cwd = input.cwd ?? "/tmp"
  const absoluteCommand = isAbsolute(input.command)
    ? resolve(input.command)
    : null
  const hidden = (input.hidePaths ?? []).filter(
    (path) =>
      path.length > 0 &&
      path !== "/" &&
      (absoluteCommand === null || !isPathInside(absoluteCommand, path)),
  )

  return [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--ro-bind",
    "/",
    "/",
    "--tmpfs",
    "/tmp",
    ...hidden.flatMap((path) => ["--tmpfs", path]),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--chdir",
    cwd,
    "--setenv",
    "PATH",
    SANDBOX_SAFE_PATH,
    "--setenv",
    "HOME",
    "/tmp",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--",
    input.command,
    ...input.args,
  ]
}
