import {isAbsolute,resolve,join} from 'node:path';
import {loadRuntimePlugins} from './host.mjs';
import {createHandsPluginSource} from './hands-source.mjs';

/** Explicit platform-owned executor. Never called by the Hands environment bootstrap. */
export function startPluginExecutor(options) {
  return loadRuntimePlugins({...options,role:'execution'});
}
export async function main(args=process.argv.slice(2),env=process.env) {
  if(args.length!==1||!isAbsolute(args[0])||resolve(args[0])==='/')throw Error('Usage: runtime-plugin-executor ABSOLUTE_SELECTION_STORE');
  const directory=resolve(args[0]),keys=['OPENCRAFT_RUNTIME_PLUGIN_VFS_DIRECTORY','OPENCRAFT_RUNTIME_PLUGIN_VFS_ENDPOINT','OPENCRAFT_RUNTIME_PLUGIN_VFS_TOKEN_FILE'];
  const configured=keys.filter(key=>env[key]!==undefined);
  if(configured.length&&configured.length!==keys.length)throw Error('Configure all plugin VFS source fields');
  const host=await startPluginExecutor({directory,cacheDirectory:env.OPENCRAFT_RUNTIME_PLUGIN_CACHE_DIRECTORY??join(directory,'executor-cache'),
    ...(configured.length?{packageSource:()=>createHandsPluginSource({root:env[keys[0]],endpoint:env[keys[1]],tokenFile:env[keys[2]]})}:{})});
  const keepalive=setInterval(()=>{},60_000);
  let stopped;
  const stop=()=>stopped??=(async()=>{try{await host.close();}finally{clearInterval(keepalive);}})();
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void stop());
  console.log(JSON.stringify({type:'runtime-plugin-executor-ready',selected:host.selected,skipped:host.skipped.length}));
  return {host,close:stop};
}
