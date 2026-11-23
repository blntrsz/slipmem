import { expect, test } from "bun:test"
import { resolve } from "node:path"

import { staticAssetPath } from "./static"

const clientDirectory = resolve("/tmp/slipmem-client")

test("built assets resolve below the client directory", () => {
  expect(
    staticAssetPath(clientDirectory, "http://localhost/assets/app.js"),
  ).toBe(resolve(clientDirectory, "assets/app.js"))
  expect(
    staticAssetPath(clientDirectory, "http://localhost/assets/app%20one.js"),
  ).toBe(resolve(clientDirectory, "assets/app one.js"))
})

test("malformed static URLs fail closed instead of throwing", () => {
  expect(
    staticAssetPath(clientDirectory, "http://localhost/%E0%A4%A"),
  ).toBeUndefined()
  expect(
    staticAssetPath(clientDirectory, "http://localhost/%00secret"),
  ).toBeUndefined()
})

test("static traversal and index requests fall through to the application", () => {
  expect(
    staticAssetPath(clientDirectory, "http://localhost/assets/..%2f..%2fsecret.txt"),
  ).toBeUndefined()
  expect(
    staticAssetPath(clientDirectory, "http://localhost/..%2fsecret.txt"),
  ).toBeUndefined()
  expect(
    staticAssetPath(clientDirectory, "http://localhost/index.html"),
  ).toBeUndefined()
  expect(staticAssetPath(clientDirectory, "http://localhost/")).toBeUndefined()
})
