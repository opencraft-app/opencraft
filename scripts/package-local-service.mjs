import {createRequire} from 'node:module';
import {join} from 'node:path';
import {mkdir,cp,readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {copyDependencyClosure} from './full-release/closure.mjs';

export async function packageLocalService({repositoryRoot,packageRoot}) {
  const source=join(repositoryRoot,'runtime/dsh');
  const lock=JSON.parse(await readFile(join(source,'package-lock.json'),'utf8'));
  const pinned=JSON.parse(await readFile(join(source,'package.json'),'utf8')).dependencies['@deepseek-ai/dsh'];
  if(lock.packages['node_modules/@deepseek-ai/dsh']?.version!==pinned)throw new Error('Local service requires the pinned DSH runtime');
  const destination=join(packageRoot,'local-runtime/dsh');await mkdir(destination,{recursive:true});
  await copyDependencyClosure(join(destination,'node_modules'),['@deepseek-ai/dsh'],createRequire(join(source,'package.json')),source);
  for(const name of ['package.json','package-lock.json'])await cp(join(source,name),join(destination,name));
  await cp(join(repositoryRoot,'LICENSE'),join(packageRoot,'local-runtime/LICENSE'));
  const bridge=join(packageRoot,'runtime/codebuddy-ide');await mkdir(bridge,{recursive:true});
  const {build}=await import('esbuild');
  await build({entryPoints:[join(repositoryRoot,'scripts/codebuddy-ide/acp-proxy.mjs')],outfile:join(bridge,'acp-proxy.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});
  const buildOutput=join(packageRoot,'runtime/codebuddy-ide-build');
  await promisify(execFile)(process.execPath,[join(repositoryRoot,'scripts/build-codebuddy-ide-extension.mjs'),buildOutput],{cwd:repositoryRoot,timeout:120000,maxBuffer:65536});
  await cp(join(buildOutput,'opencraft-codebuddy-ide.vsix'),join(bridge,'bridge.vsix'));
  const {rm}=await import('node:fs/promises');await rm(buildOutput,{recursive:true,force:true});
  await writeFile(join(packageRoot,'local-runtime/profile.json'),JSON.stringify({schemaVersion:1,platform:process.platform,arch:process.arch,nodeAbi:process.versions.modules,dsh:pinned}));
}
