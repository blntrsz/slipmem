import { describe, expect, test } from "bun:test"
import { parseAgentCommand } from "./agent-command.js"

describe("agent command argv parsing", () => {
  test("splits a command and keeps quoted arguments intact", () => {
    expect(
      parseAgentCommand(`/opt/agent --flag 'two words' "three words" plain`),
    ).toEqual({
      command: "/opt/agent",
      args: ["--flag", "two words", "three words", "plain"],
    })
  })

  test("never performs shell expansion or chaining", () => {
    expect(parseAgentCommand(`agent $(echo nope) ; rm -rf /`)).toEqual({
      command: "agent",
      args: ["$(echo", "nope)", ";", "rm", "-rf", "/"],
    })
  })

  test("supports escaped whitespace and rejects malformed input", () => {
    expect(parseAgentCommand(`agent one\\ two`).args).toEqual(["one two"])
    expect(() => parseAgentCommand(`agent "unterminated`)).toThrow(
      "unterminated quote",
    )
    expect(() => parseAgentCommand(`agent trailing\\`)).toThrow(
      "unescaped backslash",
    )
    expect(() => parseAgentCommand("   ")).toThrow("non-empty executable")
  })
})
