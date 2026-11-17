import { usageError } from "./errors.js"

export interface AgentCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

/**
 * Splits a local synthesizer command into an executable and an argv array.
 *
 * This is deliberately not a shell: there is no expansion, globbing,
 * substitution, or command chaining. Whitespace separates tokens, single and
 * double quotes group a token, and a backslash escapes the next character
 * outside single quotes. The result is passed to `spawn` with `shell: false`, so
 * an injected note body can never become shell syntax.
 */
export const parseAgentCommand = (raw: string): AgentCommand => {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null
  let escaped = false
  let started = false

  const push = (): void => {
    if (started) {
      tokens.push(current)
      current = ""
      started = false
    }
  }

  for (const character of raw) {
    if (escaped) {
      current += character
      started = true
      escaped = false
      continue
    }

    if (quote === "'") {
      if (character === "'") {
        quote = null
      } else {
        current += character
      }
      started = true
      continue
    }

    if (quote === '"') {
      if (character === '"') {
        quote = null
      } else if (character === "\\") {
        escaped = true
      } else {
        current += character
      }
      started = true
      continue
    }

    if (character === "'" || character === '"') {
      quote = character
      started = true
      continue
    }
    if (character === "\\") {
      escaped = true
      started = true
      continue
    }
    if (/\s/.test(character)) {
      push()
      continue
    }
    current += character
    started = true
  }

  if (quote !== null) {
    throw usageError(
      "--agent has an unterminated quote. Quote the whole argument value and use --agent-arg for arguments that are hard to quote.",
      "wiki",
    )
  }
  if (escaped) {
    throw usageError(
      "--agent ends with an unescaped backslash. Add another backslash or use --agent-arg.",
      "wiki",
    )
  }

  push()
  const [command, ...args] = tokens
  if (command === undefined || command.trim() === "") {
    throw usageError(
      "--agent requires a non-empty executable, for example --agent '/usr/local/bin/my-synthesizer --flag'.",
      "wiki",
    )
  }
  return { command, args }
}
