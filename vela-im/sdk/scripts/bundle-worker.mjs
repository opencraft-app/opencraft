// Single-file Agent worker for runtimes that only ship a script (Hermes plugin, Python SDK).
import {build} from 'esbuild';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));
const out=join(here,'..','dist','vela-im-worker.mjs');
await build({
 entryPoints:[join(here,'..','dist','worker-cli.js')],outfile:out,bundle:true,platform:'node',format:'esm',target:'node22',
 banner:{js:"#!/usr/bin/env node\nimport {createRequire as __velaRequire} from 'node:module';const require=__velaRequire(import.meta.url);"},
 legalComments:'none',logLevel:'warning',
});
console.log('bundled',out);
