import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const veladProxyTarget = resolveVeladProxyTarget();

export default defineConfig({
  root: appRoot,
  base: "./",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api/v1": {
        target: veladProxyTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});

function resolveVeladProxyTarget() {
  const explicitTarget = process.env.VITE_VELA_PROXY_TARGET;
  if (explicitTarget) return explicitTarget;

  const apiBaseUrl = process.env.VITE_VELA_API_BASE_URL;
  if (apiBaseUrl?.startsWith("http://") || apiBaseUrl?.startsWith("https://")) {
    return new URL(apiBaseUrl).origin;
  }

  return "http://127.0.0.1:3857";
}
