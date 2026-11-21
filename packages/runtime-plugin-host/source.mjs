import {isAbsolute,join,dirname,resolve} from 'node:path';
import {mkdir,mkdtemp,writeFile,rename,rm,lstat} from 'node:fs/promises';
import {hash,parseManifest,verifyPackage} from './store.mjs';

/** VFS is a byte source, never an authority to enable code or select its revision. */
export function createVfsPluginSource({root,readFile,close=()=>{}}) {
  if(typeof root!=='string'||!isAbsolute(root)||resolve(root)==='/'||typeof readFile!=='function')throw Error('Invalid plugin VFS source');
  return {
    async readPackage(selection,{signal}={}) {
      if(!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(selection.id)||!/^[a-f0-9]{64}$/u.test(selection.revision))throw Error('Invalid plugin source selection');
      const directory=join(root,'packages',selection.id,selection.revision);
      const bytes=Buffer.from(await readFile(join(directory,'manifest.json'),{signal,maxBytes:256*1024}));
      if(bytes.length>256*1024||hash(bytes)!==selection.revision)throw Error('Plugin source manifest digest mismatch');
      const manifest=parseManifest(JSON.parse(bytes.toString('utf8')));
      if(manifest.id!==selection.id)throw Error('Plugin source identity mismatch');
      const files=new Map();
      // Fetch only inventory entries; remote neighbours can never become import dependencies.
      for(const file of manifest.files) {
        signal?.throwIfAborted();
        const content=Buffer.from(await readFile(join(directory,file.path),{signal,maxBytes:file.size}));
        if(content.length!==file.size||hash(content)!==file.sha256)throw Error('Plugin source file digest mismatch');
        files.set(file.path,content);
      }
      signal?.throwIfAborted();return {manifest,manifestBytes:bytes,files};
    },close,
  };
}
async function privateDirectory(path) {
  await mkdir(path,{recursive:true,mode:0o700});
  const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid()||info.mode&0o077)throw Error('Plugin snapshot directory must be private');
}
/** Import only from a private verified snapshot, never a mutable/shared VFS path. */
export async function snapshotVfsPlugin(source,selection,{cacheDirectory,signal}) {
  if(typeof cacheDirectory!=='string'||!isAbsolute(cacheDirectory)||resolve(cacheDirectory)==='/')throw Error('Invalid plugin snapshot cache');
  const fetched=await source.readPackage(selection,{signal});
  signal?.throwIfAborted();
  const manifestBytes=Buffer.from(fetched.manifestBytes);
  if(manifestBytes.length>256*1024||hash(manifestBytes)!==selection.revision)throw Error('Invalid source snapshot manifest');
  const manifest=parseManifest(JSON.parse(manifestBytes.toString('utf8')));
  if(manifest.id!==selection.id||!(fetched.files instanceof Map)||fetched.files.size!==manifest.files.length)throw Error('Invalid source snapshot inventory');
  const contents=new Map([['manifest.json',manifestBytes]]);
  for(const file of manifest.files){
    const bytes=fetched.files.get(file.path);
    if(!(bytes instanceof Uint8Array)||bytes.length!==file.size||hash(bytes)!==file.sha256)throw Error('Invalid source snapshot bytes');
    contents.set(file.path,bytes);
  }
  await privateDirectory(cacheDirectory);
  const parent=join(cacheDirectory,selection.id);await privateDirectory(parent);
  const destination=join(parent,selection.revision);
  try{await lstat(destination);return await verifyPackage(destination,{revision:selection.revision});}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const temporary=await mkdtemp(join(parent,'.stage-'));
  try {
    for(const [path,bytes] of contents) {
      signal?.throwIfAborted();const target=join(temporary,path);
      await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,bytes,{mode:0o400,flag:'wx'});
    }
    await verifyPackage(temporary,{revision:selection.revision});signal?.throwIfAborted();
    try{await rename(temporary,destination);}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;}
    return await verifyPackage(destination,{revision:selection.revision});
  } finally {await rm(temporary,{recursive:true,force:true});}
}
