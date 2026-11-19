import { readChannelMentions } from './channel-mentions.js';
import { sqliteTransaction } from '@opencraft/sqlite-node';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CHANNEL_AVATAR_PARTICIPANT_LIMIT, type ChannelActor, type ChannelSearchPage, type ChannelHistoryPage, type ChannelInviteCandidate, type ChannelMember, type ChannelMessage, type ChannelSummary, type ChannelSyncPage } from '@opencraft/appserver-protocol';
import type { Actor, ActorContext } from '@opencraft/identity-core/actors';
import type { ActorCapability, ActorStore } from './actors.js';


type Row = Record<string, unknown>;
export type ChannelSenderReadScope = Map<string, Map<string, string | null>>;
export type AvatarReadScope = ChannelSenderReadScope;
type ExternalActors = AvatarReadScope;
export type ChannelExternalSender = {source: string; senderId: string};
export type ChannelAvatarSubject = {actorId: string} | ChannelExternalSender;
export type ChannelAvatar = { kind: string; name: string };
export type NativeChannelChange = { channelId: string; directory?: boolean; memberActorId?: string };
const pageSize = 50;

export function nativeChannelId(id: string) {
  return /^(?:dm:[a-f0-9]{64}|group:[a-f0-9-]{36})$/u.test(id);
}

export class NativeChannels {
  /** Trusted installation projection only; never inferred from a display name. */
  avatarForSender?: (subject: ChannelAvatarSubject, scope: AvatarReadScope) => ChannelAvatar | null;
  /** Trusted provider association for presentation only, never message authorship or grants. */
  humanForExternalSender?: (subject: ChannelExternalSender, scope: ChannelSenderReadScope) => string | null;
  /** Installation-owned display projection; never used for rename or membership writes. */
  groupDisplayTitle?: (id: string) => string | null;
  readonly #listeners = new Set<(change: NativeChannelChange) => void>();
  constructor(private readonly db: DatabaseSync, private readonly actors: ActorStore,
    private readonly admitted: (actorId: string) => boolean,
    private readonly personalCanSend: (c: ActorContext, target: string) => boolean = () => false) {}

  onChange(listener: (change: NativeChannelChange) => void) {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  changed(change: NativeChannelChange) {
    for (const listener of this.#listeners) {
      try { listener(change); } catch { /* Notifications cannot undo a commit. */ }
    }
  }

  /** Bindings changed after commit. Wake existing readers without rewriting messages. */
  identityChanged(actorId: string) {
    for (const row of this.db.prepare(`SELECT id FROM actor_channels WHERE owner_id=? OR peer_id=?
      OR id IN (SELECT channel_id FROM actor_channel_members WHERE actor_id=?)`).all(actorId,actorId,actorId)) {
      this.changed({channelId: String(row.id)});
    }
  }

  registerDirect(id: string, a: string, b: string): boolean {
    const [owner, peer] = [a, b].sort();
    return Number(this.db.prepare('INSERT OR IGNORE INTO actor_channels(id,owner_id,peer_id) VALUES(?,?,?)').run(id, owner!, peer!).changes) > 0;
  }

  isMember(id: string, actorId: string): boolean {
    return this.memberEpoch(id, actorId) !== null;
  }

  /** Participation fence: a dissolved group never authorizes execution/delivery. */
  memberEpoch(id: string, actorId: string): string | null {
    return this.isActive(id) ? this.readEpoch(id,actorId) : null;
  }

  isActive(id:string):boolean {
    const row=this.db.prepare('SELECT c.id,l.dissolved_at FROM actor_channels c LEFT JOIN actor_channel_lifecycles l ON l.channel_id=c.id WHERE c.id=?').get(id);
    return !!row && row.dissolved_at == null;
  }

  private readEpoch(id: string, actorId: string): string | null {
    if (!this.admitted(actorId) || !this.actors.get(actorId)?.enabled) return null;
    const row = this.db.prepare(`SELECT c.peer_id,c.owner_id,m.epoch FROM actor_channels c
      LEFT JOIN actor_channel_members m ON m.channel_id=c.id AND m.actor_id=? WHERE c.id=?`).get(actorId,id);
    if (!row) return null;
    if (row.peer_id !== null) return row.owner_id === actorId || row.peer_id === actorId ? 'direct' : null;
    return typeof row.epoch === 'string' ? row.epoch : null;
  }

  assertReadable(context: ActorContext, id: string): string {
    const epoch = this.actors.isCurrent(context) && this.readEpoch(id, context.actorId);
    if (!epoch) throw Error('channel_denied');
    return epoch;
  }

  assertWritable(context:ActorContext,id:string):string {
    const epoch=this.assertReadable(context,id);
    if(!this.isActive(id))throw Error('channel_dissolved');
    return epoch;
  }

  private groupRow(id:string) {
    const row=this.db.prepare('SELECT * FROM actor_channels WHERE id=? AND peer_id IS NULL').get(id);
    if(!row)throw Error('channel_denied');return row;
  }
  private lifecycle(id:string) {
    const row=this.db.prepare('SELECT * FROM actor_channel_lifecycles WHERE channel_id=?').get(id);
    return {revision:Number(row?.revision??1),dissolvedAt:row?.dissolved_at==null?null:Number(row.dissolved_at)};
  }
  private advance(id:string) {
    this.db.prepare('INSERT INTO actor_channel_lifecycles(channel_id,revision) VALUES(?,2) ON CONFLICT(channel_id) DO UPDATE SET revision=revision+1').run(id);
  }
  getGroup(context:ActorContext,id:string):ChannelSummary {this.groupRow(id);return this.get(context,id);}
  setListHidden(context:ActorContext,id:string,hidden:boolean) {
    this.getGroup(context,id);
    this.db.prepare('INSERT INTO actor_channel_list_states VALUES(?,?,?) ON CONFLICT(channel_id,actor_id) DO UPDATE SET hidden=excluded.hidden').run(id,context.actorId,hidden?1:0);
  }
  leave(context:ActorContext,id:string,at:number) {
    this.assertWritable(context,id);const row=this.groupRow(id);
    if(row.owner_id===context.actorId)throw Error('channel_owner_cannot_leave');
    const epoch=this.readEpoch(id,context.actorId)!;
    this.db.prepare('INSERT INTO actor_channel_departures VALUES(?,?,?,?) ON CONFLICT(channel_id,actor_id) DO UPDATE SET member_epoch=excluded.member_epoch,left_at=excluded.left_at').run(id,context.actorId,epoch,at);
    this.db.prepare('DELETE FROM actor_channel_members WHERE channel_id=? AND actor_id=?').run(id,context.actorId);
    this.advance(id);this.retireOutbox(id,context.actorId);
  }
  dissolve(context:ActorContext,id:string,expectedRevision:number,at:number) {
    this.assertWritable(context,id);const row=this.groupRow(id),life=this.lifecycle(id);
    if(row.owner_id!==context.actorId)throw Error('channel_denied');
    if(life.revision!==expectedRevision)throw Error('channel_revision_conflict');
    this.db.prepare('INSERT INTO actor_channel_lifecycles VALUES(?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET revision=excluded.revision,dissolved_at=excluded.dissolved_at,dissolved_by=excluded.dissolved_by').run(id,life.revision+1,at,context.actorId);
    // Keep the binding as a tombstone: config replay cannot bind this room again.
    this.db.prepare('UPDATE actor_channel_sources SET active=0 WHERE channel_id=?').run(id);
    this.retireOutbox(id);
    this.db.prepare("UPDATE actor_channel_images SET state='unavailable',media_id=NULL WHERE state='pending' AND message_id IN (SELECT id FROM actor_messages WHERE channel_id=?)").run(id);
  }
  private retireOutbox(id:string,actorId?:string) {
    const where='message_id IN (SELECT id FROM actor_messages WHERE channel_id=?'+(actorId?' AND author_id=?':'')+')';
    const params=actorId?[id,actorId]:[id];
    // Sending may already have reached the provider: unknown is not a rejection.
    this.db.prepare("UPDATE actor_channel_outbox SET state=CASE state WHEN 'queued' THEN 'rejected' ELSE 'unknown' END WHERE state IN ('queued','sending') AND "+where).run(...params);
  }

  private summary(context: ActorContext, row: Row, scope: AvatarReadScope = new Map(), identities = new Map<string, ChannelActor>()): ChannelSummary {
    const project = (actor: Actor) => {
      let value = identities.get(actor.id);
      if (!value) { value = this.participant(actor, scope, true); identities.set(actor.id, value); }
      return value;
    };
    const peerId = this.peer(context, row);
    if (peerId === null) {
      const id=String(row.id),life=this.lifecycle(id),active=life.dissolvedAt===null,owner=row.owner_id===context.actorId;
      return { id, title: this.groupDisplayTitle?.(id) ?? String(row.title), canSend: active, kind: 'group',
        canManageMembers: active&&owner, canRename: active&&owner,
        lifecycle:{state:active?'active':'dissolved',...life,canLeave:active&&!owner,canDissolve:active&&owner},
        listState:{hidden:this.db.prepare('SELECT hidden FROM actor_channel_list_states WHERE channel_id=? AND actor_id=?').get(id,context.actorId)?.hidden===1},
        participants: this.memberActors(id, CHANNEL_AVATAR_PARTICIPANT_LIMIT).map(project) };
    }
    const peer = this.actors.get(peerId);
    return { id: String(row.id), title: peer?.displayName ?? peerId, kind: 'direct',
      participants: peer ? [project(peer)] : [],
      canSend: !!peer?.enabled && this.admitted(peerId) && (this.actors.can(context, peerId, 'message.send') || this.personalCanSend(context,peerId)) };
  }

  private peer(context: ActorContext, row: Row): string | null {
    return row.peer_id === null ? null : String(row.owner_id === context.actorId ? row.peer_id : row.owner_id);
  }

  directPeer(context: ActorContext, id: string): string | null {
    this.assertReadable(context,id);
    return this.peer(context,this.db.prepare('SELECT * FROM actor_channels WHERE id=?').get(id)!);
  }

  get(context: ActorContext, id: string): ChannelSummary {
    this.assertReadable(context,id);
    return this.summary(context,this.db.prepare('SELECT * FROM actor_channels WHERE id=?').get(id)!);
  }

  list(context: ActorContext): ChannelSummary[] {
    if (!this.actors.isCurrent(context) || !this.admitted(context.actorId)) throw Error('channel_denied');
    const id = context.actorId;
    // One bounded identity projection per actor/read, never retained across mutations.
    const scope: AvatarReadScope = new Map(), identities = new Map<string, ChannelActor>();
    return this.db.prepare(`SELECT * FROM actor_channels WHERE (peer_id IS NOT NULL AND (owner_id=? OR peer_id=?))
      OR id IN (SELECT channel_id FROM actor_channel_members WHERE actor_id=? AND NOT EXISTS (SELECT 1 FROM actor_channel_list_states v WHERE v.channel_id=actor_channel_members.channel_id AND v.actor_id=actor_channel_members.actor_id AND v.hidden=1)) ORDER BY id`)
      .all(id,id,id).map(row => this.summary(context,row,scope,identities));
  }

  people(context: ActorContext, query = '', after = '') {
    this.assertStanding(context, 'people.directory');
    if(typeof query!=='string'||query.length>128||typeof after!=='string'||after.length>128)throw Error('invalid_input');
    const rows=this.db.prepare(`SELECT a.*,(SELECT owner_human_id FROM personal_assistants WHERE actor_id=a.id) AS personal_owner_id FROM actors a WHERE a.enabled=1 AND a.id>? AND instr(lower(a.display_name),lower(?))>0
      AND (a.kind='human' OR NOT EXISTS(SELECT 1 FROM personal_assistants WHERE actor_id=a.id) OR EXISTS(SELECT 1 FROM personal_assistants p JOIN actors o ON o.id=p.owner_human_id
        WHERE p.actor_id=a.id AND p.owner_human_id=? AND p.state='claimed' AND o.enabled=1 AND o.generation=p.owner_generation))
      ORDER BY a.id LIMIT 100`).all(after,query,context.actorId);
    const scope: AvatarReadScope = new Map();
    return {people:rows.filter(r=>this.admitted(String(r.id))&&(!r.personal_owner_id||this.admitted(String(r.personal_owner_id)))).map(r=>{
      const avatar=this.avatar({actorId:String(r.id)},scope);
      return {actorId:String(r.id),displayName:String(r.display_name),kind:r.kind==='human'?'human' as const:'bot' as const,
      ...(avatar?{avatar}:{}),canMessage:r.id!==context.actorId&&(this.actors.can(context,String(r.id),'message.send')||this.personalCanSend(context,String(r.id)))};}),
      next:rows.length===100?String(rows.at(-1)!.id):null};
  }
  inviteCandidates(context: ActorContext, query: string, channelId?: string): ChannelInviteCandidate[] {
    this.assertStanding(context, 'channel.invite', channelId);
    if (channelId !== undefined && !this.get(context,channelId).canManageMembers) throw Error('channel_denied');
    const term = query.trim().toLocaleLowerCase();
    const candidates: ChannelInviteCandidate[] = [];
    const scope: AvatarReadScope = new Map();
    const privateActors=new Set(this.db.prepare('SELECT actor_id FROM personal_assistants WHERE owner_human_id<>?').all(context.actorId).map(row=>String(row.actor_id)));
    for (const actor of this.actors.list()) {
      if (actor.id === context.actorId || !actor.enabled || !actor.displayName.toLocaleLowerCase().includes(term) || !this.admitted(actor.id)) continue;
      if(privateActors.has(actor.id))continue;
      if (channelId !== undefined && this.isMember(channelId,actor.id)) continue;
      candidates.push(this.participant(actor,scope));
      if (candidates.length === 30) break;
    }
    return candidates;
  }

  private assertStanding(context: ActorContext, capability: ActorCapability, resource?: string) {
    if (!this.actors.isCurrent(context) || !this.admitted(context.actorId) || !this.actors.allows(context, capability, resource)) throw Error('channel_denied');
  }

  createGroup(context: ActorContext, title: string, members: string[], key: string): { id: string; created: boolean } {
    this.assertStanding(context, 'channel.create');
    const ids = [...new Set([context.actorId,...members])].sort();
    const fingerprint = JSON.stringify([title,ids]);
    const prior = this.db.prepare('SELECT id,create_fingerprint FROM actor_channels WHERE owner_id=? AND create_key=?').get(context.actorId,key);
    if (prior) {
      if (prior.create_fingerprint !== fingerprint) throw Object.assign(Error('idempotency_conflict'), { code: 'idempotency_conflict' });
      return { id: String(prior.id), created: false };
    }
    for (const actorId of ids) this.assertEligible(actorId);
    const id = 'group:' + randomUUID();
    this.db.prepare('INSERT INTO actor_channels(id,owner_id,title,create_key,create_fingerprint) VALUES(?,?,?,?,?)').run(id,context.actorId,title,key,fingerprint);
    this.db.prepare('INSERT INTO actor_channel_lifecycles(channel_id) VALUES(?)').run(id);
    for (const actorId of ids) this.addMember(id,actorId);
    return { id, created: true };
  }

  setMember(context: ActorContext, id: string, actorId: string, present: boolean): boolean {
    this.assertWritable(context,id);
    const row = this.db.prepare('SELECT owner_id,peer_id FROM actor_channels WHERE id=?').get(id);
    if (row?.owner_id !== context.actorId || row.peer_id !== null || actorId === context.actorId) throw Error('channel_denied');
    if (present) {
      this.assertEligible(actorId);
      const existing = this.db.prepare('SELECT count(*) AS count FROM actor_channel_members WHERE channel_id=?').get(id);
      if (Number(existing?.count) >= 64 && !this.isMember(id,actorId)) throw Error('invalid_input');
      this.db.prepare('DELETE FROM actor_channel_departures WHERE channel_id=? AND actor_id=?').run(id,actorId);
      const changed=this.addMember(id,actorId);if(changed)this.advance(id);return changed;
    }
    const changed=Number(this.db.prepare('DELETE FROM actor_channel_members WHERE channel_id=? AND actor_id=?').run(id,actorId).changes)>0;
    if(changed){this.advance(id);this.retireOutbox(id,actorId);}return changed;
  }

  /** Trusted transport projection only. Public commands retain their Human owner checks. */
  projectExternalGroup(id:string,{name,add=[],remove=[]}:{name?:string;add?:string[];remove?:string[]}) {
    const group=this.groupRow(id);
    if(!this.isActive(id))throw Error('channel_dissolved');
    if(name!==undefined&&(!name.trim()||name.length>128||/\p{Cs}/u.test(name)||/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)))throw Error('invalid_input');
    for(const actorId of add)if(!this.actors.isReservedHuman(actorId))this.assertEligible(actorId);
    let changed=false;
    for(const actorId of remove)if(actorId!==group.owner_id)changed=Number(this.db.prepare('DELETE FROM actor_channel_members WHERE channel_id=? AND actor_id=?').run(id,actorId).changes)>0||changed;
    for(const actorId of add){
      if(this.db.prepare('SELECT 1 FROM actor_channel_departures WHERE channel_id=? AND actor_id=?').get(id,actorId))continue;
      const n=this.db.prepare('SELECT count(*) AS n FROM actor_channel_members WHERE channel_id=?').get(id);
      if(Number(n?.n)>=64&&!this.db.prepare('SELECT 1 FROM actor_channel_members WHERE channel_id=? AND actor_id=?').get(id,actorId))throw Error('invalid_input');
      changed=this.addMember(id,actorId)||changed;
    }
    if(name!==undefined&&name!==group.title){this.db.prepare('UPDATE actor_channels SET title=? WHERE id=?').run(name,id);changed=true;}
    if(changed)this.advance(id);
  }

  /** Owner-only, like membership. Returns false when the title is already current. */
  rename(context: ActorContext, id: string, title: string): boolean {
    this.assertWritable(context,id);
    const row = this.db.prepare('SELECT owner_id,peer_id,title FROM actor_channels WHERE id=?').get(id);
    if (row?.owner_id !== context.actorId || row.peer_id !== null) throw Error('channel_denied');
    if (!title || title.length > 128 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(title)) throw Error('invalid_input');
    if (row.title === title) return false;
    const changed=Number(this.db.prepare('UPDATE actor_channels SET title=? WHERE id=? AND peer_id IS NULL').run(title,id).changes)>0;
    if(changed)this.advance(id);return changed;
  }

  /**
   * A provider sender recorded only by its raw identity, and bound to an
   * enabled human here, shows that human's current name. Labels the provider
   * already resolved are kept as recorded; identity and authorship are unchanged.
   */
  private linkedExternalName(source: unknown, senderId: unknown, stored: string): string | null {
    let parts: unknown;
    try { parts = JSON.parse(String(source)); } catch { return null; }
    if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== 'wecom-customer-service' || typeof parts[1] !== 'string') return null;
    if (senderId !== 'external:' + createHash('sha256').update(JSON.stringify([String(source), stored])).digest('hex')) return null;
    const binding = this.db.prepare('SELECT actor_id FROM actor_bindings WHERE binding=?').get(JSON.stringify(['wecom.' + parts[1], stored]));
    const actor = binding ? this.actors.get(String(binding.actor_id)) : null;
    return actor?.enabled && actor.kind === 'human' && this.admitted(actor.id) ? actor.displayName : null;
  }

  private avatar(subject: ChannelAvatarSubject, scope: AvatarReadScope, roster = false): ChannelAvatar | null {
    if (!this.avatarForSender) return null;
    if ('actorId' in subject) {
      const actor = this.actors.get(subject.actorId);
      if (!actor || actor.kind !== 'human' || !(actor.enabled && this.admitted(actor.id) || roster && this.actors.isReservedHuman(actor.id))) return null;
    }
    try {
      const value = this.avatarForSender(subject, scope);
      if (!value || typeof value.kind !== 'string' || !value.kind || value.kind.length > 64
        || typeof value.name !== 'string' || !value.name || value.name.length > 256
        || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value.kind + value.name)) return null;
      return {kind: value.kind, name: value.name};
    } catch { return null; }
  }

  private participant(actor: Actor, scope: AvatarReadScope, roster = false): ChannelActor {
    const avatar = this.avatar({actorId:actor.id},scope,roster);
    return {actorId:actor.id,displayName:actor.displayName,actorKind:actor.kind,...(avatar?{avatar}:{})};
  }

  private memberActors(id: string, limit = Infinity): Actor[] {
    const members: Actor[] = [];
    for (const row of this.db.prepare('SELECT actor_id FROM actor_channel_members WHERE channel_id=? ORDER BY actor_id').iterate(id)) {
      const actor=this.actors.get(String(row.actor_id));
      if (actor && (actor.enabled && this.admitted(actor.id) || this.actors.isReservedHuman(actor.id))) members.push(actor);
      if (members.length >= limit) break;
    }
    return members;
  }

  private linkedHuman(subject: ChannelExternalSender, scope: ChannelSenderReadScope): string | null {
    try {
      const id = this.humanForExternalSender?.(subject, scope);
      const actor = typeof id === 'string' ? this.actors.get(id) : null;
      return actor?.enabled && actor.kind === 'human' && this.admitted(actor.id) ? actor.id : null;
    } catch { return null; }
  }

  private authorName(messageId: string, row: Row): string {
    const stored = row.author_display_name;
    if (stored != null) {
      const external = this.db.prepare('SELECT source,sender_id FROM actor_channel_external_messages WHERE message_id=?').get(messageId);
      return external ? this.linkedExternalName(external.source, external.sender_id, String(stored)) ?? String(stored) : String(stored);
    }
    return String(this.actors.get(String(row.author_id))?.displayName ?? row.author_id);
  }

  members(context: ActorContext, id: string): ChannelMember[] {
    this.assertReadable(context,id);
    const group = this.db.prepare('SELECT owner_id FROM actor_channels WHERE id=? AND peer_id IS NULL').get(id);
    if (!group) throw Error('channel_denied');
    const scope: AvatarReadScope = new Map();
    return this.memberActors(id).map(actor => ({...this.participant(actor,scope,true),role:actor.id===group.owner_id?'owner':'member'}));
  }

  private addMember(id: string, actorId: string): boolean {
    const epoch = randomUUID();
    const created = Number(this.db.prepare('INSERT OR IGNORE INTO actor_channel_members VALUES(?,?,?)').run(id,actorId,epoch).changes) > 0;
    if (created) this.db.prepare(`INSERT INTO actor_channel_reads(channel_id,actor_id,epoch,joined_seq,read_seq)
      VALUES(?,?,?,(SELECT COALESCE(MAX(seq),0) FROM actor_messages),0)
      ON CONFLICT(channel_id,actor_id) DO UPDATE SET epoch=excluded.epoch,joined_seq=excluded.joined_seq,read_seq=0`).run(id,actorId,epoch);
    return created;
  }

  private assertEligible(actorId: string) {
    if (!this.actors.get(actorId)?.enabled || !this.admitted(actorId)) throw Error('channel_denied');
  }

  markRead(context: ActorContext, id: string, through: number) {
    const epoch = this.assertReadable(context,id);
    if (!Number.isSafeInteger(through) || through < 0) throw Error('invalid_input');
    if (through > 0 && !this.db.prepare('SELECT 1 FROM actor_messages WHERE channel_id=? AND seq=?').get(id,through)) throw Error('invalid_input');
    this.db.prepare(`INSERT INTO actor_channel_reads(channel_id,actor_id,epoch,joined_seq,read_seq) VALUES(?,?,?,0,?)
      ON CONFLICT(channel_id,actor_id) DO UPDATE SET read_seq=MAX(actor_channel_reads.read_seq,excluded.read_seq)
      WHERE actor_channel_reads.epoch=excluded.epoch`).run(id,context.actorId,epoch,through);
    this.db.prepare(`UPDATE actor_deliveries SET state='read',read_at=COALESCE(read_at,?) WHERE receiver_id=? AND message_id IN
      (SELECT id FROM actor_messages WHERE channel_id=? AND seq<=?)`).run(Date.now(),context.actorId,id,through);
    this.changed({channelId:id,directory:true,memberActorId:context.actorId});
  }

  acknowledgeMention(context:ActorContext,id:string,messageId:string) {
    this.assertReadable(context,id);
    const pending=this.db.prepare(`SELECT 1 FROM actor_channel_mentions n JOIN actor_messages m ON m.id=n.message_id
      JOIN actor_channel_members cm ON cm.channel_id=m.channel_id AND cm.actor_id=n.actor_id
      JOIN actor_channel_reads r ON r.channel_id=cm.channel_id AND r.actor_id=cm.actor_id AND r.epoch=cm.epoch
      WHERE m.id=? AND m.channel_id=? AND n.actor_id=? AND m.seq>r.joined_seq AND m.author_id<>? LIMIT 1`).get(messageId,id,context.actorId,context.actorId);
    if(!pending)throw Error('channel_mention_unavailable');
    const changed=Number(this.db.prepare('INSERT OR IGNORE INTO actor_channel_mention_reads VALUES(?,?)').run(messageId,context.actorId).changes)>0;
    if(changed){
      this.db.prepare('INSERT OR REPLACE INTO actor_channel_changes(channel_id,message_id) VALUES(?,?)').run(id,messageId);
      this.changed({channelId:id,directory:true,memberActorId:context.actorId});
    }
    return {acknowledged:true};
  }

  message(context: ActorContext, row: Row, externalActors: ExternalActors = new Map()): ChannelMessage {
    const external=this.db.prepare('SELECT source,sender_id FROM actor_channel_external_messages WHERE message_id=?').get(String(row.id));
    const delivery=this.db.prepare('SELECT state FROM actor_channel_outbox WHERE message_id=?').get(String(row.id));
    const file=this.db.prepare('SELECT name,mime,length(bytes) AS size FROM actor_channel_attachments WHERE message_id=?').get(String(row.id));
    const attachment=this.db.prepare('SELECT state,attribution FROM actor_channel_images WHERE message_id=?').get(String(row.id));
    const actor = external ? null : this.actors.get(String(row.author_id));
    const isSelf = external
      ? this.linkedHuman({source: String(external.source), senderId: String(external.sender_id)}, externalActors) === context.actorId
      : row.author_id === context.actorId;
    const avatar = this.avatar(external ? {source: String(external.source), senderId: String(external.sender_id)}
      : {actorId: String(row.author_id)}, externalActors);
    const name = external ? this.authorName(String(row.id), row) : String(row.author_display_name ?? actor?.displayName ?? row.author_id);
    const revision = row.revision ?? this.db.prepare('SELECT revision FROM actor_channel_changes WHERE message_id=?').get(String(row.id))?.revision;
    const quoted = row.reply_to ? this.db.prepare('SELECT id,author_id,author_display_name,content FROM actor_messages WHERE id=? AND channel_id=?')
      .get(String(row.reply_to),String(row.channel_id)) : undefined;
    const executionRequests = this.db.prepare(`SELECT r.id,r.target_id FROM actor_execution_inputs i
      JOIN actor_execution_requests r ON r.id=i.request_id WHERE i.message_id=? AND (r.requester_id=? OR r.target_id=?)
      ORDER BY r.created_at,r.id`).all(String(row.id),context.actorId,context.actorId);
    const mentions=readChannelMentions(this.db,String(row.id),context.actorId);
    return { ...(mentions.length?{mentions}:{}), sequence: Number(row.seq), messageId: String(row.id), ...(revision === undefined ? {} : { revision: Number(revision) }), author: name, text: String(row.content),
      at: Number(row.created_at), status: row.author_id !== context.actorId ? 'received' : delivery ? (delivery.state==='queued'?'sending':delivery.state) as ChannelMessage['status'] : 'delivered',
      ...(file?{attachment:{name:String(file.name),type:String(file.mime),size:Number(file.size)}}:{}),
      ...(attachment?{image:{state:attachment.state, ...(attachment.attribution?{attribution:attachment.attribution}:{})} as ChannelMessage['image']}:{}),
      sender: { id: String(row.author_id), displayName: name, kind: external ? 'external' : 'opencraft',
        ...(avatar ? { avatar } : {}),
        ...(actor ? { actorKind: actor.kind } : {}), isSelf },
      ...(row.reply_to ? { replyToMessageId: String(row.reply_to) } : {}),
      ...(quoted ? { replyTo: {
        author: this.authorName(String(quoted.id), quoted),
        text: String(quoted.content).slice(0,240),
      } } : {}),
      ...(executionRequests.length ? { executionRequests: executionRequests.map(request => ({ actorId: String(request.target_id), requestId: String(request.id) })) } : {}) };
  }

  attachmentChunk(context:ActorContext,id:string,sequence:number,offset:number){
    this.assertReadable(context,id);
    if(!Number.isSafeInteger(sequence)||sequence<1||!Number.isSafeInteger(offset)||offset<0)throw Error('invalid_input');
    const row=this.db.prepare('SELECT a.name,a.mime,length(a.bytes) AS size,substr(a.bytes,?,65536) AS bytes FROM actor_channel_attachments a JOIN actor_messages m ON m.id=a.message_id WHERE m.channel_id=? AND m.seq=?').get(offset+1,id,sequence)
      ?? this.db.prepare("SELECT 'image' AS name,i.mime,length(i.bytes) AS size,substr(i.bytes,?,65536) AS bytes FROM actor_channel_images i JOIN actor_messages m ON m.id=i.message_id WHERE m.channel_id=? AND m.seq=? AND i.state='ready'").get(offset+1,id,sequence);
    if(!row)return null;
    if(offset>Number(row.size))throw Error('invalid_input');
    const bytes=Buffer.from(row.bytes as Uint8Array);
    return {name:String(row.name),type:String(row.mime),size:Number(row.size),base64:bytes.toString('base64'),nextOffset:offset+bytes.length};
  }

  attachment(context:ActorContext,id:string,sequence:number){
    this.assertReadable(context,id);
    if(!Number.isSafeInteger(sequence)||sequence<1)throw Error('invalid_input');
    const row=this.db.prepare('SELECT a.name,a.mime,a.bytes FROM actor_channel_attachments a JOIN actor_messages m ON m.id=a.message_id WHERE m.channel_id=? AND m.seq=?').get(id,sequence);
    return row?{name:row.name,type:row.mime,bytes:row.bytes}:null;
  }

  image(context:ActorContext,id:string,sequence:number){
    this.assertReadable(context,id);
    if(!Number.isSafeInteger(sequence)||sequence<1)throw Error('invalid_input');
    const row=this.db.prepare("SELECT i.mime,i.bytes FROM actor_channel_images i JOIN actor_messages m ON m.id=i.message_id WHERE m.channel_id=? AND m.seq=? AND i.state='ready'").get(id,sequence);
    return row?{type:row.mime,bytes:row.bytes}:null;
  }

  history(context: ActorContext, id: string, before = Number.MAX_SAFE_INTEGER): ChannelHistoryPage {
    this.assertReadable(context,id);
    if (!Number.isSafeInteger(before) || before < 1) throw Error('invalid_input');
    const rows = this.db.prepare('SELECT * FROM actor_messages WHERE channel_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(id,before,pageSize+1);
    const indexes: ExternalActors = new Map();
    return { messages: rows.slice(0,pageSize).reverse().map(row => this.message(context,row,indexes)), hasEarlier: rows.length > pageSize };
  }

  search(context:ActorContext,id:string,query:unknown,before:unknown=Number.MAX_SAFE_INTEGER,limit:unknown=20):ChannelHistoryPage {
    this.assertReadable(context,id);
    if(typeof query!=='string'||!query.trim()||query.length>256||typeof before!=='number'||!Number.isSafeInteger(before)||before<1||typeof limit!=='number'||!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('invalid_input');
    const rows=this.db.prepare('SELECT * FROM actor_messages WHERE channel_id=? AND seq<? AND instr(lower(content),lower(?))>0 ORDER BY seq DESC LIMIT ?').all(id,before,query,limit+1);
    const indexes: ExternalActors = new Map();
    return {messages:rows.slice(0,limit).reverse().map(row=>this.message(context,row,indexes)),hasEarlier:rows.length>limit};
  }

  around(context:ActorContext,id:string,sequence:unknown):ChannelHistoryPage {
    this.assertReadable(context,id);
    if(typeof sequence!=='number'||!Number.isSafeInteger(sequence)||sequence<1)throw Error('invalid_input');
    if(!this.db.prepare('SELECT 1 FROM actor_messages WHERE channel_id=? AND seq=?').get(id,sequence))throw Error('invalid_input');
    const older=this.db.prepare('SELECT * FROM actor_messages WHERE channel_id=? AND seq<? ORDER BY seq DESC LIMIT 26').all(id,sequence);
    const newer=this.db.prepare('SELECT * FROM actor_messages WHERE channel_id=? AND seq>=? ORDER BY seq LIMIT 25').all(id,sequence);
    const indexes: ExternalActors = new Map();
    return {messages:[...older.slice(0,25).reverse(),...newer].map(row=>this.message(context,row,indexes)),hasEarlier:older.length>25};
  }

  /** Search the admitted native history, including provider-synchronized messages.
   * Authorization is applied in SQL before pagination, never in the renderer. */
  searchAll(context: ActorContext, query: unknown, before: unknown = Number.MAX_SAFE_INTEGER, limit: unknown = 30): ChannelSearchPage {
    if (!this.actors.isCurrent(context) || !this.admitted(context.actorId)) throw Error('channel_denied');
    if (typeof query !== 'string' || !query.trim() || query.length > 256 || typeof before !== 'number' || !Number.isSafeInteger(before) || before < 1 || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw Error('invalid_input');
    const rows = this.db.prepare(`SELECT m.* FROM actor_messages m JOIN actor_channels c ON c.id=m.channel_id
      WHERE m.seq<? AND instr(lower(m.content),lower(?))>0 AND
      ((c.peer_id IS NOT NULL AND (c.owner_id=? OR c.peer_id=?)) OR
       (c.peer_id IS NULL AND EXISTS (SELECT 1 FROM actor_channel_members cm WHERE cm.channel_id=c.id AND cm.actor_id=?)))
      ORDER BY m.seq DESC LIMIT ?`).all(before,query.trim(),context.actorId,context.actorId,context.actorId,limit+1);
    const page=rows.slice(0,limit);
    const summaries=new Map<string,ChannelSummary>();
    const indexes: ExternalActors = new Map();
    return {matches:page.map(row=>{
      const id=String(row.channel_id);
      let channel=summaries.get(id);
      if(!channel){channel=this.get(context,id);summaries.set(id,channel);}
      return {channel,message:this.message(context,row,indexes)};
    }),nextBefore:rows.length>limit?Number(page.at(-1)!.seq):null};
  }

  sync(context: ActorContext, id: string, cursor?: string): ChannelSyncPage {
    return sqliteTransaction(this.db, () => this.syncPage(context,id,cursor));
  }

  private syncPage(context: ActorContext, id: string, cursor?: string): ChannelSyncPage {
    const memberEpoch = this.assertReadable(context,id);
    const epoch = this.db.prepare('SELECT epoch FROM actor_channel_identity').get()!.epoch;
    // Viewer identity links affect self presentation even when no message changed.
    const bindings = this.actors.bindings(context.actorId).map(b => [b.provider,b.subject]).sort();
    const scope = createHash('sha256').update(JSON.stringify([epoch,id,context.actorId,context.generation,memberEpoch,bindings])).digest('hex');
    const latest = Number(this.db.prepare('SELECT MAX(revision) AS latest FROM actor_channel_changes WHERE channel_id=?').get(id)!.latest ?? 0);
    const parsed = cursor?.match(/^([a-f0-9]{64})\.(0|[1-9]\d{0,15})$/u);
    if (cursor !== undefined && !parsed) throw Error('invalid_input');
    const after = Number(parsed?.[2]);
    if (parsed?.[1] !== scope || !Number.isSafeInteger(after) || after > latest) {
      return { kind: 'snapshot', ...this.history(context,id), cursor: `${scope}.${latest}` };
    }
    const rows = this.db.prepare(`SELECT m.*,c.revision FROM actor_channel_changes c JOIN actor_messages m ON m.id=c.message_id
      WHERE c.channel_id=? AND c.revision>? ORDER BY c.revision LIMIT ?`).all(id,after,pageSize+1);
    const page = rows.slice(0,pageSize);
    const indexes: ExternalActors = new Map();
    return { kind: 'delta', messages: page.map(row => this.message(context,row,indexes)),
      cursor: `${scope}.${page.at(-1)?.revision ?? after}`, hasMore: rows.length > pageSize };
  }
}
