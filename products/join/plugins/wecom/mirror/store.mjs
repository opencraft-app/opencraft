import{forwardedEnvelopeIdentity}from'../forwarded-identity.mjs';
import {TypingState,TYPING_INGEST} from './typing-state.mjs';
import { createHash, randomUUID, randomBytes } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const humanKey = (corpId, userId) => hash(JSON.stringify(['wecom', corpId, userId]));
const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/u.test(v);
const INGEST = `
local meta,queue,seen,kept,work,jobs,media=unpack(KEYS)
local event=cjson.decode(ARGV[1]);local now=tonumber(ARGV[2]);local room=ARGV[3]
if redis.call('HGET',meta,'retired')=='1' and ARGV[5]=='' then return 'ignored' end
local prior=redis.call('HGET',kept,event.id)
if prior then if prior~=ARGV[4] then return 'conflict' end;return 'duplicate' end
if redis.call('ZSCORE',seen,event.id) then return 'duplicate' end
if redis.call('EXISTS',meta)==0 and redis.call('ZCARD',work)>=8192 then return 'busy' end
local count=redis.call('LLEN',queue);local bound=redis.call('HEXISTS',meta,'binding')==1
-- Capture admission once, alongside dedupe. Importing a pre-binding backlog must
-- never execute historical mentions, even if the provider retries after binding.
local payload=ARGV[1]
if event.mentioned~=nil then event.assistantEligible=bound;payload=cjson.encode(event) end
local bytes=tonumber(ARGV[7])+#payload-#ARGV[1]
if (bound or count<200) and event.mediaId and ARGV[6]=='' then return 'media_required' end
if (bound and count>=10000) or ((bound or count<200) and tonumber(redis.call('HGET',meta,'bytes') or '0')+bytes>536870912) or (ARGV[5]~='' and redis.call('LLEN',jobs)>=256) then return 'busy' end
redis.call('HSETNX',meta,'source',event.source)
redis.call('ZADD',seen,now,event.id);redis.call('ZREMRANGEBYSCORE',seen,'-inf',now-604800000)
redis.call('ZREMRANGEBYRANK',seen,0,-4097)
if ARGV[5]~='' then redis.call('RPUSH',jobs,ARGV[5]) end
redis.call('ZADD',work,now,room)
if not bound and count>=200 then redis.call('HINCRBY',meta,'dropped',1);return 'discarded' end
${TYPING_INGEST}
redis.call('RPUSH',queue,payload);redis.call('HSET',kept,event.id,ARGV[4])
redis.call('HINCRBY',meta,'bytes',bytes);if ARGV[6]~='' then redis.call('SET',media,ARGV[6]) end
if not bound and count+1==10 then redis.call('RPUSH',jobs,cjson.encode({kind='warning'})) end
return 'stored'
`;
const BIND = `
local prior=redis.call('HGET',KEYS[1],'binding')
if prior then local old=cjson.decode(prior);if old.serverId==ARGV[1] and old.humanKey==ARGV[2] then return prior end;return 'already_bound' end
local raw=redis.call('GET',KEYS[2]);if not raw then return 'server_unavailable' end
local actor=cjson.decode(raw).humans[ARGV[2]];if not actor then return 'identity_denied' end
if redis.call('SCARD',KEYS[3])>=256 then return 'server_unavailable' end
local binding=cjson.encode({serverId=ARGV[1],humanKey=ARGV[2],actorId=actor,source=ARGV[3],epoch=1,title=ARGV[4],generation=ARGV[5],nativeGroup=ARGV[6]=='native'})
redis.call('HDEL',KEYS[1],'retired');redis.call('HSET',KEYS[1],'binding',binding);redis.call('SADD',KEYS[3],ARGV[3]);return binding
`;

/** Shares the Relay's Redis connection and hash slot. No second queue authority. */
export class MirrorStore {
  constructor(redis) { this.redis = redis; this.prefix = redis.key('mirror:v1:'); this.cursor = '0'; this.typing=new TypingState(this); }
  async verifyDurability() {
    const clients=typeof this.redis.client.nodes==='function'?this.redis.client.nodes('master'):[this.redis.client];
    if(!clients.length)throw Error('Mirror Redis persistence is unavailable');
    for(const client of clients) {
      const policy=await client.call('CONFIG','GET','maxmemory-policy'),info=await client.call('INFO','persistence');
      if(policy?.[1]!=='noeviction'||!String(info).includes('aof_enabled:1\r\n')||!String(info).includes('aof_last_write_status:ok\r\n'))
        throw Error('Mirror Redis requires healthy AOF and noeviction');
    }
  }
  command(...args) { return this.redis.client.call(...args.map(String)); }
  eval(script, keys, args = []) { return this.command('EVAL', script, keys.length, ...keys, ...args); }
  keys(source) {
    const id = hash(source), root = this.prefix + 'room:' + id + ':';
    return { id, meta: root + 'meta', queue: root + 'queue', seen: root + 'seen', kept: root + 'kept', jobs: root + 'jobs', lock: root + 'delivery', noticeLock: root + 'notice' };
  }
  mediaKey(reference) {
    if (!/^mirror:[a-f0-9]{64}:[a-f0-9]{64}$/u.test(reference)) throw Error('invalid_media');
    return this.prefix + 'media:' + reference.slice(7);
  }
  /** Registered receiver capabilities; absent once the 90 s registration lapses. */
  async serverCapabilities(serverId) {
    const raw=await this.command('GET',this.prefix+'server:'+serverId);
    try { return raw?JSON.parse(raw):null; } catch { return null; }
  }
  /** First reply to a provider message finishes its placeholder stream; later parts get their own. */
  async claimStream(source,msgId) {
    const member=JSON.stringify([source,msgId]);
    const won=(await this.command('SET',this.prefix+'stream:'+hash(member),'1','NX','PX',86400000))==='OK';
    if(won)await this.command('ZREM',this.prefix+'placeholders',member);
    return won;
  }
  /** Remember an open placeholder so a stalled answer cannot leave it spinning past the provider window. */
  async trackPlaceholder(source,msgId,at=Date.now()) {
    await this.command('ZADD',this.prefix+'placeholders',at,JSON.stringify([source,msgId]));
  }
  /** Placeholders opened before cutoff; each is closed by whichever replica wins claimStream. */
  async stalePlaceholders(cutoff,limit=20) {
    const rows=await this.command('ZRANGEBYSCORE',this.prefix+'placeholders','-inf',cutoff,'LIMIT',0,limit);
    return rows.flatMap(row=>{try{const [source,msgId]=JSON.parse(row);return typeof source==='string'&&typeof msgId==='string'?[{source,msgId,member:row}]:[];}catch{return [];}});
  }
  async dropPlaceholder(member) { await this.command('ZREM',this.prefix+'placeholders',member); }
  /** Card definitions by task id, kept for the provider's one-day interaction window. */
  async submitCard(source,taskId,author,answer,close=false,now=Date.now(),closeReason='manual') {
    if(!['manual','deadline'].includes(closeReason))throw Error('Invalid close reason');
    const key=this.prefix+'card-submissions:'+hash(JSON.stringify([source,taskId]));
    const raw=await this.eval(`local closed=redis.call('HGET',KEYS[1],'_closed');local accepted=false
local raw=redis.call('GET',KEYS[2]);local card=raw and cjson.decode(raw)
if not closed and card and card.deadlineAt and tonumber(ARGV[4])>=tonumber(card.deadlineAt) then redis.call('HSET',KEYS[1],'_closed','1');redis.call('SET',KEYS[4],'deadline','PX',604800000);closed='1' end
if ARGV[3]=='1' then
 redis.call('HSET',KEYS[1],'_closed','1');closed='1'
 if ARGV[5]=='manual' then redis.call('SET',KEYS[4],'manual','PX',604800000);redis.call('ZREM',KEYS[3],ARGV[6],ARGV[7])
 else redis.call('SET',KEYS[4],'deadline','NX','PX',604800000) end
end
if not closed and ARGV[2]~='' then
 if redis.call('HLEN',KEYS[1])>=512 and redis.call('HEXISTS',KEYS[1],ARGV[1])==0 then return redis.error_reply('too_many_answers') end
 redis.call('HSET',KEYS[1],ARGV[1],ARGV[2]);accepted=true
end
redis.call('PEXPIRE',KEYS[1],604800000)
local all=redis.call('HGETALL',KEYS[1]);local answers={}
for i=1,#all,2 do if all[i]~='_closed' then table.insert(answers,cjson.decode(all[i+1])) end end
return cjson.encode({closed=closed~=false,closedReason=redis.call('GET',KEYS[4]) or '',accepted=accepted,answers=answers})`,[key,this.prefix+'card:'+hash(JSON.stringify([source,taskId])),this.prefix+'interaction-schedule',key+':closed-reason'],[author,answer?JSON.stringify(answer):'',close?'1':'0',now,closeReason,JSON.stringify({source,taskId,kind:'close'}),JSON.stringify({source,taskId,kind:'remind'})]);
    const state=JSON.parse(raw);if(!Array.isArray(state.answers))state.answers=[];return state;
  }
  /** Due work stays in Redis until acknowledged; replicas fence each attempt. */
  async scheduleInteraction(source,taskId,deadlineAt,reminderAt) {
    const jobs=[{source,taskId,kind:'close',at:deadlineAt},...(reminderAt?[{source,taskId,kind:'remind',at:reminderAt}]:[])];
    await this.eval(`if redis.call('ZCARD',KEYS[1])+#ARGV/2>16384 then return redis.error_reply('too_many_scheduled_interactions') end
for i=1,#ARGV,2 do redis.call('ZADD',KEYS[1],'NX',ARGV[i],ARGV[i+1]) end;return 1`,
      [this.prefix+'interaction-schedule'],jobs.flatMap(j=>[j.at,JSON.stringify({source:j.source,taskId:j.taskId,kind:j.kind})]));
  }
  async dueInteractions(now=Date.now(),limit=20) {
    const values=await this.command('ZRANGEBYSCORE',this.prefix+'interaction-schedule','-inf',now,'LIMIT',0,limit);
    return values.map(member=>({...JSON.parse(member),member}));
  }
  async finishInteractionSchedule(member) { await this.command('ZREM',this.prefix+'interaction-schedule',member); }
  async retire(source,serverId,requestId) {
    const k=this.keys(source);
    return this.eval(`local b=redis.call('HGET',KEYS[1],'binding');if not b or cjson.decode(b).serverId~=ARGV[1] then return 0 end
local queued=redis.call('LRANGE',KEYS[5],0,-1)
for _,raw in ipairs(queued) do local e=cjson.decode(raw);if type(e.mediaId)=='string' and string.sub(e.mediaId,1,7)=='mirror:' then redis.call('DEL',ARGV[5]..string.sub(e.mediaId,8)) end end
redis.call('SET',KEYS[4],ARGV[3],'PX',604800000);redis.call('SREM',KEYS[2],ARGV[2]);redis.call('HDEL',KEYS[1],'binding','channelId');redis.call('DEL',KEYS[5],KEYS[6],KEYS[7],KEYS[8]);redis.call('HSET',KEYS[1],'bytes',0,'retired','1');redis.call('ZREM',KEYS[3],ARGV[4]);return 1`,
      [k.meta,this.prefix+'bound:'+serverId,this.prefix+'work',this.prefix+'retired:'+hash(JSON.stringify([source,serverId,requestId])),k.queue,k.jobs,k.lock,k.noticeLock],
      [serverId,source,requestId,k.id,this.prefix+'media:']);
  }
  async retirement(source,serverId,requestId) {
    return (await this.command('EXISTS',this.prefix+'retired:'+hash(JSON.stringify([source,serverId,requestId]))))===1;
  }
  async rememberShortcut(source,key,action) {
    await this.command('SET',this.prefix+'shortcut:'+hash(JSON.stringify([source,key])),JSON.stringify(action),'PX',7*86400000);
  }
  async shortcut(source,key) {
    const raw=await this.command('GET',this.prefix+'shortcut:'+hash(JSON.stringify([source,key])));return raw?JSON.parse(raw):null;
  }
  async rememberCard(source,taskId,card) {
    await this.command('SET',this.prefix+'card:'+hash(JSON.stringify([source,taskId])),JSON.stringify(card),'PX',7*86400000);
  }
  async card(source,taskId) {
    const raw=await this.command('GET',this.prefix+'card:'+hash(JSON.stringify([source,taskId])));
    try { return raw?JSON.parse(raw):null; } catch { return null; }
  }
  /** One answer per event: the provider never retries card events, but replicas may race on a duplicate. */
  async claimCardEvent(source,eventId) {
    return (await this.command('SET',this.prefix+'card-event:'+hash(JSON.stringify([source,eventId])),'1','NX','PX',86400000))==='OK';
  }
  /** Who sent a mention: the requester is the only accepted answerer of its choice card. */
  async rememberMention(source,msgId,author) {
    await this.command('SET',this.prefix+'mention:'+hash(JSON.stringify([source,msgId])),author,'PX',7*86400000);
  }
  /** True the first time a key is claimed within ms. */
  async claimOnce(key,ms) {
    return (await this.command('SET',this.prefix+'once:'+hash(key),'1','NX','PX',ms))==='OK';
  }
  async allowEveryone(source,msgId) {
    await this.command('SET',this.prefix+'everyone:'+hash(JSON.stringify([source,msgId])),'1','PX',86400000);
  }
  async everyoneAllowed(source,msgId) {
    return (await this.command('EXISTS',this.prefix+'everyone:'+hash(JSON.stringify([source,msgId]))))===1;
  }
  /** True for the first @all in a group within the cooldown. */
  async claimEveryone(source,ms) {
    return (await this.command('SET',this.prefix+'everyone-cooldown:'+hash(source),'1','NX','PX',ms))==='OK';
  }
  async mentionAuthor(source,msgId) {
    return this.command('GET',this.prefix+'mention:'+hash(JSON.stringify([source,msgId])));
  }
  /** Conversation window: after an @ (or an assistant answer) the same person can follow up without @. */
  windowKey(source,author) { return this.prefix+'window:'+hash(JSON.stringify([source,author])); }
  async openWindow(source,author,ms) { await this.command('SET',this.windowKey(source,author),'1','PX',ms); }
  async windowOpen(source,author) { return (await this.command('EXISTS',this.windowKey(source,author)))===1; }
  /** Freeze admission across media download failures, window expiry and callback retries. */
  async followUpDecision(source,id,author) {
    const key=this.prefix+'follow-ups:'+hash(source),field=hash(JSON.stringify([id,author]));
    return Number(await this.eval(`local prior=redis.call('HGET',KEYS[1],ARGV[1]);if prior then return tonumber(prior) end
local yes=redis.call('EXISTS',KEYS[3]);redis.call('HSET',KEYS[1],ARGV[1],yes);redis.call('ZADD',KEYS[2],ARGV[2],ARGV[1])
local old=redis.call('ZRANGE',KEYS[2],0,-4097);for _,f in ipairs(old) do redis.call('HDEL',KEYS[1],f);redis.call('ZREM',KEYS[2],f) end
old=redis.call('ZRANGEBYSCORE',KEYS[2],'-inf',tonumber(ARGV[2])-604800000,'LIMIT',0,64);for _,f in ipairs(old) do redis.call('HDEL',KEYS[1],f);redis.call('ZREM',KEYS[2],f) end
redis.call('PEXPIRE',KEYS[1],604800000);redis.call('PEXPIRE',KEYS[2],604800000);return yes`,
      [key,key+':order',this.windowKey(source,author)],[field,Date.now()]))===1;
  }
  /** Whether an answer already took over this message's stream (without claiming it). */
  async streamClaimed(source,msgId) {
    return (await this.command('EXISTS',this.prefix+'stream:'+hash(JSON.stringify([source,msgId]))))===1;
  }
  /** First answer wins for a card; later clicks see the recorded answer. Returns [won, answer]. */
  async answerCard(source,taskId,answer) {
    const key=this.prefix+'card-answer:'+hash(JSON.stringify([source,taskId]));
    if((await this.command('SET',key,JSON.stringify(answer),'NX','PX',7*86400000))==='OK')return [true,answer];
    try { return [false,JSON.parse(await this.command('GET',key))]; } catch { return [false,answer]; }
  }
  async register(serverId, name, humans, recording = false, streamReplies = false) {
    if (!text(serverId,128) || !text(name,128) || !humans || typeof humans !== 'object' || Array.isArray(humans)
      || Object.keys(humans).length > 5000 || Object.entries(humans).some(([key, actor]) => !/^[a-f0-9]{64}$/u.test(key) || !text(actor,512))) throw Error('invalid_directory');
    const now=Date.now();
    await this.eval(`
redis.call('SET',KEYS[1],ARGV[1],'PX',90000);redis.call('ZADD',KEYS[2],ARGV[2],ARGV[3]);redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',ARGV[4])
for i=3,#KEYS do
 local prior=redis.call('HGET',KEYS[i],ARGV[3]);local first=tonumber(ARGV[4]);local last=0
 if prior then local record=cjson.decode(prior);first=record.firstConfirmedAt;last=record.lastConfirmedAt end
 if tonumber(ARGV[4])-last>=30000 then redis.call('HSET',KEYS[i],ARGV[3],cjson.encode({id=ARGV[3],name=ARGV[5],firstConfirmedAt=first,lastConfirmedAt=tonumber(ARGV[4])})) end
end
return 1`,
      [this.prefix+'server:'+serverId,this.prefix+'servers',...Object.keys(humans).map(human=>this.prefix+'participation:'+human)],
      [JSON.stringify({id:serverId,name,humans,recording,...(streamReplies?{streamReplies:true}:{})}),now+90000,serverId,now,name]);
  }
  /** Receiver-owned native location, projected only onto that receiver's bound rooms. */
  async registerChannels(serverId, channels) {
    if (!text(serverId,128) || !Array.isArray(channels) || channels.length>256
      || channels.some(c=>!c || !text(c.source,512) || !/^group:[a-f0-9-]{36}$/u.test(c.channelId))) throw Error('invalid_channels');
    if (!channels.length) return;
    await this.eval(`
for i,key in ipairs(KEYS) do
 local raw=redis.call('HGET',key,'binding')
 if raw and cjson.decode(raw).serverId==ARGV[1] then redis.call('HSETNX',key,'channelId',ARGV[i+1]) end
end
return 1`,channels.map(c=>this.keys(c.source).meta),[serverId,...channels.map(c=>c.channelId)]);
  }
  async recordingServers() {
    const ids = await this.command('ZRANGEBYSCORE', this.prefix+'servers', Date.now(), '+inf', 'LIMIT', 0, 256);
    if (!ids.length) return [];
    return (await this.command('MGET', ...ids.map(id => this.prefix+'server:'+id))).filter(Boolean).map(JSON.parse)
      .filter(server => server.recording === true).map(({id,name}) => ({id,name}));
  }
  async beginSelection(source, userId) {
    if (!text(source,512) || !text(userId,128)) throw Error('invalid_selection');
    const ticket = randomBytes(32).toString('base64url');
    await this.command('SET', this.prefix+'selection:'+hash(ticket), JSON.stringify({source,userId}), 'PX', 900000);
    return ticket;
  }
  async selection(ticket) {
    if (!/^[-_A-Za-z0-9]{43}$/u.test(ticket)) return null;
    const raw = await this.command('GET', this.prefix+'selection:'+hash(ticket));
    return raw ? JSON.parse(raw) : null;
  }
  async candidates(human) {
    if (!/^[a-f0-9]{64}$/u.test(human)) throw Error('invalid_human');
    const ids = await this.command('ZRANGEBYSCORE', this.prefix+'servers', Date.now(), '+inf', 'LIMIT', 0, 256);
    if (!ids.length) return [];
    const rows = await this.command('MGET', ...ids.map(id => this.prefix+'server:'+id));
    return rows.filter(Boolean).map(JSON.parse).filter(server => Object.hasOwn(server.humans,human)).map(server => ({id:server.id,name:server.name}));
  }
  async participation(human) {
    const available=await this.candidates(human);
    const records=(await this.command('HVALS',this.prefix+'participation:'+human)).map(JSON.parse);
    const byId=new Map(records.map(record=>[record.id,record]));
    return {available:available.map(server=>({...server,...(byId.get(server.id)??{}),name:server.name})).sort((a,b)=>(b.lastConfirmedAt??0)-(a.lastConfirmedAt??0))};
  }
  async control(event, job) {
    if (!event || !text(event.source,512) || !text(event.id,256) || !job) throw Error('invalid_event');
    const k=this.keys(event.source),now=Date.now();
    return this.eval(`
if redis.call('ZSCORE',KEYS[3],ARGV[1]) then return 'duplicate' end
if (redis.call('EXISTS',KEYS[1])==0 and redis.call('ZCARD',KEYS[4])>=8192) or redis.call('LLEN',KEYS[2])>=256 then return 'busy' end
redis.call('HSETNX',KEYS[1],'source',ARGV[2]);redis.call('RPUSH',KEYS[2],ARGV[3]);redis.call('ZADD',KEYS[4],ARGV[4],ARGV[5])
redis.call('ZADD',KEYS[3],ARGV[4],ARGV[1]);redis.call('ZREMRANGEBYSCORE',KEYS[3],'-inf',tonumber(ARGV[4])-604800000);redis.call('ZREMRANGEBYRANK',KEYS[3],0,-4097)
return 'stored'`,[k.meta,k.jobs,k.seen,this.prefix+'work'],[event.id,event.source,JSON.stringify(job),now,k.id]).then(result=>{if(result==='busy')throw Error('busy');return result;});
  }
  async ingest(event, bytes, job, typing) {
    if (!event || !text(event.source,512) || !text(event.id,256) || !text(event.author,256) || typeof event.text !== 'string' || event.text.length>16384
      || !Number.isSafeInteger(event.at) || event.at<0 || (event.mediaId !== undefined && !text(event.mediaId,512))) throw Error('invalid_event');
    if (bytes && (!(bytes instanceof Uint8Array) || bytes.length>2097152)) throw Error('invalid_media');
    const original = JSON.stringify(event), fingerprint = hash(JSON.stringify(forwardedEnvelopeIdentity(event))), k = this.keys(event.source);
    const reference = 'mirror:'+k.id+':'+hash(event.id);
    const stored = { ...event, ...(bytes ? {mediaId:reference,mediaIdentity:event.mediaId} : {}) };
    const value = JSON.stringify(stored), media = bytes ? Buffer.from(bytes).toString('base64') : '';
    const presentation=this.typing.admission(event,typing);
    const result = await this.eval(INGEST,[k.meta,k.queue,k.seen,k.kept,this.prefix+'work',k.jobs,this.mediaKey(reference),...presentation.keys],
      [value,Date.now(),k.id,fingerprint,job ? JSON.stringify(job) : '',media,Buffer.byteLength(value)+Buffer.byteLength(media),...presentation.args]);
    if (result==='busy' || result==='conflict') throw Error(result);
    return result;
  }
  async bind(source,human,serverId,title,nativeGroup=false) {
    const k=this.keys(source);
    const raw=await this.eval(BIND,[k.meta,this.prefix+'server:'+serverId,this.prefix+'bound:'+serverId],[serverId,human,source,title,randomUUID(),nativeGroup?'native':'']);
    if (!raw.startsWith('{')) throw Error(raw);
    return JSON.parse(raw);
  }
  async snapshot(source) {
    const k=this.keys(source), raw=await this.command('HGETALL',k.meta), meta={};
    for(let i=0;i<raw.length;i+=2) meta[raw[i]]=raw[i+1];
    return {binding:meta.binding ? JSON.parse(meta.binding) : null,count:Number(await this.command('LLEN',k.queue)),dropped:Number(meta.dropped??0),lastDeliveredAt:Number(meta.lastDeliveredAt??0),channelId:meta.channelId??null};
  }
  async work() {
    const scan=await this.command('ZSCAN',this.prefix+'work',this.cursor,'COUNT',64);
    this.cursor=scan[0];const sources=[];
    for(let i=0;i<scan[1].length;i+=2) {
      const source=await this.command('HGET',this.prefix+'room:'+scan[1][i]+':meta','source');
      if(source) sources.push(source);
    }
    return sources;
  }
  async claim(source,notice=false) {
    const key=this.keys(source)[notice?'noticeLock':'lock'],token=randomUUID();
    return await this.command('SET',key,token,'NX','PX',30000)==='OK' ? token : null;
  }
  async head(source,token,notice=false) {
    const k=this.keys(source);
    const raw=await this.eval(`if redis.call('GET',KEYS[1])~=ARGV[1] then return false end;redis.call('PEXPIRE',KEYS[1],30000);return redis.call('LINDEX',KEYS[2],0)`,[notice?k.noticeLock:k.lock,notice?k.jobs:k.queue],[token]);
    return raw ? JSON.parse(raw) : null;
  }
  async notice(source,token,text) {
    const k=this.keys(source);
    return Number(await this.eval(`if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('LLEN',KEYS[2])==0 then return 0 end;redis.call('LSET',KEYS[2],0,ARGV[2]);return 1`,[k.noticeLock,k.jobs],[token,JSON.stringify({kind:'reply',text})]))===1;
  }
  async ack(source,token,eventId,notice=false) {
    const k=this.keys(source);
    if(notice) return Number(await this.eval(`if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end;redis.call('LPOP',KEYS[2]);return 1`,[k.noticeLock,k.jobs],[token]))===1;
    const reference='mirror:'+k.id+':'+hash(eventId);
    return Number(await this.eval(`
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
local raw=redis.call('LINDEX',KEYS[2],0);if not raw or cjson.decode(raw).id~=ARGV[2] then return 0 end
local bytes=redis.call('STRLEN',KEYS[5]);redis.call('LPOP',KEYS[2]);redis.call('HDEL',KEYS[3],ARGV[2]);redis.call('DEL',KEYS[5]);redis.call('HINCRBY',KEYS[4],'bytes',-string.len(raw)-bytes);redis.call('HSET',KEYS[4],'lastDeliveredAt',ARGV[3]);return 1`,[k.lock,k.queue,k.kept,k.meta,this.mediaKey(reference)],[token,eventId,Date.now()]))===1;
  }
  async release(source,token,notice=false) {
    const k=this.keys(source);
    return this.eval(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`,[notice?k.noticeLock:k.lock],[token]);
  }
  async media(reference) { const raw=await this.command('GET',this.mediaKey(reference));if(!raw)throw Error('media_unavailable');return Buffer.from(raw,'base64'); }
  async mediaSource(reference) { this.mediaKey(reference);return this.command('HGET',this.prefix+'room:'+reference.split(':')[1]+':meta','source'); }
  async beginLink(serverId, actorId, generation) {
    if(!text(actorId,512)||!Number.isSafeInteger(generation))throw Error('invalid_link');
    const code=randomUUID().replaceAll('-','').slice(0,16);
    await this.command('SET',this.prefix+'link-code:'+code,JSON.stringify({serverId,actorId,generation}),'PX',600000);
    return {code,expiresAt:Date.now()+600000};
  }
  async attachLink(code,source,userId,expectedServer) {
    if(!/^[a-f0-9]{16}$/u.test(code))return false;
    const id=hash(code),attachedKey=this.prefix+'link-attached:'+id;
    const proof=JSON.stringify({source,userId,...(expectedServer?{serverId:expectedServer}:{})});
    if(await this.command('GET',attachedKey)===proof)return true;
    const value=await this.command('GET',this.prefix+'link-code:'+code);if(!value)return false;
    const link=JSON.parse(value);
    if(expectedServer && link.serverId!==expectedServer)return false;
    const attached=await this.eval(`if redis.call('GET',KEYS[4])==ARGV[5] then return 1 end;if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end;redis.call('SET',KEYS[2],ARGV[2],'PX',600000);redis.call('SET',KEYS[4],ARGV[5],'PX',600000);redis.call('ZADD',KEYS[3],ARGV[3],ARGV[4]);redis.call('DEL',KEYS[1]);return 1`,
      [this.prefix+'link-code:'+code,this.prefix+'link-job:'+id,this.prefix+'links:'+link.serverId,attachedKey],[value,JSON.stringify({...link,id,source,userId,silent:!!expectedServer}),Date.now()+600000,id,proof]);
    return Number(attached)===1;
  }
  async links(serverId) {
    const key=this.prefix+'links:'+serverId;
    await this.command('ZREMRANGEBYSCORE',key,'-inf',Date.now());
    const ids=await this.command('ZRANGE',key,0,7);if(!ids.length)return [];
    return (await this.command('MGET',...ids.map(id=>this.prefix+'link-job:'+id))).filter(Boolean).map(JSON.parse);
  }
  async completeLink(serverId,id,linked) {
    if(!/^[a-f0-9]{64}$/u.test(id))throw Error('invalid_link');
    const raw=await this.command('GET',this.prefix+'link-job:'+id);if(!raw)return;
    const job=JSON.parse(raw);if(job.serverId!==serverId)throw Error('denied');
    const k=this.keys(job.source);
    await this.eval(`if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end;if ARGV[3]~='' then redis.call('RPUSH',KEYS[3],ARGV[3]) end;redis.call('ZREM',KEYS[2],ARGV[2]);redis.call('DEL',KEYS[1]);return 1`,
      [this.prefix+'link-job:'+id,this.prefix+'links:'+serverId,k.jobs],[raw,id,job.silent?'':JSON.stringify({kind:'reply',text:linked?'身份已关联。发送“@机器人 服务器”选择本群保存位置。':'身份关联未完成，请回到服务器重新获取关联码。'})]);
  }

}
