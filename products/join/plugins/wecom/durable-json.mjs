import fs from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

/** Same-filesystem atomic replacement, durable before the provider is acknowledged. */
export function durableJson(file,value) {
  durableBytes(file,Buffer.from(JSON.stringify(value)));
}

export function durableBytes(file,bytes) {
  const dir=dirname(file);fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const temp=file+'.'+randomUUID()+'.tmp';
  let fd;
  try {
    fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(temp,file);
    const directory=fs.openSync(dir,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
  } finally {if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch{}}
}

export function readJson(file) {try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
