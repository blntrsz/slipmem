#!/usr/bin/env bun
import { runCli } from "./cli.js"
import { systemContext } from "./context.js"

const exitCode = await runCli(process.argv.slice(2), systemContext())
process.exitCode = exitCode
