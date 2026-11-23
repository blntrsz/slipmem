/**
 * Process signals that should interrupt the active Effect instead of killing
 * the CLI immediately. Interrupting the Effect lets scoped resources (notably
 * temporary editor drafts and wrapper children) release before exit.
 */
export const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

export type InterruptSignal = (typeof INTERRUPT_SIGNALS)[number]

/** Conventional shell exit status for a process interrupted by a signal. */
export const signalExitCode = (signal: AbortSignal): number => {
  switch (signal.reason) {
    case "SIGINT":
      return 130
    case "SIGTERM":
      return 143
    case "SIGHUP":
      return 129
    default:
      return 130
  }
}

/**
 * How long a child gets to handle SIGTERM before it is killed with SIGKILL.
 * The value is shared by editor drafts and wrapper servers so every interrupt
 * path has the same bounded shutdown.
 */
export const TERMINATION_GRACE_MS = 2_000

/** The subset of a Bun subprocess needed to terminate and reap it. */
export interface TerminableChild {
  readonly exited: Promise<number>
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | number | null
  kill(signal?: number | NodeJS.Signals): void
}

const isRunning = (child: TerminableChild): boolean =>
  child.exitCode === null && child.signalCode === null

const killQuietly = (
  child: TerminableChild,
  signal: NodeJS.Signals,
): void => {
  try {
    child.kill(signal)
  } catch {
    // The child already exited; there is nothing left to signal.
  }
}

/**
 * Resolves true when the child exits before `timeoutMs`. The timer is kept
 * referenced so an abandoned child cannot let the CLI exit before escalation.
 */
const exitedWithin = (
  child: TerminableChild,
  timeoutMs: number,
): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false
    const finish = (exited: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      resolve(exited)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.exited.then(
      () => {
        clearTimeout(timer)
        finish(true)
      },
      () => {
        clearTimeout(timer)
        finish(true)
      },
    )
  })

/**
 * Stops a child with a bounded escalation: SIGTERM first, SIGKILL after the
 * grace period, then a bounded wait for reaping. A child that traps or ignores
 * SIGTERM therefore cannot wedge the CLI or leave an orphaned process.
 */
export const terminateChild = async (
  child: TerminableChild,
  graceMs = TERMINATION_GRACE_MS,
): Promise<void> => {
  if (!isRunning(child)) {
    return
  }
  killQuietly(child, "SIGTERM")
  if (await exitedWithin(child, graceMs)) {
    return
  }
  killQuietly(child, "SIGKILL")
  await exitedWithin(child, graceMs)
}

/**
 * Aborts `controller` on the first interrupt signal. Each listener is installed
 * once, so a second signal falls back to the platform default and can terminate
 * a command that ignores the first one. The returned function removes any
 * listeners that have not fired.
 */
export const installSignalInterrupts = (
  controller: AbortController,
): (() => void) => {
  const removers = INTERRUPT_SIGNALS.map((signal) => {
    const handler = (): void => {
      controller.abort(signal)
    }
    process.once(signal, handler)
    return () => {
      process.off(signal, handler)
    }
  })
  return () => {
    for (const remove of removers) {
      remove()
    }
  }
}
