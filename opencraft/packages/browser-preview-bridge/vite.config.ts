import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
    lib: {
      entry: fileURLToPath(new URL("./src/auto-install.ts", import.meta.url)),
      name: "OpenCraftPreviewBridgeRuntime",
      formats: ["iife"],
      fileName: () => "preview-bridge.js",
    },
  },
});
