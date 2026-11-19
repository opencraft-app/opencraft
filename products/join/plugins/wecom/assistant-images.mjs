import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {join} from 'node:path';
import {durableBytes} from './durable-json.mjs';
const MAX_IMAGE_BYTES=2*1024*1024;
/** Authorized chunks stay below the private Host's 1MiB JSON envelope. No OCR/parsing. */
export async function readConversationImage({messageId,call,signal}) {
 if(typeof messageId!=='string'||!messageId||messageId.length>256)throw Error('Invalid group image message');
 let offset=0,facts;const chunks=[];
 do {
  signal?.throwIfAborted();const part=await call('image',{messageId,offset});signal?.throwIfAborted();
  if(!part||!['image/png','image/jpeg'].includes(part.type)||!Number.isSafeInteger(part.size)||part.size<1||part.size>MAX_IMAGE_BYTES||!/^[a-f0-9]{64}$/u.test(part.sha256)||typeof part.base64!=='string'||part.base64.length>87384)throw Error('Invalid group image chunk');
  const data=Buffer.from(part.base64,'base64');if(data.toString('base64')!==part.base64||!data.length||data.length>65536||part.nextOffset!==offset+data.length||part.nextOffset>part.size)throw Error('Invalid group image chunk');
  const next={type:part.type,size:part.size,sha256:part.sha256};if(facts&&JSON.stringify(next)!==JSON.stringify(facts))throw Error('Group image changed');facts=next;chunks.push(data);offset=part.nextOffset;
 }while(offset<facts.size);
 const bytes=Buffer.concat(chunks);if(createHash('sha256').update(bytes).digest('hex')!==facts.sha256)throw Error('Group image changed');
 const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 if(facts.type==='image/png'?!png:!jpeg)throw Error('Invalid group image type');
 return {...facts,bytes};
}
/** A full Agent can view old native screenshots found by history/search. The
 * current scope's Host authorizes every chunk; only original bytes are exported. */
export async function materializeConversationImage({messageId,call,directory,signal}) {
 const value=await readConversationImage({messageId,call,signal});
 await call('authorize',{});signal?.throwIfAborted();
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const dir=fs.lstatSync(directory);if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid()||dir.mode&0o077)throw Error('Unsafe group image directory');
 const name=value.sha256+(value.type==='image/png'?'.png':'.jpg'),original=join(directory,name);
 const files=fs.readdirSync(directory).filter(n=>/^[a-f0-9]{64}\.(png|jpg)$/u.test(n)&&n!==name).map(n=>({n,at:fs.lstatSync(join(directory,n)).mtimeMs})).sort((a,b)=>a.at-b.at);
 for(const [i,f]of files.entries())if(f.at<Date.now()-86400000||i<files.length-15)fs.rmSync(join(directory,f.n),{force:true});
 durableBytes(original,value.bytes);
 await call('authorize',{});signal?.throwIfAborted();
 return {messageId,original,type:value.type,size:value.size,sha256:value.sha256,contentProcessing:'agent-driven; original image, not OCR'};
}
export async function importConversationImages({history,row,call,store,limit=8,signal}) {
 const candidates=[...history.messages,{...row,messageId:row.id,sequence:row.seq}],seen=new Set(),attached=[],unavailable=[];
 for(const m of candidates.sort((a,b)=>b.sequence-a.sequence)) {
  if(m.image?.state!=='ready'||typeof m.messageId!=='string'||seen.has(m.messageId))continue;
  seen.add(m.messageId);if(attached.length>=limit)break;
  try {
   const {bytes,type}=await readConversationImage({messageId:m.messageId,call,signal});
   const attachment=store.importBytes('group-image-'+m.sequence+(type==='image/png'?'.png':'.jpg'),bytes);
   attached.push({messageId:m.messageId,sequence:m.sequence,attachmentId:attachment.attachmentId});
  }catch(error){if(signal?.aborted)throw error;unavailable.push(m.messageId);}
 }
 return {attached,unavailable};
}
