#!/usr/bin/env bun
import { systemContext } from "./context.js"
import { runInitiativeCli } from "./initiative-cli.js"

const exitCode = await runInitiativeCli(process.argv.slice(2), systemContext())
process.exitCode = exitCode
