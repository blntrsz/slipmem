import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [foldkit()],
  server: {
    // `alchemy dev` publishes the API on 8080. The deployed API serves this
    // build from the same origin, so the client always calls `/api`.
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
  optimizeDeps: {
    include: ["effect", "effect/Function", "effect/http"],
  },
});
