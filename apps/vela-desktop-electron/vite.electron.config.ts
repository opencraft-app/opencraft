import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    target: "node22",
    outDir: "dist-electron",
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(appRoot, "electron/main.ts"),
        preload: resolve(appRoot, "electron/preload.ts"),
      },
      external: (id) => id === "electron" || id.startsWith("node:"),
      output: {
        entryFileNames: "[name].js",
        format: "es",
      },
    },
  },
});
