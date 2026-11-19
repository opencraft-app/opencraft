import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { deploymentPaths } from '../../../../scripts/container-deployment/paths.mjs';
import { MAX_GROUP_FILE_BYTES } from './outbound-files.mjs';
import {durableBytes,durableJson,readJson} from './durable-json.mjs';

/** An explicit per-invocation export, never scan a task's workspace or parse arbitrary file links. */
export function createTaskFiles({ root, snapshotRoot, namespace='' }={}) {
  const identity=key=>createHash('sha256').update(namespace+'\0'+key).digest('hex');
  function folder(key) {
    return join(root??join(deploymentPaths().executionDirectory,'wecom-task-results'),identity(key));
  }
  function prepare(key) {
    const path=folder(key);
    fs.mkdirSync(path,{recursive:true,mode:0o700});
    if(fs.realpathSync(path)!==resolve(path))throw Error('Unsafe task export directory');
    return path;
  }
  function read(key,name) {
    if(typeof name!=='string'||!name||name.length>160||/[\\/\x00-\x1f]/u.test(name)||name.startsWith('.'))throw Error('Invalid task file');
    const path=prepare(key),fd=fs.openSync(join(path,name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    try {
      const before=fs.fstatSync(fd);
      if(!before.isFile()||before.nlink!==1||before.size<1||before.size>MAX_GROUP_FILE_BYTES)throw Error('Task file exceeds 20 MiB or is not a regular private file');
      const bytes=Buffer.alloc(before.size);let offset=0;
      while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)throw Error('Task file changed');offset+=n;}
      const after=fs.fstatSync(fd);
      if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('Task file changed');
      return {name,bytes,sha256:createHash('sha256').update(bytes).digest('hex')};
    }finally{fs.closeSync(fd);}
  }
  function list(key) {
    const files=[],skipped=[];let total=0;
    for(const name of fs.readdirSync(prepare(key)).sort()) {
      try {
        if(files.length>=8)throw Error('Too many files');
        const f=read(key,name);if(total+f.bytes.length>80*1024*1024)throw Error('Too many bytes');
        total+=f.bytes.length;
        files.push({name,size:f.bytes.length,sha256:f.sha256});
      }catch{skipped.push(name.slice(0,160));}
    }
    return {files,skipped};
  }
  // The agent's export folder is mutable. Delivery uses a separate durable byte
  // snapshot, committed by its manifest last, never a later workspace revision.
  function deliveryFolder(key) {
    const path=join(snapshotRoot??(root?join(root,'.deliveries'):join(deploymentPaths().dataDirectory,'join-wecom-task-deliveries')),identity(key));
    fs.mkdirSync(path,{recursive:true,mode:0o700});
    if(fs.realpathSync(path)!==resolve(path))throw Error('Unsafe task delivery directory');
    return path;
  }
  function freeze(key) {
    const dir=deliveryFolder(key),manifest=join(dir,'manifest.json'),existing=readJson(manifest);
    if(existing)return existing;
    const exported=list(key),files=[],skipped=[...exported.skipped];
    for(const file of exported.files) {
      try {
        const current=read(key,file.name);
        if(current.sha256!==file.sha256||current.bytes.length!==file.size)throw Error('Task file changed');
        durableBytes(join(dir,file.sha256+'.bin'),current.bytes);files.push(file);
      }catch(error){
        if(!['ENOENT','ELOOP'].includes(error.code)&&!/^Task file|^Invalid task file/u.test(error.message))throw error;
        skipped.push(file.name);
      }
    }
    const value={files,skipped};durableJson(manifest,value);return value;
  }
  function readDelivery(key,name) {
    const dir=deliveryFolder(key);let manifest;
    try{manifest=readJson(join(dir,'manifest.json'));}catch(error){if(error instanceof SyntaxError)throw Error('Task delivery snapshot changed');throw error;}
    const file=Array.isArray(manifest?.files)?manifest.files.find(f=>f.name===name):null;
    if(!file||!/^([a-f0-9]{64})$/u.test(file.sha256))throw Error('Task delivery snapshot unavailable');
    const fd=fs.openSync(join(dir,file.sha256+'.bin'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    try {
      const stat=fs.fstatSync(fd);
      if(!stat.isFile()||stat.nlink!==1||stat.size!==file.size||stat.size<1||stat.size>MAX_GROUP_FILE_BYTES)throw Error('Task delivery snapshot changed');
      const bytes=Buffer.alloc(stat.size);let offset=0;
      while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)throw Error('Task delivery snapshot changed');offset+=n;}
      const sha256=createHash('sha256').update(bytes).digest('hex'),after=fs.fstatSync(fd);
      if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||sha256!==file.sha256)throw Error('Task delivery snapshot changed');
      return {name,bytes,sha256};
    }finally{fs.closeSync(fd);}
  }
  function dropDelivery(key){fs.rmSync(deliveryFolder(key),{recursive:true,force:true});}
  return {prepare,list,read,freeze,readDelivery,dropDelivery};
}
