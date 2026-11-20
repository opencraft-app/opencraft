import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ActorContext, Actor } from '@opencraft/identity-core/actors';
import type { PersonalAssistant, PersonalAssistantAccess } from '@opencraft/appserver-protocol';
import type { Collaboration } from './collaboration.js';

type Row = Record<string, unknown>;
const prefix = 'opencraft/personal-assistant/';
function fail(code = 'personal_assistant_denied', status = 403): never { throw Object.assign(Error(code), { code, status }); }
function fields(p: Record<string, unknown>, keys: string[]) {
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !keys.includes(k))) fail('invalid_input',400);
}
function bounded(value: unknown): string {
  if(typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f]/u.test(value)) fail('invalid_input',400);
  return value;
}

/** Storage-owner operations, called within the existing communication transaction.
 * Desktop and headless use this same authority; transport never supplies an owner. */
export class PersonalAssistants {
  constructor(private readonly service: Collaboration, private readonly db: DatabaseSync) {}
  /** Trusted installation Host inventory; never available through public RPC. */
  assignments(after = '') {
    const rows = this.db.prepare("SELECT p.* FROM personal_assistants p JOIN actors a ON a.id=p.owner_human_id WHERE p.state='claimed' AND p.paused=0 AND a.enabled=1 AND a.generation=p.owner_generation AND p.bot_id>? ORDER BY p.bot_id LIMIT 100").all(after);
    return {items:rows.filter(r=>this.service.admittedActor(String(r.owner_human_id)) && this.service.actors.get(String(r.actor_id))?.enabled && this.service.admittedActor(String(r.actor_id))).map(r=>({assistant:this.value(r),epoch:String(r.epoch),context:{actorId:String(r.owner_human_id),generation:Number(r.owner_generation),credentialId:null,expiresAt:this.service.now()+60_000}})),next:rows.length===100?String(rows.at(-1)!.bot_id):null};
  }
  /** Only the claimed Human/Bot pair can exchange personal messages. This grants no execution rights. */
  canMessage(c: ActorContext, target: string): boolean {
    if(!this.service.actors.isCurrent(c))return false;
    const r=this.db.prepare("SELECT * FROM personal_assistants WHERE state='claimed' AND ((owner_human_id=? AND actor_id=?) OR (actor_id=? AND owner_human_id=?))").get(c.actorId,target,c.actorId,target);
    if(!r)return false;
    const owner=this.service.actors.get(String(r.owner_human_id));
    return this.service.admittedActor(String(r.actor_id)) && !!this.service.actors.get(String(r.actor_id))?.enabled && !!owner?.enabled && owner.generation===r.owner_generation && this.service.admittedActor(owner.id)
      && (c.actorId===owner.id || c.credentialId===r.credential_id);
  }
  ownMessages(c: ActorContext, p: Record<string, unknown>) {
    fields(p,['after']);const r=this.row(c);
    if(!Number.isSafeInteger(p.after)||Number(p.after)<0)fail('invalid_input',400);
    // A message that opened crew work reaches the Bot through crew intake; the runtime skips it here
    // but still advances its cursor past it.
    const crew=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='crew_work'").get();
    return this.service.messages(c,String(r.owner_human_id),Number(p.after),50).map(row=>({...row,
      crewWork: crew&&!!this.db.prepare('SELECT 1 FROM crew_work WHERE message_id=?').get(String(row.id)),
      attachment: this.db.prepare('SELECT name,mime AS type,length(bytes) AS size FROM actor_channel_attachments WHERE message_id=?').get(String(row.id)) ?? null,
    }));
  }
  attachment(c:ActorContext,p:Record<string,unknown>){
    fields(p,['messageId','offset']);const r=this.row(c),id=bounded(p.messageId);
    const offset=p.offset??0;if(!Number.isSafeInteger(offset)||Number(offset)<0||Number(offset)>8*1024*1024)fail('invalid_input',400);
    const message=this.db.prepare('SELECT * FROM actor_messages WHERE id=? AND author_id=? AND target_id=?').get(id,String(r.owner_human_id),c.actorId);
    if(!message)fail();
    const file=this.db.prepare('SELECT name,mime AS type,length(bytes) AS size,substr(bytes,?,65536) AS bytes FROM actor_channel_attachments WHERE message_id=?').get(Number(offset)+1,id);
    if(file&&Number(offset)>Number(file.size))fail('invalid_input',400);
    return file ? {name:file.name,type:file.type,size:file.size,next:Number(offset)+65536<Number(file.size)?Number(offset)+65536:null,base64:Buffer.from(file.bytes as Uint8Array).toString('base64')} : null;
  }
  reply(c: ActorContext, p: Record<string, unknown>) {
    fields(p,['id','text']);const r=this.row(c);
    return this.service.send(c,{targetActorId:r.owner_human_id,content:p.text,idempotencyKey:p.id});
  }
  private human(c: ActorContext) {
    if (!this.service.actors.isCurrent(c) || !this.service.admittedActor(c.actorId)
      || this.service.actors.get(c.actorId)?.kind !== 'human') fail();
  }
  /** Trusted Host only, never exposed by the public method allowlist. */
  provision(c: ActorContext, botId?: unknown) {
    this.human(c);
    const r=this.owned(c,botId);
    if(!r || r.paused || r.state!=='claimed' || r.owner_generation!==c.generation)fail();
    const credential=this.service.actors.issueCredential(String(r.actor_id),this.service.now()+86_400_000,c.actorId);
    this.db.prepare('UPDATE personal_assistants SET credential_id=? WHERE bot_id=?').run(credential.credentialId,String(r.bot_id));
    this.audit(c,r,'credential');
    return {assistant:this.value(r),credential};
  }
  /** Pair authority is part of directory state even when the channel already exists. */
  private notifyPair(r: Row) {
    for (const channel of this.db.prepare('SELECT id FROM actor_channels WHERE (owner_id=? AND peer_id=?) OR (owner_id=? AND peer_id=?)')
      .all(String(r.owner_human_id),String(r.actor_id),String(r.actor_id),String(r.owner_human_id))) this.service.channels.changed({channelId:String(channel.id),directory:true});
  }
  private value(r: Row): PersonalAssistant {
    return {name:this.service.actors.get(String(r.actor_id))?.displayName??'Assistant',duties:String(r.duties??''),isDefault:r.is_default!==0,paused:!!r.paused||r.state!=='claimed'||this.service.actors.get(String(r.owner_human_id))?.generation!==r.owner_generation,configRevision:Number(r.config_revision??0),environment:JSON.parse(String(r.environment_json??'{"kind":"local"}')), binding: {serverId:this.service.actors.authority,botId:String(r.bot_id),assignmentId:String(r.assignment_id),
      owner:{kind:'human',id:String(r.owner_human_id)}}, actorId:String(r.actor_id),state:(this.service.actors.get(String(r.owner_human_id))?.generation===r.owner_generation?r.state:'revoked') as PersonalAssistant['state'],createdAt:Number(r.created_at),
      model:r.model_selection ? JSON.parse(String(r.model_selection)) : null, modelRevision:Number(r.model_revision ?? 0) };
  }
  modelAuthority(c: ActorContext, botId?: unknown) {
    this.human(c);
    const row=this.owned(c,botId);
    if(!row || row.state!=='claimed' || row.owner_generation!==c.generation)fail();
    return {assistant:this.value(row),epoch:String(row.epoch)};
  }
  setModel(c: ActorContext, p: Record<string,unknown>) {
    fields(p,['botId','model','expectedRevision','epoch']);
    const current=this.modelAuthority(c,p.botId);
    if(current.epoch!==p.epoch)fail();
    if(!Number.isSafeInteger(p.expectedRevision)||Number(p.expectedRevision)<0)fail('invalid_input',400);
    if(current.assistant.modelRevision!==p.expectedRevision)fail('assistant_model_conflict',409);
    const model=p.model as Record<string,unknown>;fields(model,['providerId','modelId']);
    const value={providerId:bounded(model.providerId),modelId:bounded(model.modelId)};
    this.db.prepare('UPDATE personal_assistants SET model_selection=?,model_revision=model_revision+1 WHERE bot_id=?')
      .run(JSON.stringify(value),current.assistant.binding.botId);
    const row=this.db.prepare('SELECT * FROM personal_assistants WHERE bot_id=?').get(current.assistant.binding.botId)!;
    this.audit(c,row,'model');return {assistant:this.value(row)};
  }
  private audit(c: ActorContext, r: Row, action: string, source: string | null = null) {
    this.db.prepare('INSERT INTO actor_collaboration_audit(id,action,actor_id,resource_id,detail,happened_at) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(),'personal-assistant.'+action,c.actorId,String(r.bot_id),JSON.stringify({ownerHumanId:r.owner_human_id,epoch:r.epoch,source}),this.service.now());
  }
  private row(c: ActorContext): Row {
    if (!this.service.actors.isCurrent(c) || !this.service.admittedActor(c.actorId)
      || this.service.actors.get(c.actorId)?.kind !== 'session') fail();
    const r = this.db.prepare('SELECT * FROM personal_assistants WHERE actor_id=?').get(c.actorId);
    const owner = r && this.service.actors.get(String(r.owner_human_id));
    if (!r || r.paused || r.state !== 'claimed' || r.credential_id!==c.credentialId || !owner?.enabled || owner.kind !== 'human' || owner.generation !== r.owner_generation
      || !this.service.admittedActor(owner.id)) fail();
    return r;
  }
  private access(c: ActorContext, r: Row): PersonalAssistantAccess {
    return {binding:this.value(r).binding,epoch:String(r.epoch),expiresAt:Math.min(c.expiresAt,this.service.now()+15_000)};
  }
  /** Narrow internal read projection. Not a public wire method or a generic impersonation port. */
  readAuthority(c: ActorContext) {
    const r=this.row(c),access=this.access(c,r);
    return {...access,context:{actorId:String(r.owner_human_id),generation:Number(r.owner_generation),credentialId:null,
      expiresAt:access.expiresAt} satisfies ActorContext};
  }
  finish(c: ActorContext, p: Record<string,unknown>) {
    fields(p,['epoch','operation','source']);
    const r=this.row(c);
    if(r.epoch!==p.epoch)fail();
    if(!['conversations.list','conversations.history'].includes(String(p.operation)))fail('invalid_input',400);
    this.audit(c,r,String(p.operation),p.source===undefined?null:bounded(p.source));
    return null;
  }
  groupGuard(c: ActorContext, method: string, p: Record<string,unknown>, result: any) {
    if(!method.startsWith(prefix+'groups/'))return undefined;
    const r=this.row(c), owner=String(r.owner_human_id);
    const ids=method.endsWith('/list')?result.groups.map((g:{id:string})=>g.id):[String(p.channelId)];
    return {epoch:String(r.epoch),groups:ids.map((id:string)=>({id,epoch:this.service.channels.memberEpoch(id,owner)}))};
  }
  checkGroups(c: ActorContext, guard: {epoch:string;groups:{id:string;epoch:string}[]}) {
    const r=this.row(c);
    if(r.epoch!==guard.epoch||guard.groups.some(g=>this.service.channels.memberEpoch(g.id,String(r.owner_human_id))!==g.epoch))fail();
    return null;
  }
  private owned(c:ActorContext,botId?:unknown):Row|undefined {
    this.human(c);
    return botId===undefined
      ?this.db.prepare('SELECT * FROM personal_assistants WHERE owner_human_id=? AND is_default=1').get(c.actorId)
      :this.db.prepare('SELECT * FROM personal_assistants WHERE owner_human_id=? AND bot_id=?').get(c.actorId,bounded(botId));
  }
  private status(r:Row|null){
    const channel=r?this.db.prepare('SELECT id FROM actor_channels WHERE owner_id=? AND peer_id=?').get(String(r.owner_human_id),String(r.actor_id)):null;
    return {assistant:r?this.value(r):null,channelId:channel?String(channel.id):null};
  }
  private environment(value:unknown){
    if(!value||typeof value!=='object'||Array.isArray(value))fail('invalid_input',400);
    const v=value as Record<string,unknown>;
    fields(v,v.kind==='local'?['kind']:['kind','backendId','templateId']);
    if(v.kind==='local')return {kind:'local'};
    if(v.kind!=='sandbox'||typeof v.backendId!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(v.backendId))fail('invalid_input',400);
    const templateId=bounded(v.templateId);if(!/^[a-zA-Z0-9_-]{1,128}$/u.test(templateId))fail('invalid_input',400);
    return {kind:'sandbox',backendId:v.backendId,templateId};
  }
  private botCommand(c:ActorContext,op:string,p:Record<string,unknown>,created:Actor[]){
    this.human(c);
    if(op==='bots/list'){
      fields(p,[]);return {bots:this.db.prepare('SELECT * FROM personal_assistants WHERE owner_human_id=? ORDER BY is_default DESC,created_at,bot_id').all(c.actorId).map(r=>this.status(r))};
    }
    if(op==='bots/create'){
      fields(p,['name','duties','environment','clientRequestId']);
      const name=bounded(p.name).trim();if(!name||name.length>80)fail('invalid_input',400);
      if(typeof p.duties!=='string'||p.duties.length>2000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(p.duties))fail('invalid_input',400);
      const environment=this.environment(p.environment),key=bounded(p.clientRequestId);
      const fingerprint=createHash('sha256').update(JSON.stringify([name,p.duties,environment])).digest('hex');
      const prior=this.db.prepare('SELECT * FROM personal_assistants WHERE owner_human_id=? AND create_key=?').get(c.actorId,key);
      if(prior){if(prior.create_fingerprint!==fingerprint||prior.owner_generation!==c.generation)fail('idempotency_key_reused',409);return this.status(prior);}
      if(Number(this.db.prepare('SELECT count(*) AS n FROM personal_assistants WHERE owner_human_id=?').get(c.actorId)!.n)>=32)fail('assistant_limit',409);
      const actor=this.service.actors.createSession(name,c.actorId);created.push(actor);
      const id=randomUUID();
      this.db.prepare("INSERT INTO personal_assistants(bot_id,actor_id,owner_human_id,owner_generation,assignment_id,epoch,state,created_at,is_default,duties,environment_json,create_key,create_fingerprint) VALUES(?,?,?,?,?,?,'claimed',?,0,?,?,?,?)")
        .run(id,actor.id,c.actorId,c.generation,randomUUID(),randomUUID(),this.service.now(),p.duties,JSON.stringify(environment),key,fingerprint);
      const row=this.owned(c,id)!;this.audit(c,row,'create');return this.status(row);
    }
    fields(p,op==='bots/update'?['botId','name','duties','environment','expectedRevision']:['botId','paused','expectedRevision']);
    const r=this.owned(c,bounded(p.botId));
    if(!r||op==='bots/update'&&(r.state!=='claimed'||r.owner_generation!==c.generation))fail();
    if(!Number.isSafeInteger(p.expectedRevision)||Number(p.expectedRevision)<0)fail('invalid_input',400);
    if(r.config_revision!==p.expectedRevision)fail('assistant_config_conflict',409);
    if(op==='bots/update'){
      const name=bounded(p.name).trim();if(!name||name.length>80||typeof p.duties!=='string'||p.duties.length>2000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(p.duties))fail('invalid_input',400);
      const environment=this.environment(p.environment);
      // Configuration is not a new identity. Fence old runners and delegated authority.
      this.service.actors.renameSession(String(r.actor_id),name,c.actorId);
      this.db.prepare('UPDATE personal_assistants SET duties=?,environment_json=?,config_revision=config_revision+1,epoch=?,credential_id=NULL WHERE bot_id=?')
        .run(p.duties,JSON.stringify(environment),randomUUID(),String(r.bot_id));
    }else{
      if(typeof p.paused!=='boolean')fail('invalid_input',400);
      if(!!r.paused===p.paused&&r.state==='claimed'&&r.owner_generation===c.generation)return this.status(r);
      this.db.prepare("UPDATE personal_assistants SET paused=?,state=CASE WHEN ?=0 THEN 'claimed' ELSE state END,owner_generation=CASE WHEN ?=0 THEN ? ELSE owner_generation END,config_revision=config_revision+1,epoch=?,credential_id=NULL WHERE bot_id=?").run(Number(p.paused),Number(p.paused),Number(p.paused),c.generation,randomUUID(),String(r.bot_id));
    }
    const retiredCredentials=this.db.prepare('SELECT id FROM actor_credentials WHERE actor_id=? AND enabled=1').all(String(r.actor_id)).map(v=>String(v.id));
    for(const id of retiredCredentials)this.service.actors.revokeCredential(id,c.actorId);
    const updated=this.owned(c,p.botId)!;this.audit(c,updated,op);this.notifyPair(updated);
    for(const channel of this.db.prepare('SELECT channel_id FROM actor_channel_members WHERE actor_id=?').all(String(r.actor_id)))this.service.channels.changed({channelId:String(channel.channel_id),directory:true});return {...this.status(updated),retiredCredentials};
  }
  command(c: ActorContext, method: string, p: Record<string, unknown>, created: Actor[]): unknown {
    const op=method.slice(prefix.length);
    if(['bots/list','bots/create','bots/update','bots/pause'].includes(op))return this.botCommand(c,op,p,created);
    if (['get','claim','revoke','open'].includes(op)) {
      fields(p,op==='claim'?[]:['botId']);this.human(c);
      let r=this.owned(c,p.botId);
      if(p.botId!==undefined&&!r)fail();
      if(op==='open') {
        if(!r || r.state!=='claimed' || r.owner_generation!==c.generation)fail();
        return {channel:this.service.openChannelDirect(c,String(r.actor_id))};
      }
      if (op==='claim') {
        if (!r) {
          const actor=this.service.actors.createSession('Personal assistant',c.actorId);
          created.push(actor);
          this.db.prepare("INSERT INTO personal_assistants(bot_id,actor_id,owner_human_id,owner_generation,assignment_id,epoch,state,created_at) VALUES(?,?,?,?,?,?,'claimed',?)")
            .run(randomUUID(),actor.id,c.actorId,c.generation,randomUUID(),randomUUID(),this.service.now());
          r=this.owned(c,p.botId)!;
          this.audit(c,r,'claim');
        } else if (r.state==='revoked' || r.paused || r.owner_generation!==c.generation) {
          // Explicit reclaim preserves resource/memory identity, retires in-flight authority.
          if (!this.service.actors.get(String(r.actor_id))?.enabled) fail();
          this.db.prepare("UPDATE personal_assistants SET state='claimed',paused=0,credential_id=NULL,owner_generation=?,epoch=? WHERE bot_id=?")
            .run(c.generation,randomUUID(),String(r.bot_id));
          r=this.owned(c,p.botId)!;
          this.audit(c,r,'claim');
          this.notifyPair(r);
        }
      } else if (op==='revoke' && r && r.state!=='revoked') {
        this.db.prepare("UPDATE personal_assistants SET state='revoked',credential_id=NULL,epoch=? WHERE bot_id=?").run(randomUUID(),String(r.bot_id));
        r=this.owned(c,p.botId)!;
        this.audit(c,r,'revoke');
        this.notifyPair(r);
      }
      const channel=r?this.db.prepare('SELECT id FROM actor_channels WHERE owner_id=? AND peer_id=?').get(c.actorId,String(r.actor_id)):null;
      return {assistant:r?this.value(r):null,channelId:channel?String(channel.id):null};
    }
    const r=this.row(c), authority=this.readAuthority(c), owner=authority.context;
    if(op==='authorize'){fields(p,[]);return this.access(c,r);}
    if(op==='groups/list'){
      fields(p,[]);
      const groups=this.service.channels.list(owner).filter(g=>g.kind==='group'&&g.canSend).map(g=>({id:g.id,title:g.title,kind:'group'}));
      this.audit(c,r,op);return {groups};
    }
    if(op==='groups/history'||op==='groups/search'){
      fields(p,op==='groups/history'?['channelId','before']:['channelId','query','before','limit']);
      const channelId=bounded(p.channelId);
      this.service.channels.assertWritable(owner,channelId);
      if(this.service.channels.get(owner,channelId).kind!=='group')fail();
      if(p.before!==undefined&&(!Number.isSafeInteger(p.before)||Number(p.before)<1))fail('invalid_input',400);
      const result=op==='groups/history'?this.service.channels.history(owner,channelId,p.before as number|undefined)
        :this.service.channels.search(owner,channelId,p.query,p.before,p.limit);
      // No execution receipts/actions or read-marker mutations are inherited.
      const messages=result.messages.map(({executionRequests:_,...message})=>message);
      this.audit(c,r,op,channelId);return {...result,messages};
    }
    fail('method_not_found',404);
  }
}
