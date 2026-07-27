import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@\//,
        replacement: `${path.resolve(rootDir, "./src")}/`,
      },
      {
        find: /^@next-site\//,
        replacement: `${path.resolve(rootDir, "./next-site")}/`,
      },
      {
        find: /^react-syntax-highlighter$/,
        replacement: path.resolve(rootDir, "src/vendor/react-syntax-highlighter-shim.ts"),
      },
      {
        find: /^@tencent\/universal-report$/,
        replacement: path.resolve(rootDir, "src/vendor/tencent-universal-report-shim.ts"),
      },
    ],
  },
  test: {
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "http://localhost/",
      },
    },
    setupFiles: "./src/test/setup.ts",
  },
});
