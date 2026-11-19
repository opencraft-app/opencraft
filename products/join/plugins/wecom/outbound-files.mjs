// Files a group assistant sends travel beside the native outbox: the timeline keeps a
// readable "[文件] name" message, and the bytes wait here under that message id until the
// WeCom transport delivers them through the Relay. Private, bounded, removed after sending.
import fs from 'node:fs';
import { join } from 'node:path';
import { deploymentPaths } from '../../../../scripts/container-deployment/paths.mjs';
import {createHash} from 'node:crypto';
import {durableJson,durableBytes,readJson} from './durable-json.mjs';

export const MAX_GROUP_FILE_BYTES = 20 * 1024 * 1024;
export const GROUP_FILE_CHUNK_BYTES = 384 * 1024;
export const MAX_GROUP_FILE_BASE64 = Math.ceil(MAX_GROUP_FILE_BYTES / 3) * 4;
const root = () => join(deploymentPaths().dataDirectory, 'join-wecom-outbound-files');
const key = id => { if (typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/u.test(id)) throw Error('Invalid file key'); return id.replaceAll(':', '_'); };
const validName = n => typeof n === 'string' && n.trim() && n.length <= 160 && !/[\\/\x00-\x1f]/u.test(n);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

export function stageGroupFile(messageId, name, bytes, {uploadId,mode='auto'}={}) {
  if(!['auto','image','file'].includes(mode))throw Error('Invalid file mode');
  if (!validName(name) || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_GROUP_FILE_BYTES) throw Error('Invalid group file');
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
  const base = join(root(), key(messageId));
  durableBytes(base+'.bin',bytes);
  durableJson(base + '.json',{name,mode,...(uploadId?{uploadId}:{} )});
}
export function stagedGroupFile(messageId) {
  try {
    const base = join(root(), key(messageId));
    const { name,mode='auto' } = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
    return validName(name)&&['auto','image','file'].includes(mode) ? { name,mode, bytes: fs.readFileSync(base + '.bin') } : null;
  } catch { return null; }
}
/** A staged non-file action (e.g. create a group) delivered in place of its timeline line. */
export function stageGroupAction(messageId, action) {
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(root(), key(messageId)) + '.action.json', JSON.stringify(action), { mode: 0o600 });
}
export function stagedGroupAction(messageId) {
  try { return JSON.parse(fs.readFileSync(join(root(), key(messageId)) + '.action.json', 'utf8')); } catch { return null; }
}
export function saveGroupOperationResult(messageId,value) {
  const dir=join(root(),'operation-results');fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const files=fs.readdirSync(dir).map(n=>({n,at:fs.statSync(join(dir,n)).mtimeMs})).sort((a,b)=>a.at-b.at);
  for(const f of files)if(f.at<Date.now()-7*86400000)fs.rmSync(join(dir,f.n),{force:true});
  for(const f of files.slice(0,Math.max(0,files.length-4095)))fs.rmSync(join(dir,f.n),{force:true});
  durableJson(join(dir,key(messageId)+'.json'),value);
}
export const groupOperationResult=id=>readJson(join(root(),'operation-results',key(id)+'.json'))??null;
export function dropGroupFile(messageId) {
  try { fs.unlinkSync(join(root(), key(messageId)) + '.action.json'); } catch {}
  const base = join(root(), key(messageId));
  const meta=readJson(base+'.json');
  if(meta?.uploadId)finishGroupFileUpload(meta.uploadId,messageId);
  for (const ext of ['.bin', '.json']) try { fs.unlinkSync(base + ext); } catch {}
}

/** Keep bounded small exact-replay receipts, not the successfully delivered bytes. */
export function finishGroupFileUpload(uploadId,messageId) {
  const base=join(root(),'uploads',key(uploadId)),meta=readJson(base+'.json');
  if(!meta)return;
  const bytes=fs.readFileSync(base+'.bin');if(bytes.length!==meta.size)throw Error('Upload incomplete');
  const dir=join(root(),'receipts');fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const prior=fs.readdirSync(dir).map(n=>({n,mtime:fs.statSync(join(dir,n)).mtimeMs})).sort((a,b)=>a.mtime-b.mtime);
  for(const row of prior.slice(0,Math.max(0,prior.length-4095)))fs.unlinkSync(join(dir,row.n));
  for(const row of prior)if(row.mtime<Date.now()-7*86400000)fs.rmSync(join(dir,row.n),{force:true});
  const chunks=meta.chunks??Array.from({length:Math.ceil(bytes.length/GROUP_FILE_CHUNK_BYTES)},(_,n)=>{
    const offset=n*GROUP_FILE_CHUNK_BYTES,chunk=bytes.subarray(offset,offset+GROUP_FILE_CHUNK_BYTES);return {offset,length:chunk.length,sha256:digest(chunk)};
  });
  durableJson(join(dir,key(uploadId)+'.json'),{name:meta.name,size:meta.size,mode:meta.mode??'auto',chunks,messageId});
  fs.unlinkSync(base+'.bin');fs.unlinkSync(base+'.json');
}

/** Bounded private IPC chunks; exact replay is accepted, changed bytes are rejected. */
export function stageGroupFileChunk(uploadId, name, bytes, offset, size,mode='auto') {
  if(!['auto','image','file'].includes(mode))throw Error('Invalid file mode');
  if (!validName(name) || !Number.isSafeInteger(size) || size < 1 || size > MAX_GROUP_FILE_BYTES
    || !Number.isSafeInteger(offset) || offset < 0 || !(bytes instanceof Uint8Array) || !bytes.length
    || bytes.length > GROUP_FILE_CHUNK_BYTES || offset + bytes.length > size) throw Error('Invalid file chunk');
  const dir = join(root(), 'uploads'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const file of fs.readdirSync(dir)) {
    const path = join(dir, file);
    if (fs.statSync(path).mtimeMs < Date.now() - 86400000) fs.unlinkSync(path);
  }
  const base = join(dir, key(uploadId));
  const receipt=readJson(join(root(),'receipts',key(uploadId)+'.json'));
  if(receipt) {
    if(receipt.name!==name||receipt.size!==size||(receipt.mode??'auto')!==mode||!receipt.chunks.some(c=>c.offset===offset&&c.length===bytes.length&&c.sha256===digest(bytes)))throw Error('Upload changed');
    for(const suffix of ['.bin','.json'])fs.rmSync(base+suffix,{force:true});
    return offset+bytes.length===size?{deliveredMessageId:receipt.messageId}:null;
  }
  if (!fs.existsSync(base + '.json')) {
    const active=fs.readdirSync(dir).filter(n=>n.endsWith('.json')).filter(n=>{
      const m=readJson(join(dir,n));
      // Completed pre-upgrade chunks have no link back to a message. Keep their
      // bytes until the old TTL, but do not let them exhaust the active limit.
      return Array.isArray(m.chunks)||fs.statSync(join(dir,n.replace(/\.json$/u,'.bin'))).size<m.size;
    }).length;
    if (offset !== 0 || active >= 256) throw Error('Upload unavailable');
    durableJson(base + '.json',{name,size,mode,chunks:[]});
    fs.writeFileSync(base + '.bin', Buffer.alloc(0), { mode: 0o600 });
  }
  const meta=readJson(base+'.json');if(meta.name!==name||meta.size!==size||(meta.mode??'auto')!==mode)throw Error('Upload changed');
  const length = fs.statSync(base + '.bin').size;
  if (offset === length) {
    if((meta.chunks?.length??0)>=1024)throw Error('Too many file chunks');
    const fd=fs.openSync(base+'.bin','a');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    meta.chunks??=[];meta.chunks.push({offset,length:bytes.length,sha256:digest(bytes)});durableJson(base+'.json',meta);
  }
  else {
    if (offset + bytes.length > length) throw Error('Invalid upload offset');
    const fd = fs.openSync(base + '.bin', 'r');
    try {
      const prior = Buffer.alloc(bytes.length); fs.readSync(fd, prior, 0, prior.length, offset);
      if (!prior.equals(Buffer.from(bytes))) throw Error('Upload changed');
    } finally { fs.closeSync(fd); }
    if(meta.chunks&&!meta.chunks.some(c=>c.offset===offset&&c.length===bytes.length)){
      if(meta.chunks.length>=1024)throw Error('Too many file chunks');
      meta.chunks.push({offset,length:bytes.length,sha256:digest(bytes)});durableJson(base+'.json',meta);
    }
  }
  return offset + bytes.length === size ? fs.readFileSync(base + '.bin') : null;
}
