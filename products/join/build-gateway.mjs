import {verifyWorkspaceBindings} from './build-workspace-guard.mjs';
import {spawnSync} from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { buildHeadlessBundle } from '../../scripts/package-headless-linux.mjs';
const product = dirname(fileURLToPath(import.meta.url));
verifyWorkspaceBindings(resolve(product,'../..'));
const output = resolve(process.argv[2] ?? resolve(product, 'dist/runtime/container-gateway.mjs'));
await mkdir(dirname(output), { recursive: true });
await buildHeadlessBundle(output, { headlessEntry: resolve(product, 'gateway.mjs'), assistantEntry:resolve(product,'plugins/wecom/assistant-server.mjs') });
await build({entryPoints:[resolve(product,'plugins/wecom/assistant-extension.mjs')],outfile:resolve(dirname(output),'assistant-extension.mjs'),bundle:true,platform:'node',format:'esm',target:'node26'});
// Generic platform tools are separate entrypoints, never Hands bootstrap services.
for(const [entry,name] of [['executor-cli.mjs','runtime-plugin-executor.mjs'],['cli.mjs','runtime-plugin-admin.mjs']])await build({
  entryPoints:[resolve(product,'runtime-plugins',entry)],outfile:resolve(dirname(output),name),bundle:true,
  platform:'node',format:'esm',target:'node26',
  banner:{js:"import {createRequire as __pluginRequire} from 'node:module';const require=__pluginRequire(import.meta.url);"},
});
// esbuild does not parse its injected banner together with module declarations.
// Check the actual runtime entries, including the isolated personal-Git bridge,
// not just successful emission of the main bundle.
for(const file of [output,...['assistant-server.mjs','assistant-extension.mjs','orchestration-runtime-worker.mjs','runtime-plugin-executor.mjs','runtime-plugin-admin.mjs','personal-git-worker.mjs','git-identity-wrapper.mjs'].map(name=>resolve(dirname(output),name))]) {
  const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error('Invalid generated runtime: '+file);
}
console.log(JSON.stringify({ ok: true, output }));
