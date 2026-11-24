import { randomToken, randomUUID, sha256Hex } from './portable-crypto.js';
import type { SqlDatabase } from '@opencraft/sql';
import type { ActorContext } from '@opencraft/identity-core/actors';
import type { ServerSpaceCommand, ServerSpaceDirectory, ServerSpaceMember } from '@opencraft/appserver-protocol/server-spaces';

export class ServerSpaceError extends Error {
  readonly rpcCode: number;
  constructor(readonly reason: 'unavailable'|'invalid'|'authentication'|'invitation'|'owner', code = -32004) {
    super('Server action unavailable'); this.rpcCode = code;
  }
}
const deny = () => { throw new ServerSpaceError('unavailable'); };
const digest = (value: string) => sha256Hex(value);
const valid = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096;
export interface SpaceProjection {
  spaces: {id:string;name:string;ownerActorId:string;createdAt:number;openContact:boolean}[];
  members: {spaceId:string;actorId:string;role:'owner'|'member'}[];
  assignments: {engineServerId:string;threadId:string;spaceId:string}[];
}
/** Only the storage Worker calls this ledger. Context comes from a trusted adapter. */
export class ServerSpacesLedger {
  constructor(readonly db: SqlDatabase, readonly now = Date.now) {}
  private actor(context: ActorContext) {
    const actor = this.db.prepare('SELECT * FROM actors WHERE id=?').get(context.actorId);
    if (!actor || actor.kind !== 'human' || actor.enabled !== 1 || actor.generation !== context.generation || context.expiresAt <= this.now())
      throw new ServerSpaceError('authentication', -32001);
    return actor;
  }
  private role(spaceId: string, actorId: string): 'owner'|'member'|null {
    if (!valid(spaceId)) throw new ServerSpaceError('invalid', -32602);
    return this.db.prepare('SELECT role FROM collaboration_space_members WHERE space_id=? AND actor_id=?').get(spaceId,actorId)?.role as 'owner'|'member'|undefined ?? null;
  }
  private member(spaceId: string, context: ActorContext, owner = false) {
    this.actor(context); const role = this.role(spaceId,context.actorId);
    if (!role || owner && role !== 'owner') deny();
  }
  /** Installer-owned explicit bootstrap. A network request can never claim this role. */
  bootstrap(ownerActorId: string, members: readonly string[] = []) {
    if (this.db.prepare('SELECT id FROM collaboration_spaces WHERE id=?').get('myself')) return;
    const actor = this.db.prepare('SELECT * FROM actors WHERE id=?').get(ownerActorId);
    if (!actor || actor.kind !== 'human' || actor.enabled !== 1) deny();
    this.db.transaction(() => {
      // The historical default space keeps per-target grants; only new spaces open contact by default.
      this.db.prepare("INSERT INTO collaboration_spaces(id,name,owner_actor_id,created_at,open_contact) VALUES('myself','myself',?,?,0)").run(ownerActorId,this.now());
      const insert = this.db.prepare("INSERT OR IGNORE INTO collaboration_space_members VALUES('myself',?,?,?)");
      insert.run(ownerActorId,'owner',this.now());
      this.db.prepare("INSERT OR IGNORE INTO collaboration_space_threads SELECT server_id,thread_id,'myself' FROM thread_access").run();
      for (const id of members) {
        const human = this.db.prepare('SELECT * FROM actors WHERE id=?').get(id);
        if (human?.kind === 'human' && human.enabled === 1) insert.run(id,id === ownerActorId ? 'owner' : 'member',this.now());
      }
    });
  }
  projection(): SpaceProjection {
    return {
      spaces: this.db.prepare('SELECT id,name,owner_actor_id AS ownerActorId,created_at AS createdAt,open_contact AS openContact FROM collaboration_spaces ORDER BY created_at,id').all()
        .map(row=>({...row,openContact:row.openContact===1})) as unknown as SpaceProjection['spaces'],
      members: this.db.prepare('SELECT space_id AS spaceId,actor_id AS actorId,role FROM collaboration_space_members').all() as unknown as SpaceProjection['members'],
      assignments: this.db.prepare('SELECT engine_server_id AS engineServerId,thread_id AS threadId,space_id AS spaceId FROM collaboration_space_threads').all() as unknown as SpaceProjection['assignments'],
    };
  }
  directory(context: ActorContext): ServerSpaceDirectory {
    this.actor(context); const projection = this.projection();
    const memberships = new Map(projection.members.filter(m => m.actorId === context.actorId).map(m => [m.spaceId,m.role]));
    return {actorId:context.actorId, spaces:projection.spaces.filter(s => memberships.has(s.id)).map(s => ({id:s.id,name:s.name,
      role:memberships.get(s.id)!,memberCount:projection.members.filter(m => m.spaceId === s.id).length,openContact:s.openContact})),
      assignments:projection.assignments.filter(a => memberships.has(a.spaceId))};
  }
  members(context: ActorContext, spaceId: string): ServerSpaceMember[] {
    this.member(spaceId,context);
    return this.db.prepare(`SELECT m.actor_id AS actorId,a.display_name AS displayName,m.role,a.kind FROM collaboration_space_members m
      JOIN actors a ON a.id=m.actor_id WHERE m.space_id=? ORDER BY m.joined_at,m.actor_id`).all(spaceId) as unknown as ServerSpaceMember[];
  }
  adoptLegacy(context:ActorContext,engineServerId:string,threads:readonly {id:string;createdAt:number}[]) {
    this.actor(context);
    const root=this.db.prepare("SELECT created_at FROM collaboration_spaces WHERE id='myself'").get();
    if(!root||!this.role('myself',context.actorId))return false;
    if(!valid(engineServerId)||threads.length>1000)throw new ServerSpaceError('invalid',-32602);
    // A missing assignment is never permission. Only Native-proven conversations
    // older than installation bootstrap can enter the historical default space.
    const cutoff=Math.floor(Number(root.created_at)/1000)*1000;
    let changed=false;
    this.db.transaction(()=>{
      for(const thread of threads) {
        if(!valid(thread.id)||!Number.isFinite(thread.createdAt)||thread.createdAt<=0)continue;
        const created=thread.createdAt<1e12?thread.createdAt*1000:thread.createdAt;
        if(created>=cutoff)continue;
        const result=this.db.prepare("INSERT OR IGNORE INTO collaboration_space_threads VALUES(?,?,'myself')").run(engineServerId,thread.id);
        changed ||= Number(result.changes)>0;
      }
    });
    return changed;
  }
  /** Trusted creation reconciliation only; never a client RPC or a member grant. */
  inherit(parentServer:string,parentThread:string,childServer:string,childThread:string) {
    if(![parentServer,parentThread,childServer,childThread].every(valid)||parentServer===childServer&&parentThread===childThread)throw new ServerSpaceError('invalid',-32602);
    const parent=this.db.prepare('SELECT space_id FROM collaboration_space_threads WHERE engine_server_id=? AND thread_id=?').get(parentServer,parentThread);
    if(!parent)deny();
    const child=this.db.prepare('SELECT space_id FROM collaboration_space_threads WHERE engine_server_id=? AND thread_id=?').get(childServer,childThread);
    if(child&&child.space_id!==parent!.space_id)deny();
    this.db.prepare('INSERT OR IGNORE INTO collaboration_space_threads VALUES(?,?,?)').run(childServer,childThread,String(parent!.space_id));
  }
  assign(context: ActorContext, engineServerId: string, threadId: string, spaceId: string) {
    this.member(spaceId,context);
    if (!valid(engineServerId) || !valid(threadId)) throw new ServerSpaceError('invalid', -32602);
    const existing = this.db.prepare('SELECT space_id FROM collaboration_space_threads WHERE engine_server_id=? AND thread_id=?').get(engineServerId,threadId);
    // Assignment only accompanies a newly created Thread; no arbitrary move between spaces.
    if (existing && existing.space_id !== spaceId) deny();
    this.db.prepare('INSERT OR IGNORE INTO collaboration_space_threads VALUES(?,?,?)').run(engineServerId,threadId,spaceId);
  }
  /** The caller's additional assistants (not their default one), enabled and claimed. */
  #managedBots(actorId: string): {actorId:string;displayName:string}[] {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='personal_assistants'").get()) return [];
    return this.db.prepare(`SELECT a.id AS actorId,a.display_name AS displayName FROM personal_assistants p JOIN actors a ON a.id=p.actor_id
      WHERE p.owner_human_id=? AND p.state='claimed' AND p.is_default=0 AND a.enabled=1 ORDER BY a.display_name,a.id`).all(actorId).map(r => ({actorId:String(r.actorId),displayName:String(r.displayName)}));
  }
  command(context: ActorContext, input: ServerSpaceCommand): unknown {
    this.actor(context);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ServerSpaceError('invalid', -32602);
    const fields:Record<string,readonly string[]>={list:['action'],create:['action','name'],select:['action','spaceId'],members:['action','spaceId'],invite:['action','spaceId'],join:['action','code'],remove:['action','spaceId','actorId'],
      contact:['action','spaceId','open'],addBot:['action','spaceId','actorId'],bots:['action','spaceId']};
    if(!fields[input.action]||Object.keys(input).some(key=>!fields[input.action]!.includes(key)))throw new ServerSpaceError('invalid',-32602);
    switch (input.action) {
      case 'list': return this.directory(context);
      case 'select': this.member(input.spaceId,context); return this.directory(context);
      case 'create': {
        if(!this.db.prepare("SELECT id FROM collaboration_spaces WHERE id='myself'").get())throw new ServerSpaceError('owner');
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80 || /[\x00-\x1f\x7f]/u.test(input.name)) throw new ServerSpaceError('invalid', -32602);
        if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM collaboration_spaces WHERE owner_actor_id=?').get(context.actorId)?.n) >= 100) throw new ServerSpaceError('invalid', -32602);
        const id = randomUUID();
        this.db.transaction(() => {
          this.db.prepare('INSERT INTO collaboration_spaces(id,name,owner_actor_id,created_at,open_contact) VALUES(?,?,?,?,1)').run(id,input.name.trim(),context.actorId,this.now());
          this.db.prepare("INSERT INTO collaboration_space_members VALUES(?,?,'owner',?)").run(id,context.actorId,this.now());
        });
        return {spaceId:id,directory:this.directory(context)};
      }
      case 'members': return {members:this.members(context,input.spaceId)};
      case 'invite': {
        this.member(input.spaceId,context,true);
        this.db.prepare('DELETE FROM collaboration_space_invitations WHERE expires_at<=?').run(this.now());
        if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM collaboration_space_invitations WHERE space_id=? AND used_by IS NULL').get(input.spaceId)?.n) >= 100) throw new ServerSpaceError('invalid', -32602);
        const code = randomToken(32), expiresAt = this.now() + 24 * 3600_000;
        this.db.prepare('INSERT INTO collaboration_space_invitations VALUES(?,?,?,?,NULL)').run(digest(code),input.spaceId,context.actorId,expiresAt);
        return {code,expiresAt};
      }
      case 'join': {
        if (typeof input.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(input.code)) throw new ServerSpaceError('invitation');
        return this.db.transaction(() => {
          const row = this.db.prepare('SELECT * FROM collaboration_space_invitations WHERE digest=?').get(digest(input.code));
          if (!row || Number(row.expires_at) <= this.now() || row.used_by !== null && row.used_by !== context.actorId
            || this.role(String(row.space_id),String(row.created_by)) !== 'owner') throw new ServerSpaceError('invitation');
          if(this.role(String(row.space_id),context.actorId))return {spaceId:String(row.space_id),directory:this.directory(context)};
          if (row.used_by === context.actorId) return {spaceId:String(row.space_id),directory:this.directory(context)};
          this.db.prepare("INSERT OR IGNORE INTO collaboration_space_members VALUES(?,?,'member',?)").run(String(row.space_id),context.actorId,this.now());
          this.db.prepare('UPDATE collaboration_space_invitations SET used_by=? WHERE digest=?').run(context.actorId,digest(input.code));
          return {spaceId:String(row.space_id),directory:this.directory(context)};
        });
      }
      case 'contact': {
        this.member(input.spaceId,context,true);
        if (typeof input.open !== 'boolean') throw new ServerSpaceError('invalid', -32602);
        this.db.prepare('UPDATE collaboration_spaces SET open_contact=? WHERE id=?').run(input.open ? 1 : 0,input.spaceId);
        return this.directory(context);
      }
      case 'addBot': {
        // A Bot joins as a peer member. It cannot accept an invitation, so the owner adds it,
        // and it belongs to exactly one space so its phonebook has one boundary.
        this.member(input.spaceId,context,true);
        if (!valid(input.actorId)) throw new ServerSpaceError('invalid', -32602);
        const bot = this.db.prepare('SELECT kind,enabled,created_by FROM actors WHERE id=?').get(input.actorId);
        if (!bot || bot.kind !== 'session' || bot.enabled !== 1) throw new ServerSpaceError('invalid', -32602);
        // Only a Bot the owner manages: it is theirs to place, and it can sit in one space only.
        if (bot.created_by !== context.actorId && !this.#managedBots(context.actorId).some(b => b.actorId === input.actorId)) deny();
        const elsewhere = this.db.prepare('SELECT space_id FROM collaboration_space_members WHERE actor_id=?').get(input.actorId);
        if (elsewhere && elsewhere.space_id !== input.spaceId) deny();
        this.db.prepare("INSERT OR IGNORE INTO collaboration_space_members VALUES(?,?,'member',?)").run(input.spaceId,input.actorId,this.now());
        return {members:this.members(context,input.spaceId)};
      }
      case 'bots': {
        this.member(input.spaceId,context,true);
        const placed = new Set((this.db.prepare('SELECT actor_id FROM collaboration_space_members').all()).map(r => String(r.actor_id)));
        return {bots:this.#managedBots(context.actorId).filter(b => !placed.has(b.actorId))};
      }
      case 'remove': {
        this.member(input.spaceId,context,true);
        if (this.role(input.spaceId,input.actorId) === 'owner') throw new ServerSpaceError('owner');
        this.db.prepare('DELETE FROM collaboration_space_members WHERE space_id=? AND actor_id=?').run(input.spaceId,input.actorId);
        return {members:this.members(context,input.spaceId)};
      }
      default: throw new ServerSpaceError('invalid', -32602);
    }
  }
}
