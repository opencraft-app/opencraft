import { readChannelMentions } from './channel-mentions.js';
import { communicationExtension } from './communication-extension.js';
import { randomUUID, sha256Hex } from './portable-crypto.js';
import type { SqlDatabase } from '@opencraft/sql';
import type { Collaboration } from './collaboration.js';
import type { NativeChannelChange } from './native-channels.js';
import type { ActorContext } from '@opencraft/identity-core/actors';

import { channelImageType, type ChannelImage, type ChannelMessagePresentation } from "@opencraft/appserver-protocol";
export {channelImageType, type ChannelImage};
export interface ChannelSourceBinding { source: string; channelId: string }
export interface ChannelArrival { source: string; id: string; author: string; sender?: { id: string; displayName: string }; text: string; at: number; mediaId?: string; mediaIdentity?: string }
export interface ChannelSyncCommand { method: string; params: Record<string, any> }
export interface ChannelSyncResult { result: any; changes: NativeChannelChange[] }
const text=(v:unknown,max=512):string=>{if(typeof v!=='string'||!v.trim()||v.length>max||/[\0]/u.test(v))throw Error('invalid_input');return v;};
const digest=(v:unknown)=>sha256Hex(JSON.stringify(v));
const conflict=()=>Object.assign(Error('idempotency_conflict'),{code:'idempotency_conflict'});

/** Native message owner. Called only by trusted transport composition through the
 * storage Worker, never dispatched from client supplied method/context frames. */
export function channelSyncCommand(service: Collaboration, db: SqlDatabase, command: ChannelSyncCommand): ChannelSyncResult {
  const changes: NativeChannelChange[]=[];
  const changed=(channelId:string)=>changes.push({channelId});
  const touch=(messageId:string)=>{
    db.prepare('INSERT OR REPLACE INTO actor_channel_changes(channel_id,message_id) SELECT channel_id,id FROM actor_messages WHERE id=?').run(messageId);
    const row=db.prepare('SELECT channel_id FROM actor_messages WHERE id=?').get(messageId);
    if(row)changed(String(row.channel_id));
  };
  const {method,params:p}=command;
  const connection=()=>{
    const id=p.connectionId??'legacy';
    if(typeof id!=='string'||!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(id))throw Error('invalid_channel_connection');
    return id;
  };
  const currentConnection=(legacyBootstrap=false)=>{
    const id=connection();text(p.incarnation);
    // Pre-scope trusted transports could attach their first source directly.
    // Bootstrap only an absent legacy owner; never replace a live/retired owner,
    // and never infer an explicit connection from an unnegotiated old caller.
    if(legacyBootstrap&&p.connectionId===undefined&&id==='legacy'&&!db.prepare('SELECT 1 FROM actor_channel_connections WHERE id=?').get(id))
      db.prepare('INSERT INTO actor_channel_connections(id,incarnation,active) VALUES(?,?,1)').run(id,p.incarnation);
    if(!db.prepare('SELECT 1 FROM actor_channel_connections WHERE id=? AND incarnation=? AND active=1').get(id,p.incarnation))throw Error('channel_connection_retired');
    return id;
  };
  // Sources created by older trusted adapters have no owner row and stay in the
  // legacy singleton scope. Explicit connections never implicitly adopt them.
  const ownedSources=`SELECT s.source FROM actor_channel_sources s LEFT JOIN actor_channel_source_owners own ON own.source=s.source WHERE COALESCE(own.connection_id,'legacy')=?`;
  const bindOwner=(source:string,id:string)=>db.prepare('INSERT INTO actor_channel_source_owners(source,connection_id) VALUES(?,?) ON CONFLICT(source) DO NOTHING').run(source,id);
  const source=()=>{
    const row=db.prepare('SELECT * FROM actor_channel_sources WHERE source=? AND active=1 AND incarnation=? AND source IN ('+ownedSources+')').get(text(p.source),text(p.incarnation),currentConnection());
    if(!row||!service.channels.isActive(String(row.channel_id)))throw Error('channel_source_retired');return row;
  };
  const authorized=(row:Record<string,unknown>)=>{
    if(!service.channels.isActive(String(row.channel_id)))return false;
    const delegated=communicationExtension()?.deliveryAllowed?.(service,db,row);
    if(delegated!==undefined)return delegated;
    const actor=service.actors.get(String(row.author_id));
    return actor && service.actors.isCurrent({actorId:actor.id,generation:Number(row.actor_generation),credentialId:row.credential_id as string|null,expiresAt:Number(row.actor_expires_at)}) && service.channels.memberEpoch(String(row.channel_id),actor.id)===row.member_epoch;
  };
  const attempt=(rejectRevoked=false)=>{
    const s=source();
    const row=db.prepare(`SELECT o.*,m.channel_id,m.author_id FROM actor_channel_outbox o JOIN actor_messages m ON m.id=o.message_id
      WHERE o.message_id=? AND o.source=? AND o.source_epoch=? AND o.attempt_id=? AND (o.state='sending' OR (?=1 AND o.state='unknown'))`).get(text(p.messageId),p.source,s.epoch,text(p.attemptId),rejectRevoked?1:0);
    // Membership retirement conservatively marks in-flight work unknown. The same
    // live transport may still prove rejection before handoff, but cannot revive
    // that attempt or claim delivery after its sender's authority was revoked.
    if(!row||row.state==='unknown'&&authorized(row))throw Error('channel_attempt_retired');return row;
  };
  const result=db.transaction(()=>{
    const extension=communicationExtension()?.synchronize?.(service,db,command);
    if(extension){changes.push(...extension.changes);return extension.result;}
    switch(method){
      case 'connectionCapabilities':return {version:1};
      case 'reserveHuman': return service.actors.reserveHuman(p.reservation);
      case 'retireSource': {
        const s=db.prepare('SELECT * FROM actor_channel_sources WHERE source=?').get(text(p.source));
        if(!s)return null;
        if(!db.prepare('SELECT 1 FROM actor_channel_sources WHERE source=? AND source IN ('+ownedSources+')').get(p.source,connection()) || p.incarnation!==undefined && s.incarnation!==p.incarnation)throw Error('channel_source_retired');
        db.prepare("UPDATE actor_channel_outbox SET state='rejected' WHERE source=? AND state IN ('queued','sending')").run(p.source);
        if(p.messageId!==undefined)db.prepare("UPDATE actor_channel_outbox SET state='delivered' WHERE message_id=? AND source=? AND source_epoch=?").run(text(p.messageId),p.source,s.epoch);
        if(service.channels.isActive(String(s.channel_id)))db.prepare('DELETE FROM actor_channel_sources WHERE source=?').run(p.source);
        else db.prepare('UPDATE actor_channel_sources SET active=0 WHERE source=?').run(p.source);changed(String(s.channel_id));return null;
      }
      case 'addSource': {
        const id=currentConnection(true),binding=p.binding;text(binding?.source);text(binding?.channelId);
        if(!db.prepare('SELECT 1 FROM actor_channels WHERE id=? AND peer_id IS NULL').get(binding.channelId))throw Error('invalid_channel_binding');
        if(!service.channels.isActive(binding.channelId))throw Error('channel_dissolved');
        const old=db.prepare("SELECT s.channel_id,COALESCE(own.connection_id,'legacy') AS connection_id FROM actor_channel_sources s LEFT JOIN actor_channel_source_owners own ON own.source=s.source WHERE s.source=?").get(binding.source);
        if(old&&old.connection_id!==id)throw Error('channel_connection_conflict');
        if(old&&old.channel_id!==binding.channelId)throw Error('channel_binding_conflict');
        db.prepare(`INSERT INTO actor_channel_sources VALUES(?,?,?,?,1,?) ON CONFLICT(source) DO UPDATE SET active=1,incarnation=excluded.incarnation,images=excluded.images`).run(binding.source,binding.channelId,randomUUID(),p.incarnation,p.images===true?1:0);
        bindOwner(binding.source,id);return null;
      }
      case 'configure': {
        const id=connection();text(p.incarnation);
        if(!Array.isArray(p.bindings)||p.bindings.length>256)throw Error('invalid_input');
        const sources=new Set(),channels=new Set();
        for(const b of p.bindings){
          text(b.source);text(b.channelId);
          if(sources.has(b.source)||channels.has(b.channelId)||!db.prepare('SELECT 1 FROM actor_channels WHERE id=? AND peer_id IS NULL').get(b.channelId))throw Error('invalid_channel_binding');
          sources.add(b.source);channels.add(b.channelId);
          const old=db.prepare("SELECT s.channel_id,COALESCE(own.connection_id,'legacy') AS connection_id FROM actor_channel_sources s LEFT JOIN actor_channel_source_owners own ON own.source=s.source WHERE s.source=?").get(b.source);
          if(old&&old.connection_id!==id)throw Error('channel_connection_conflict');
          // Retargeting an established source requires explicit administration, not config replay.
          if(old&&old.channel_id!==b.channelId)throw Error('channel_binding_conflict');
        }
        const pending=db.prepare("SELECT message_id FROM actor_channel_outbox WHERE state IN ('sending','queued') AND source IN ("+ownedSources+")").all(id);
        db.prepare("UPDATE actor_channel_outbox SET state='unknown' WHERE state='sending' AND source IN ("+ownedSources+")").run(id);
        db.prepare("UPDATE actor_channel_images SET attribution='unknown' WHERE attribution='sending' AND (source IN ("+ownedSources+") OR message_id IN (SELECT message_id FROM actor_channel_outbox WHERE source IN ("+ownedSources+")))").run(id,id);
        db.prepare('UPDATE actor_channel_sources SET active=0 WHERE source IN ('+ownedSources+')').run(id);
        db.prepare('INSERT INTO actor_channel_connections(id,incarnation,active) VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET incarnation=excluded.incarnation,active=1').run(id,p.incarnation);
        for(const b of p.bindings)if(service.channels.isActive(b.channelId)){
          db.prepare(`INSERT INTO actor_channel_sources VALUES(?,?,?,?,1,?) ON CONFLICT(source) DO UPDATE SET active=1,incarnation=excluded.incarnation,images=excluded.images`).run(b.source,b.channelId,randomUUID(),p.incarnation,p.images===true?1:0);
          bindOwner(b.source,id);
        }
        db.prepare("UPDATE actor_channel_outbox SET state='rejected' WHERE state='queued' AND source IN (SELECT s.source FROM actor_channel_sources s WHERE s.active=0 AND s.source IN ("+ownedSources+"))").run(id);
        for(const row of pending)touch(String(row.message_id));return null;
      }
      case 'deactivate': {
        const id=connection();
        db.prepare('UPDATE actor_channel_connections SET active=0 WHERE id=? AND incarnation=?').run(id,text(p.incarnation));
        db.prepare('UPDATE actor_channel_sources SET active=0 WHERE incarnation=? AND source IN ('+ownedSources+')').run(p.incarnation,id);return null;
      }
      case 'externalHistory': {
        // Bounded, read-only migration projection for a trusted channel transport.
        const s=db.prepare('SELECT 1 FROM actor_channel_sources WHERE source=? AND active=1 AND source IN ('+ownedSources+')').get(text(p.source),connection());
        if(!s||!Number.isSafeInteger(p.after)||p.after<0)throw Error('invalid_input');
        text(p.query,256);
        return db.prepare('SELECT e.external_id AS externalId,m.id AS messageId,m.content,m.seq FROM actor_channel_external_messages e JOIN actor_messages m ON m.id=e.message_id WHERE e.source=? AND m.seq>? AND instr(m.content,?)>0 ORDER BY m.seq LIMIT 32').all(p.source,p.after,p.query);
      }
      case 'received': {
        // Trusted transport recovery only, not a client RPC. Reuse the accepted derived
        // text only when the immutable sender/time/media/extension identity still matches.
        const s=db.prepare('SELECT channel_id FROM actor_channel_sources WHERE source=? AND active=1 AND source IN ('+ownedSources+')').get(text(p.source),connection());
        const a=p.arrival as ChannelArrival;
        if(!s||!service.channels.isActive(String(s.channel_id))||a.source!==p.source||!Number.isSafeInteger(a.at)||a.at<0)throw Error('invalid_input');
        text(a.id,256);text(a.author,256);
        const sender=a.sender??{id:a.author,displayName:a.author};text(sender.id);
        const prior=db.prepare('SELECT e.message_id,e.fingerprint,m.content FROM actor_channel_external_messages e JOIN actor_messages m ON m.id=e.message_id WHERE e.source=? AND e.external_id=?').get(p.source,a.id);
        if(!prior)return null;
        const fingerprint=digest([sender.id,prior.content,a.at,a.mediaIdentity??a.mediaId??null,...(communicationExtension()?.fingerprint?.(a)??[])]);
        if(prior.fingerprint!==fingerprint)throw conflict();
        return {messageId:prior.message_id,text:prior.content};
      }
      case 'ingest': {
        const s=source(),a=p.arrival as ChannelArrival;
        if(a.source!==p.source||!Number.isSafeInteger(a.at)||a.at<0)throw Error('invalid_input');
        text(a.id,256);text(a.author,256);
        const sender=a.sender??{id:a.author,displayName:a.author};text(sender.id);text(sender.displayName,256);
        if(a.mediaId!==undefined){text(a.mediaId);if(!s.images)throw Error('channel_images_unavailable');}
        else text(a.text,16384);
        if(typeof a.text!=='string'||a.text.length>16384)throw Error('invalid_input');
        if(a.mediaIdentity!==undefined){text(a.mediaIdentity);if(!a.mediaId)throw Error('invalid_input');}
        // Relay storage references may change during cutover; the provider's
        // immutable media identity remains part of the external retry payload.
        const fingerprint=digest([sender.id,a.text,a.at,a.mediaIdentity??a.mediaId??null,...(communicationExtension()?.fingerprint?.(a)??[])]);
        const prior=db.prepare('SELECT message_id,fingerprint FROM actor_channel_external_messages WHERE source=? AND external_id=?').get(p.source,a.id);
        if(prior){if(prior.fingerprint!==fingerprint)throw conflict();return {messageId:prior.message_id};}
        const messageId=randomUUID(),author='external:'+digest([p.source,sender.id]);
        db.prepare(`INSERT INTO actor_messages(id,seq,channel_id,author_id,target_id,content,created_at,target_kind,author_display_name)
          VALUES(?,(SELECT COALESCE(MAX(seq),0)+1 FROM actor_messages),?,?,?,?,?,'channel',?)`).run(messageId,s.channel_id,author,s.channel_id,a.text,a.at,sender.displayName);
        db.prepare('INSERT INTO actor_channel_external_messages VALUES(?,?,?,?,?)').run(messageId,p.source,a.id,author,fingerprint);
        if(a.mediaId)db.prepare("INSERT INTO actor_channel_images(message_id,source,media_id,state) VALUES(?,?,?,'pending')").run(messageId,p.source,a.mediaId);
        communicationExtension()?.arrival?.(service,db,a,s,messageId);
        changed(String(s.channel_id));return {messageId};
      }
      case 'claim': {
        const id=currentConnection();
        for(let i=0;i<32;i++){
          const row=db.prepare(`SELECT o.*,m.channel_id,m.author_id,m.content,m.author_display_name,s.incarnation,s.active,s.epoch,
            i.mime,i.bytes,a.name AS attachment_name,a.mime AS attachment_type,length(a.bytes) AS attachment_size FROM actor_channel_outbox o JOIN actor_messages m ON m.id=o.message_id JOIN actor_channel_sources s ON s.source=o.source
            LEFT JOIN actor_channel_images i ON i.message_id=m.id LEFT JOIN actor_channel_attachments a ON a.message_id=m.id WHERE o.state='queued' AND s.incarnation=? AND s.source IN (${ownedSources}) ORDER BY m.seq LIMIT 1`).get(p.incarnation,id);
          if(!row)return null;
          if(!row.active||row.epoch!==row.source_epoch||!authorized(row)){
            db.prepare("UPDATE actor_channel_outbox SET state='rejected' WHERE message_id=?").run(row.message_id!);touch(String(row.message_id));continue;
          }
          const attemptId=randomUUID();db.prepare("UPDATE actor_channel_outbox SET state='sending',attempt_id=? WHERE message_id=?").run(attemptId,row.message_id!);touch(String(row.message_id));
          const replyTo=communicationExtension()?.replyTarget?.(db,String(row.message_id));
          const mentions=communicationExtension()?.outboundMentions?.(service,db,row,readChannelMentions(db,String(row.message_id)))??[];
          const actor=service.actors.get(String(row.author_id));
          const author=String(row.author_display_name??actor?.displayName??row.author_id);
          const policy=communicationExtension()?.outboundPresentation?.(service,db,row);
          const presentation:ChannelMessagePresentation={version:1,sender:{id:String(row.author_id),displayName:author,
            role:policy?.role??(actor?.kind==='human'?'human':actor?'agent':'system')},format:policy?.format??'text'};
          return {messageId:row.message_id,source:row.source,attemptId,text:row.content,author,presentation,...(mentions.length?{mentions}:{}),
            ...(typeof replyTo==='string'&&replyTo.length>0&&replyTo.length<=256?{replyTo}:{}),
            ...(row.attachment_name?{attachment:{name:String(row.attachment_name),type:String(row.attachment_type),size:Number(row.attachment_size)}}:{}),
            ...(row.bytes instanceof Uint8Array?{image:{type:row.mime,bytes:row.bytes}}:{})};
        }
        return null;
      }
      case 'attachmentChunk': {
        const row=attempt();if(!authorized(row))throw Error('channel_denied');
        if(!Number.isSafeInteger(p.offset)||p.offset<0)throw Error('invalid_input');
        const file=db.prepare('SELECT name,mime,length(bytes) AS size,substr(bytes,?,65536) AS bytes FROM actor_channel_attachments WHERE message_id=?').get(p.offset+1,row.message_id!);
        if(!file||p.offset>Number(file.size))throw Error('channel_attachment_unavailable');
        return{name:String(file.name),type:String(file.mime),size:Number(file.size),bytes:file.bytes,nextOffset:p.offset+(file.bytes as Uint8Array).length};
      }
      case 'check': {const row=attempt();if(!authorized(row))throw Error('channel_denied');return null;}
      case 'settle': {
        const row=attempt(p.status==='rejected');if(!['delivered','rejected','unknown'].includes(p.status))throw Error('invalid_input');
        db.prepare('UPDATE actor_channel_outbox SET state=? WHERE message_id=?').run(p.status,row.message_id!);touch(String(row.message_id));return null;
      }
      case 'attribution': {
        const row=attempt();if(!['sending','delivered','rejected','unknown'].includes(p.status))throw Error('invalid_input');
        db.prepare('UPDATE actor_channel_images SET attribution=? WHERE message_id=?').run(p.status,row.message_id!);touch(String(row.message_id));return null;
      }
      case 'pendingImage':
        return db.prepare(`SELECT i.message_id AS messageId,i.media_id AS mediaId,i.source FROM actor_channel_images i
          JOIN actor_channel_sources s ON s.source=i.source WHERE i.state='pending' AND s.active=1 AND s.images=1 AND s.incarnation=? AND s.source IN (${ownedSources}) LIMIT 1`).get(text(p.incarnation),currentConnection())??null;
      case 'imageReady': {
        source();
        const type=p.bytes&&channelImageType(p.bytes);
        const row=db.prepare('SELECT state FROM actor_channel_images WHERE message_id=? AND source=?').get(text(p.messageId),p.source);
        if(!row)return {ready:false};
        if(row.state==='ready')return {ready:true};
        // Redelivery may repair a transient download failure; a late failure
        // cannot overwrite bytes that have already been committed.
        if(row.state==='pending'||type) {
          db.prepare('UPDATE actor_channel_images SET state=?,mime=?,bytes=?,media_id=NULL WHERE message_id=?').run(type?'ready':'unavailable',type??null,type?p.bytes:null,p.messageId);touch(p.messageId);
        }
        return {ready:!!type};
      }
      default:throw Error('unsupported_channel_sync_command');
    }
  });
  return {result,changes};
}

/** Called in the same transaction as native admission. A binding does not replay
 * old local messages and external arrivals never enter this outbox. */
export function enqueueChannelDelivery(db:SqlDatabase,service:Collaboration,context:ActorContext,channelId:string,messageId:string,body:string,image?:ChannelImage){
  const source=db.prepare('SELECT * FROM actor_channel_sources WHERE channel_id=? AND active=1').get(channelId);
  if(source){
    if(body.length>4096)throw Error('invalid_input');
    if(image&&!source.images)throw Error('channel_images_unavailable');
    db.prepare("INSERT INTO actor_channel_outbox(message_id,source,source_epoch,actor_generation,member_epoch,credential_id,actor_expires_at,state) VALUES(?,?,?,?,?,?,?,'queued')").run(messageId,source.source!,source.epoch!,context.generation,service.channels.assertWritable(context,channelId),context.credentialId,context.expiresAt);
  }
  if(image)db.prepare("INSERT INTO actor_channel_images(message_id,mime,bytes,state) VALUES(?,?,?,'ready')").run(messageId,image.type,image.bytes);
}
