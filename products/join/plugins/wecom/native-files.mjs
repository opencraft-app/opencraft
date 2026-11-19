import {readInboundFileChunk} from './inbound-files.mjs';
/** Trusted ingest journal only. Browser-provided paths and pasted reference IDs are never accepted. */
export function nativeFileCommand(service,db,{method,params:p}){
 if(method!=='join/wecom-file/admit')return;
 const native=db.prepare('SELECT m.channel_id,e.external_id FROM actor_messages m JOIN actor_channel_external_messages e ON e.message_id=m.id JOIN actor_channel_sources s ON s.source=e.source WHERE m.id=? AND e.source=? AND s.channel_id=m.channel_id AND s.active=1').get(p.messageId,p.source);
 if(!native||native.external_id!==p.externalId)throw Error('channel_source_retired');
 const chunks=[];let offset=0,metadata,signature;
 do{const part=readInboundFileChunk(p.id,p.source,offset);if(!part)throw Error('attachment_unavailable');
  const next=JSON.stringify([part.name,part.type,part.size,part.revision]);if(signature&&signature!==next)throw Error('attachment_changed');signature=next;metadata=part;
  const bytes=Buffer.from(part.base64,'base64');if(!bytes.length&&part.size!==0||part.nextOffset!==offset+bytes.length||part.nextOffset>part.size||part.size>20*1024*1024)throw Error('attachment_invalid');
  chunks.push(bytes);offset=part.nextOffset;
 }while(offset<metadata.size);
 const bytes=Buffer.concat(chunks),prior=db.prepare('SELECT name,mime,bytes FROM actor_channel_attachments WHERE message_id=?').get(p.messageId);
 if(prior){if(prior.name!==metadata.name||prior.mime!==metadata.type||!Buffer.from(prior.bytes).equals(bytes))throw Error('idempotency_conflict');return{result:null,changes:[]};}
 db.prepare('INSERT INTO actor_channel_attachments(message_id,name,mime,bytes) VALUES(?,?,?,?)').run(p.messageId,metadata.name,metadata.type,bytes);
 db.prepare('INSERT OR REPLACE INTO actor_channel_changes(channel_id,message_id) VALUES(?,?)').run(native.channel_id,p.messageId);
 return{result:{ready:true},changes:[{channelId:native.channel_id}]};
}
