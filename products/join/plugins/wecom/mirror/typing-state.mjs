import {createHash,randomUUID} from 'node:crypto';
const hash=v=>createHash('sha256').update(v).digest('hex');
/** Cosmetic state only, atomically admitted with the existing Redis ingress. No task/history authority. */
export const TYPING_INGEST=`
if bound and event.mentioned==true and ARGV[5]=='' and ARGV[8]~='' then
 local binding=cjson.decode(redis.call('HGET',meta,'binding'))
 local raw=redis.call('GET',KEYS[8]);local state=raw and cjson.decode(raw)
 if state and state.generation~=binding.generation then state=nil end
 if state or redis.call('ZCARD',KEYS[9])<16384 then
  if not state then state={id=event.id,source=event.source,author=event.author,member=ARGV[9],human=ARGV[10],serverId=binding.serverId,generation=binding.generation,createdAt=now,dueAt=now+tonumber(ARGV[8])} end
  if ARGV[11]=='1' then
   -- At most one unfinished predecessor: no new open is allowed until it closes.
   if state.anchor then state.retiring={anchor=state.anchor,openedAt=state.openedAt or now} end
   state.id=event.id;state.createdAt=now;state.dueAt=now+tonumber(ARGV[8])
   state.anchor=nil;state.openedAt=nil;state.settled=nil
   if state.retiring and state.retiring.closing then state.dueAt=state.retiring.openedAt+480000 end
  end
  state.latestId=event.id
  redis.call('SET',KEYS[8],cjson.encode(state),'PX',86400000)
  redis.call('ZADD',KEYS[9],state.dueAt,ARGV[9])
  redis.call('SET',KEYS[10],cjson.encode({member=ARGV[9],id=state.id}),'PX',86400000)
 end
 redis.call('SET',KEYS[11],event.author,'PX',604800000)
end
`;
export class TypingState {
 constructor(store){this.store=store;this.prefix=store.prefix+'typing:v1:';}
 member(source,author){return JSON.stringify([source,author]);}
 key(member){return this.prefix+hash(member);}
 admission(event,options){
  const member=this.member(event.source,event.author),ref=this.prefix+'message:'+hash(JSON.stringify([event.source,event.id]));
  return {keys:[this.key(member),this.prefix+'due',ref,this.store.prefix+'mention:'+hash(JSON.stringify([event.source,event.id]))],args:[options?.delay===undefined?'':options.delay,member,options?.human??'',options?.replace===true?'1':'0']};
 }
 async context(source,id){const raw=await this.store.command('GET',this.prefix+'message:'+hash(JSON.stringify([source,id])));return raw?JSON.parse(raw):null;}
 async due(now,limit=20){return this.store.command('ZRANGEBYSCORE',this.prefix+'due','-inf',now,'LIMIT',0,limit);}
 async read(member){const raw=await this.store.command('GET',this.key(member));return raw?JSON.parse(raw):null;}
 async lock(member){const token=randomUUID();return await this.store.command('SET',this.key(member)+':lock',token,'NX','PX',15000)==='OK'?token:null;}
 async release(member,token){await this.store.eval(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end;return 0`,[this.key(member)+':lock'],[token]);}
 /** All presentation writes are lease fenced. Ingress can supersede the turn, but cannot erase an unfinished predecessor or its close intent. */
 async change(member,token,operation,now=Date.now(),timeout=0,id='',anchor=''){
  const raw=await this.store.eval(`
if redis.call('GET',KEYS[1])~=ARGV[1] then return '' end
local raw=redis.call('GET',KEYS[2]);local s=raw and cjson.decode(raw)
if not s then redis.call('ZREM',KEYS[3],ARGV[2]);return '' end
if ARGV[6]~='' and s.id~=ARGV[6] then return '' end
if ARGV[3]=='take' then
 if s.retiring then s.settled=true;s.anchor=nil;s.openedAt=nil
 else redis.call('DEL',KEYS[2]);redis.call('ZREM',KEYS[3],ARGV[2]);return raw end
elseif ARGV[3]=='discard' then redis.call('DEL',KEYS[2]);redis.call('ZREM',KEYS[3],ARGV[2]);return raw
elseif ARGV[3]=='retire' then
 if not s.retiring or s.retiring.closing then return '' end
 s.retiring.closing=true;s.dueAt=s.retiring.openedAt+tonumber(ARGV[5])
elseif ARGV[3]=='retired' then
 if not s.retiring or s.retiring.anchor~=ARGV[7] then return '' end
 s.retiring=nil;s.dueAt=tonumber(ARGV[4])
elseif ARGV[3]=='open' then
 if s.anchor or s.retiring or s.settled then return '' end
 s.anchor=s.latestId;s.openedAt=tonumber(ARGV[4]);s.dueAt=tonumber(ARGV[4])+tonumber(ARGV[5])
else s.dueAt=tonumber(ARGV[4])+tonumber(ARGV[5]) end
redis.call('SET',KEYS[2],cjson.encode(s),'PX',86400000);redis.call('ZADD',KEYS[3],s.dueAt,ARGV[2]);return cjson.encode(s)`,
   [this.key(member)+':lock',this.key(member),this.prefix+'due'],[token,member,operation,now,timeout,id,anchor]);
  return raw?JSON.parse(raw):null;
 }
 async owns(member,token){return await this.store.command('GET',this.key(member)+':lock')===token;}
}
