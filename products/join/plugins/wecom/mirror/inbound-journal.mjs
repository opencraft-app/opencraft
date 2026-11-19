import{forwardedEnvelopeIdentity}from'../forwarded-identity.mjs';
import fs from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {deploymentPaths} from '../../../../../scripts/container-deployment/paths.mjs';
import {durableJson,readJson} from '../durable-json.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const KEEP_MS=7*86400000;

/** Private durable admission journal. A derived transcript is frozen BEFORE native ingest;
 * admitted file intents survive ACK loss, shutdown and process restart. */
export function createInboundJournal(serverId,{root=join(deploymentPaths().dataDirectory,'join-wecom-inbound-journal',serverId)}={}) {
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const files=new Map();
  let lastGc=0;
  const path=id=>join(root,id+'.json');
  const pendingFiles=row=>row.files??(row.file?[{...row.file,done:row.fileDone,nextAttempt:row.nextAttempt}]:[]);
  const save=row=>{durableJson(path(row.key),row);if(row.admitted&&pendingFiles(row).some(f=>!f.done))files.set(row.key,row);else files.delete(row.key);return row;};
  function gc() {
    if(Date.now()-lastGc<3600000)return;lastGc=Date.now();
    for(const name of fs.readdirSync(root)) {
      if(!/^[a-f0-9]{64}\.json$/u.test(name))continue;
      const row=readJson(join(root,name));
      row.files=pendingFiles(row);
      if(row.acked&&row.files.every(f=>f.done)&&Date.now()-row.createdAt>KEEP_MS){fs.unlinkSync(join(root,name));continue;}
      if(row.admitted&&row.files.some(f=>!f.done)&&!files.has(row.key))files.set(row.key,row);
    }
  }
  gc();
  return {
    async prepare(raw,build) {
      gc();
      const key=digest([raw.source,raw.id]);
      const fingerprint=digest(canonical(forwardedEnvelopeIdentity({...raw,...(raw.mediaIdentity?{mediaId:raw.mediaIdentity}:{})})));
      const prior=files.get(key)??readJson(path(key));
      if(prior){if(prior.fingerprint!==fingerprint)throw Error('mirror_raw_idempotency_conflict');return prior;}
      return save({key,createdAt:Date.now(),fingerprint,...await build()});
    },
    admit(row,messageId){row.admitted=true;row.messageId=messageId;return save(row);},
    ack(row){row.acked=true;return save(row);},
    pending:()=>[...files.values()].flatMap(row=>pendingFiles(row).filter(f=>!f.done&&(f.nextAttempt??0)<=Date.now()).map(file=>({row,file}))),
    fileResult(row,file,status,permanent=false,bytes=0){
      file.attempts=(file.attempts??0)+1;file.lastStatus=status;file.bytes=bytes;
      file.done=status!=='unavailable'||permanent||Date.now()-row.createdAt>KEEP_MS;
      file.nextAttempt=Date.now()+Math.min(60000,1000*2**Math.min(file.attempts-1,6));save(row);
    },
  };
}
