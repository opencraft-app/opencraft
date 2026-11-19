import {createHostFileSystem} from '../../../scripts/host-filesystem.ts';
import {createVfsPluginSource} from './source.mjs';

/** Current adapter. No plugin discovery, process creation or permissions changes in Hands. */
export function createHandsPluginSource({root,endpoint,tokenFile}) {
  const files=createHostFileSystem({endpoint,tokenFile});
  return createVfsPluginSource({root,close:()=>files.close(),async readFile(path,{signal,maxBytes}) {
    const value=await files.request('fs/readFile',{path},signal),encoded=value?.dataBase64;
    if(typeof encoded!=='string'||encoded.length>Math.ceil(maxBytes/3)*4)throw Error('Plugin VFS file exceeds budget');
    const bytes=Buffer.from(encoded,'base64');
    if(bytes.length>maxBytes||bytes.toString('base64')!==encoded)throw Error('Invalid plugin VFS bytes');
    return bytes;
  }});
}
