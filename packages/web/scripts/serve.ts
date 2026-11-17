import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { nonLoopbackWarning, resolveBindConfig } from "@slipmem/server"

interface BuildManifest {
  readonly client: string
  readonly server: string
  readonly serverEntry: string
}

const manifestPath = resolve(process.cwd(), "dist/server/foldkit.build.json")
const manifestFile = Bun.file(manifestPath)

if (!(await manifestFile.exists())) {
  console.error(`Missing ${manifestPath}. Run "bun run build" first.`)
  process.exit(1)
}

const manifest = (await manifestFile.json()) as BuildManifest
const clientDirectory = resolve(process.cwd(), manifest.client)
const serverDirectory = dirname(manifestPath)
const fetchHandlerPath = resolve(serverDirectory, manifest.serverEntry)
const serverModule = (await import(pathToFileURL(fetchHandlerPath).href)) as {
  readonly default: { readonly fetch: (request: Request) => Promise<Response> }
}

// Loopback is the default because the API and MCP endpoint have no
// authentication and note files are plaintext. Setting HOST is an explicit,
// documented decision to expose them to the network.
const { host, port, loopback } = resolveBindConfig()

if (!loopback) {
  console.error(nonLoopbackWarning(host))
}

const staticResponse = async (request: Request): Promise<Response | undefined> => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return undefined
  }

  const pathname = decodeURIComponent(new URL(request.url).pathname)
  if (pathname === "/" || pathname.endsWith("/index.html")) {
    return undefined
  }

  const filePath = resolve(clientDirectory, `.${pathname}`)
  if (!filePath.startsWith(`${clientDirectory}/`)) {
    return undefined
  }

  const file = Bun.file(filePath)
  if (!(await file.exists())) {
    return undefined
  }

  return new Response(file)
}

const server = Bun.serve({
  port,
  hostname: host,
  async fetch(request) {
    const staticFile = await staticResponse(request)
    if (staticFile !== undefined) {
      return staticFile
    }
    return serverModule.default.fetch(request)
  },
})

console.log(`slipmem web listening on http://${host}:${server.port}`)
