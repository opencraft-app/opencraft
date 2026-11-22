import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
/** Place beside a bundled importer of @opencraft/plugin-assets/server. */
export async function buildAssetsRuntime(directory,{headless=false}={}) {
  const entries=[['../../plugins/assets/src/server/assets-configuration.worker.ts','assets-configuration-worker.mjs'],
    ...(headless?[['../../apps/headless-server/src/assets-runtime.worker.ts','assets-runtime-worker.mjs']]:[])];
  for(const [entry,name]of entries)await build({
    entryPoints: [
      fileURLToPath(new URL(entry, import.meta.url)),
    ],
    outfile: join(directory, name),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    logLevel: "warning",
    banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
  });
}
