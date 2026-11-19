import {resolve} from 'node:path';
import {lstat} from 'node:fs/promises';
import {installRuntimePlugin,inspectRuntimePlugins,boundedFile} from './store.mjs';
export async function main(args=process.argv.slice(2)) {
  if(args[0]==='check'&&args.length===2)return inspectRuntimePlugins(resolve(args[1]));
  const [operation,source,directory,...flags]=args;
  const values=new Set();
  if(operation!=='install'||!source||!directory||flags.some(flag=>{
    const key=flag.split('=')[0];if(values.has(key))return true;values.add(key);
    return flag!=='--enable'&&!/^--gid=[0-9]+$/u.test(flag)&&!/^--configuration-file=\/.+/u.test(flag);
  }))throw Error('Usage: runtime-plugin check STORE | install PACKAGE STORE [--enable] [--gid=NUMBER] [--configuration-file=ABSOLUTE_FILE]');
  const gid=flags.find(flag=>flag.startsWith('--gid=')),config=flags.find(flag=>flag.startsWith('--configuration-file='));
  let configuration;
  if(config){
    const file=config.slice('--configuration-file='.length),info=await lstat(file);
    if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||info.mode&0o077)throw Error('Installation configuration must be private');
    configuration=JSON.parse((await boundedFile(file,64*1024)).toString('utf8'));
  }
  return installRuntimePlugin(resolve(source),resolve(directory),{enable:flags.includes('--enable'),configuration,...(gid?{gid:Number(gid.slice(6))}:{})});
}
