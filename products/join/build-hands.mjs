import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { verifyWorkspaceBindings } from './build-workspace-guard.mjs';
import { buildHeadlessBundle } from '../../scripts/package-headless-linux.mjs';
import { packageBrowserRuntime } from '../../scripts/package-browser-runtime.mjs';
const product=dirname(fileURLToPath(import.meta.url)), root=resolve(product,'../..');
verifyWorkspaceBindings(root);
const output=resolve(process.argv[2]??join(product,'dist/hands')), runtime=join(output,'runtime');
if(!process.env.OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION)throw Error('Hands build requires the verified owned Electron distribution');
await mkdir(runtime,{recursive:true});
// Use the same bundler, external native modules and sidecar rules as full packaging.
for(const [entry,name]of [['hands-execution-owner.mjs','hands-execution-owner.mjs'],['terminal.mjs','hands-terminal-owner.mjs'],['files.mjs','hands-files-owner.mjs'],['health.mjs','container-health.mjs']])
 await buildHeadlessBundle(join(runtime,name),{headlessEntry:join(root,'scripts/container-deployment',entry)});
for(const [entry,name]of [[join(product,'hands.mjs'),'native-hands.mjs'],[join(root,'scripts/container-deployment/service.mjs'),'container-service.mjs']])
 await build({entryPoints:[entry],outfile:join(runtime,name),bundle:true,platform:'node',format:'esm',target:'node26',banner:{js:"import {createRequire as __createRequire}from'node:module';const require=__createRequire(import.meta.url);"}});
// Never silently use a stock Electron for a partial update of an owned browser.
await packageBrowserRuntime(join(runtime,'browser'));
for(const name of ['native-hands.mjs','hands-execution-owner.mjs','hands-terminal-owner.mjs','hands-files-owner.mjs','container-health.mjs','personal-git-worker.mjs','git-identity-wrapper.mjs','browser/owner.cjs','browser/worker.cjs']){
 const result=spawnSync(process.execPath,['--check',join(runtime,name)],{stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)throw Error('Invalid Hands runtime: '+name);
}
console.log(JSON.stringify({ok:true,output,contract:'root-execution-nonroot-browser-git-v2'}));
