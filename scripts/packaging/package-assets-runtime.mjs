import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
/** Place beside a bundled importer of @opencraft/plugin-assets/server. */
export async function buildAssetsRuntime(directory) {
  await build({
    entryPoints: [
      fileURLToPath(new URL("../../plugins/assets/src/server/assets-configuration.worker.ts", import.meta.url)),
    ],
    outfile: join(directory, "assets-configuration-worker.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    logLevel: "warning",
    banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
  });
}
