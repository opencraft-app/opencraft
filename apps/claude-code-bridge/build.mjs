import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/claude-code-bridge.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "eof",
  banner: { js: "#!/usr/bin/env node" },
  external: ["node:*"],
  logLevel: "info",
});
