import { foldkit } from "@foldkit/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

import { nonLoopbackWarning, resolveBindConfig } from "@slipmem/server"

const { host, port, loopback } = resolveBindConfig()

if (!loopback) {
  console.error(nonLoopbackWarning(host))
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
