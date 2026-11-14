import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

interface BuildManifest {
  readonly client: string
  readonly server: string
  readonly serverEntry: string
}

const manifestPath = resolve(process.cwd(), "dist/server/foldkit.build.json")
const manifestFile = Bun.file(manifestPath)

if (!(await manifestFile.exists())) {
  console.error(`Missing ${manifestPath}. Run \"bun run build\" first.`)
  process.exit(1)
}

const manifest = (await manifestFile.json()) as BuildManifest
const clientDirectory = resolve(process.cwd(), manifest.client)
const serverDirectory = dirname(manifestPath)
const fetchHandlerPath = resolve(serverDirectory, manifest.serverEntry)
const serverModule = (await import(pathToFileURL(fetchHandlerPath).href)) as {
  readonly default: { readonly fetch: (request: Request) => Promise<Response> }
}

const port = Number(process.env.PORT ?? 3000)
// The API and MCP endpoint have no authentication. Bind to loopback by
// default so a local notebook is not writable by every host on the network.
// Set HOST=0.0.0.0 explicitly to expose it.
const hostname = process.env.HOST ?? "127.0.0.1"

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
  hostname,
  async fetch(request) {
    const staticFile = await staticResponse(request)
    if (staticFile !== undefined) {
      return staticFile
    }
    return serverModule.default.fetch(request)
  },
})

console.log(`slipmem web listening on http://${hostname}:${server.port}`)
