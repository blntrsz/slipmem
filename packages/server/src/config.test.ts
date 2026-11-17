import { expect, test } from "bun:test"
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  isLoopbackHost,
  nonLoopbackWarning,
  resolveBindConfig,
} from "./config"

test("binds to loopback by default", () => {
  const config = resolveBindConfig({})
  expect(config).toEqual({
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    loopback: true,
  })
})

test("recognizes loopback host spellings", () => {
  for (const host of ["127.0.0.1", "::1", "[::1]", "localhost", " LOCALHOST "]) {
    expect(isLoopbackHost(host)).toBe(true)
  }
  for (const host of ["0.0.0.0", "::", "192.168.1.20", "notes.example"]) {
    expect(isLoopbackHost(host)).toBe(false)
  }
})

test("a non-loopback bind is explicit and carries the security warning", () => {
  const config = resolveBindConfig({ HOST: "0.0.0.0", PORT: "4321" })
  expect(config).toEqual({ host: "0.0.0.0", port: 4321, loopback: false })
  expect(nonLoopbackWarning(config.host)).toContain("no authentication")
  expect(nonLoopbackWarning(config.host)).toContain("plaintext")
})

test("rejects an invalid port", () => {
  expect(() => resolveBindConfig({ PORT: "not-a-port" })).toThrow()
  expect(() => resolveBindConfig({ PORT: "70000" })).toThrow()
})
