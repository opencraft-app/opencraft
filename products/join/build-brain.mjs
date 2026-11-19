import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { verifyWorkspaceBindings } from './build-workspace-guard.mjs';
import { buildHeadlessBundle } from '../../scripts/package-headless-linux.mjs';
const product=dirname(fileURLToPath(import.meta.url)), root=resolve(product,'../..');
verifyWorkspaceBindings(root);
const output=resolve(process.argv[2]??join(product,'dist/brain')), runtime=join(output,'runtime');
await mkdir(runtime,{recursive:true});
// Match full packaging: execution owners and their complete worker closure.
const headless=[['scripts/server-deployment/engine-host.mjs','engine-host.mjs'],
 ['scripts/server-deployment/dsh-host.mjs','dsh-host.mjs'],
 ['scripts/server-deployment/sandbox-command.mjs','sandbox-command.mjs'],
 ['scripts/container-deployment/health.mjs','container-health.mjs']];
for(const [entry,name]of headless)await buildHeadlessBundle(join(runtime,name),{headlessEntry:join(root,entry)});
const entries=[['apps/codex-core/src/bin.ts','codex-core.cjs','cjs'],
 ['apps/codex-core/src/app-server-bin.ts','codex-app-server.cjs','cjs'],
 ['scripts/container-deployment/host.mjs','native-host.mjs','esm'],
 ['scripts/container-deployment/service.mjs','container-service.mjs','esm']];
for(const [entry,name,format]of entries)await build({entryPoints:[join(root,entry)],outfile:join(runtime,name),
 bundle:true,platform:'node',format,target:'node26',
 ...(format==='esm'?{banner:{js:"import {createRequire as __createRequire}from'node:module';const require=__createRequire(import.meta.url);"}}:{})});
for(const name of [...headless.map(([,name])=>name),...entries.map(([,name])=>name),'personal-git-worker.mjs','git-identity-wrapper.mjs']){
 const result=spawnSync(process.execPath,['--check',join(runtime,name)],{stdio:'inherit'});
 if(result.error)throw result.error;if(result.status!==0)throw Error('Invalid Brain runtime: '+name);
}
// Native CLI/engine distributions and private data are not copied by this builder.
console.log(JSON.stringify({ok:true,output,contract:'personal-git-execution-v2'}));
