import { build } from "esbuild";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Pinned, self-contained ACP bridge artifact. Runtime worker files that are
 * located relative to `import.meta.url` must sit beside this bundle. */
const outfile = join("dist", "main.mjs");
await mkdir(dirname(outfile), { recursive: true });
await build({
  entryPoints: ["src/main.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["node:*"],
  legalComments: "eof",
  logLevel: "info",
});
for (const name of ["dsh-steering.mjs", "agy-trace.worker.mjs"]) {
  await copyFile(join("src", name), join("dist", name));
  await chmod(join("dist", name), 0o644);
}
await chmod(outfile, 0o755);
