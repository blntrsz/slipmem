import { foldkit } from "@foldkit/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

// Keep this config dependency-free at load time: Vite evaluates it with the
// Node ESM loader, while the application source uses Bun-style extensionless
// workspace imports. The production server reuses @slipmem/server's resolver;
// this development host needs the same loopback default and warning.
const host = process.env.HOST?.trim() || "127.0.0.1"
const port = Number(process.env.PORT ?? 3000)
const loopback = ["127.0.0.1", "::1", "[::1]", "localhost"].includes(
  host.toLowerCase(),
)

if (!loopback) {
  console.error(
    `WARNING: slipmem is binding to non-loopback host ${host}. The HTTP API has no authentication and note files are plaintext; anyone who can reach this address may read or change every note. Bind 127.0.0.1 unless you explicitly accept that risk.`,
  )
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    foldkit({
      ssr: {
        serverEntry: "/src/entry.server.ts",
        clientEntry: "/src/entry.ts",
        build: true,
      },
    }),
  ],
  server: {
    host,
    port,
  },
})
