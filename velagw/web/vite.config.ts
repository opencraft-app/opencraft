import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:18080",
      "/console": "http://localhost:18080",
      "/console-sw.js": "http://localhost:18080",
      "/_llmgateway_console": "http://localhost:18080",
      "/v1": "http://localhost:18082",
    },
  },
})
