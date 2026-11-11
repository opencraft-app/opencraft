import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const common = { bundle: true, platform: "node", format: "esm", target: "node22", external: ["@cursor/sdk"], legalComments: "eof" };
await build({ ...common, entryPoints: ["src/sdk-worker.ts"], outfile: "dist/sdk-worker.mjs" });
const digest = createHash("sha256").update(await readFile("dist/sdk-worker.mjs")).digest("hex");
await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/main.mjs", define: { CURSOR_WORKER_SHA256: JSON.stringify(digest) } });
