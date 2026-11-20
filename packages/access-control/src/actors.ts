import { PermissionReadCache, withPermissionWrite } from "./permission-read-cache.js";
import { sqliteTransaction } from "@opencraft/sqlite-node";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseOutcome } from "@opencraft/sqlite-node";
import { openServerRepository, type ServerDatabaseSource } from "@opencraft/storage-node/server-repository";
import { parsePrincipal, principalKey, type Principal } from '@opencraft/identity-core';
import type { Actor, ActorContext, ActorKind } from '@opencraft/identity-core/actors';
import { humanActorPolicy, assistantMemberPolicy, actorPolicyFromEnvironment, type ActorCapability, type ActorPolicy } from './actor-policy.js';
export { humanActorPolicy, assistantMemberPolicy, actorPolicyFromEnvironment, ACTOR_POLICY_ENVIRONMENT, type AssistantMemberPolicyOptions, type ActorCapability, type ActorPolicy, type ActorPolicyRequest } from './actor-policy.js';


const TOKEN_PREFIX = 'oc_actor_v1.';
function name(value: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f]/u.test(value)) throw new Error('Invalid actor name');
  return value;
}
function permission(resource: string, action: string) {
  if (typeof resource !== 'string' || resource.length > 1024 || !/^[a-z][a-z0-9+.-]*:\/\//u.test(resource)
    || /[\x00-\x20]/u.test(resource) || typeof action !== 'string' || !/^[a-z][a-z0-9:._-]{0,63}$/u.test(action)) throw new Error('Invalid actor permission');
  const url = new URL(resource);
  if (!url.hostname || url.username || url.password || url.hash || url.search) throw new Error('Invalid actor resource');
}
function actor(row: Record<string, unknown>): Actor {
  return Object.freeze({ id: row.id as string, kind: row.kind as ActorKind, displayName: row.display_name as string,
    enabled: row.enabled === 1, generation: row.generation as number, createdAt: row.created_at as number,
    createdBy: row.created_by as string | null });
}

/** Server-owned identity authority. Mutation methods are trusted local operations;
 * network callers must go through ActorAccess, not call these using body-supplied identities. */
export class ActorStore {
  readonly #reservationResolvers = new Set<(principal: Principal) => { alias: string; binding: Pick<Principal, 'provider' | 'subject'> | null } | null>();
  /** Installation-owned verified directory policy. A resolver cannot grant admission. */
  registerHumanReservationResolver(resolve: (principal: Principal) => { alias: string; binding: Pick<Principal, 'provider' | 'subject'> | null } | null): () => void {
    this.#reservationResolvers.add(resolve); return () => { this.#reservationResolvers.delete(resolve); };
  }
  /** Trusted directory roster lookup, never a login binding or admission grant. */
  findReservedHuman(binding: Pick<Principal, 'provider' | 'subject'>): Actor | null {
    if (!this.#hasReservations) return null;
    const row = this.#db.prepare("SELECT actor_id FROM actor_human_reservations WHERE binding=? AND state='pending'").get(principalKey(binding));
    return row && this.isReservedHuman(String(row.actor_id)) ? this.get(String(row.actor_id)) : null;
  }
  isReservedHuman(id: string): boolean {
    if (!this.#hasReservations) return false;
    const candidate = this.get(id);
    return !!candidate && candidate.kind === 'human' && !candidate.enabled && candidate.generation === 1
      && !!this.#db.prepare("SELECT 1 FROM actor_human_reservations WHERE actor_id=? AND state='pending'").get(id)
      && this.bindings(id).length === 0;
  }
  /** Storage Worker only. A reservation can appear in a roster but cannot authenticate. */
  reserveHuman(input: { binding: Pick<Principal, 'provider' | 'subject'>; loginProvider: string; alias: string }): Actor {
    if (this.#permissionProjectionEnabled || !this.#hasReservations) throw Error('Human reservation requires storage Worker');
    const { binding, loginProvider, alias } = input;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(binding?.provider ?? '')
      || !/^[A-Za-z0-9:@._-]{1,256}$/u.test(binding?.subject ?? '')
      || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(loginProvider) || binding.provider === loginProvider
      || typeof alias !== 'string' || !/^[a-z0-9._-]{1,128}$/u.test(alias)) throw Error('Invalid human reservation');
    return this.#transaction(() => {
      const key = principalKey(binding), prior = this.findHuman(binding);
      const reservation = this.#db.prepare('SELECT * FROM actor_human_reservations WHERE binding=?').get(key);
      if (prior) return prior;
      if (reservation) {
        if (reservation.login_provider !== loginProvider || reservation.alias !== alias || reservation.state !== 'pending')
          throw Error('Human reservation conflict');
        return this.get(String(reservation.actor_id))!;
      }
      const id = `human://${this.authority}/${randomUUID()}`;
      this.#db.prepare('INSERT INTO actors VALUES(?,?,?,0,1,?,NULL)').run(id, 'human', alias, this.now());
      this.#db.prepare("INSERT INTO actor_human_reservations VALUES(?,?,?,?,?,'pending')").run(key,id,loginProvider,alias,this.now());
      this.#audit('trusted-directory', id, 'reserve-human', key);
      return this.get(id)!;
    });
  }
  readonly #humanRegistrationListeners = new Set<(principal: Principal, context: ActorContext) => void>();
  /** Trusted local credential adapters; only newly registered humans emit this post-commit event. */
  onHumanRegistered(listener: (principal: Principal, context: ActorContext) => void): () => void {
    this.#humanRegistrationListeners.add(listener);
    return () => { this.#humanRegistrationListeners.delete(listener); };
  }
  readonly #identityListeners = new Set<(actorId: string) => void>();
  /** Post-commit binding notifications. Observers confer no identity or permissions. */
  onIdentityChanged(listener: (actorId: string) => void): () => void {
    this.#identityListeners.add(listener);
    return () => { this.#identityListeners.delete(listener); };
  }
  #identityChanged(actorId: string) {
    for (const listener of this.#identityListeners) {
      try { listener(actorId); } catch { /* Observers cannot undo a committed identity mutation. */ }
    }
  }
  readonly #resourceAuthorities = new Set<(resource: string) => boolean>();
  /** Trusted local resource adapters only; registration confers no grants. */
  registerResourceAuthority(owns: (resource: string) => boolean): () => void { this.#resourceAuthorities.add(owns); return () => { this.#resourceAuthorities.delete(owns); }; }
  readonly #db: DatabaseSync;
  readonly #readCache: PermissionReadCache;
  readonly #permissionProjectionEnabled: boolean;
  readonly #hasReservations: boolean;
  readonly authority: string;
  readonly outcome: DatabaseOutcome;
  readonly #closeDatabase: () => void;
  readonly #policy: ActorPolicy;
  constructor(path: ServerDatabaseSource, readonly now: () => number = Date.now, options: { permissionProjection?: boolean; policy?: ActorPolicy } = {}) {
    this.#policy = options.policy ?? actorPolicyFromEnvironment();
    const managed = openServerRepository(path, "actors");
    this.#closeDatabase = managed.close;
    this.#db = managed.database;
    this.#permissionProjectionEnabled = typeof path !== "string" && options.permissionProjection !== false;
    this.#readCache = new PermissionReadCache(() => this.#permissionRows(), { enabled: this.#permissionProjectionEnabled, owner: typeof path === "string" ? this.#db : path.database });
    this.#hasReservations = !!this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='actor_human_reservations'").get();
    this.outcome = managed.outcome;
    this.#db.exec('PRAGMA foreign_keys=ON');
    this.#db.prepare('INSERT OR IGNORE INTO actor_authority(singleton,id) VALUES(1,?)').run(randomUUID());
    this.authority = this.#db.prepare('SELECT id FROM actor_authority WHERE singleton=1').get()!.id as string;
  }
  *#permissionRows(): Iterable<readonly [string, unknown]> {
    for (const row of this.#db.prepare('SELECT * FROM actors').iterate()) yield [JSON.stringify(["actor", row.id]), row];
    const bindings = new Map<string, Record<string, unknown>[]>();
    for (const row of this.#db.prepare('SELECT binding,actor_id FROM actor_bindings').iterate()) {
      yield [JSON.stringify(["binding", row.binding]), row];
      const list = bindings.get(String(row.actor_id)) ?? []; list.push(row); bindings.set(String(row.actor_id), list);
    }
    for (const [id, rows] of bindings) yield [JSON.stringify(["bindings", id]), rows];
    for (const row of this.#db.prepare('SELECT id,actor_id,generation,expires_at,enabled FROM actor_credentials').iterate())
      yield [JSON.stringify(["credential", row.id]), row];
    for (const row of this.#db.prepare('SELECT actor_id,resource,action FROM actor_grants WHERE enabled=1').iterate())
      yield [JSON.stringify(["grant", row.actor_id, row.resource, row.action]), true];
  }
  get managementResource() { return `actor-registry://${this.authority}`; }
  get(id: string): Actor | null {
    const row = this.#readCache.get(JSON.stringify(['actor',id]), () => this.#db.prepare('SELECT * FROM actors WHERE id=?').get(id));
    return row ? actor(row) : null;
  }
  list(): Actor[] { return this.#db.prepare('SELECT * FROM actors ORDER BY created_at,id').all().map(actor); }
  /** Lookup only: an unrecognized verified identity is not registered by a read. */
  findHuman(verified: Pick<Principal, 'provider' | 'subject'>): Actor | null {
    const binding = principalKey(verified);
    const row = this.#readCache.get(JSON.stringify(['binding',binding]), () => this.#db.prepare('SELECT actor_id FROM actor_bindings WHERE binding=?').get(binding));
    return row ? this.get(row.actor_id as string) : null;
  }
  bindings(actorId: string): Pick<Principal, 'provider' | 'subject'>[] {
    return (this.#readCache.get(JSON.stringify(['bindings',actorId]), () => this.#db.prepare('SELECT binding FROM actor_bindings WHERE actor_id=? ORDER BY binding').all(actorId)) ?? [])
      .map(row => { const [provider, subject] = JSON.parse(row.binding as string); return { provider, subject }; });
  }
  /** Both arguments must come from trusted, independently verified authentication. */
  bindHuman(owner: ActorContext, verified: Principal): void {
    const p = parsePrincipal(verified);
    let changed = false;
    this.#transaction(() => {
      if (!this.isCurrent(owner) || this.get(owner.actorId)?.kind !== 'human' || p.expiresAt <= this.now()) throw new Error('Human verification required');
      const existing = this.findHuman(p);
      if (existing && existing.id !== owner.actorId) throw new Error('Identity already belongs to another human');
      if (!existing) {
        if (this.bindings(owner.actorId).length >= 32) throw new Error('Too many login identities');
        // A login may have registered before the roster reservation committed.
        // Retire only the untouched, disabled placeholder; never merge user data.
        if (this.#hasReservations) {
          const reservation = this.#db.prepare('SELECT * FROM actor_human_reservations WHERE binding=?').get(principalKey(p));
          if (reservation) {
            if (reservation.state !== 'pending') {
              if (reservation.state !== 'claimed' || reservation.actor_id !== owner.actorId) throw Error('Human reservation retired');
            } else {
              const placeholder = this.get(String(reservation.actor_id));
              if (!placeholder || placeholder.enabled || placeholder.generation !== 1 || this.bindings(placeholder.id).length
                || this.#db.prepare('SELECT 1 FROM actor_members WHERE actor_id=?').get(placeholder.id)
                || !this.bindings(owner.actorId).some(binding => binding.provider === reservation.login_provider)) throw Error('Human reservation conflict');
              this.#db.prepare("UPDATE actor_human_reservations SET actor_id=?,state='claimed' WHERE binding=?").run(owner.actorId,principalKey(p));
              // Dormant directory roster rows carry no access or user history.
              // A following source projection resolves the verified existing Actor.
              this.#db.prepare('DELETE FROM actor_channel_reads WHERE actor_id=?').run(placeholder.id);
              this.#db.prepare('DELETE FROM actor_channel_members WHERE actor_id=?').run(placeholder.id);
              // Other foreign keys refuse deletion if an administrator attached resources.
              this.#db.prepare('DELETE FROM actors WHERE id=?').run(placeholder.id);
              this.#audit(owner.actorId,owner.actorId,'retire-unused-reservation',placeholder.id);
            }
          }
        }
        this.#db.prepare('INSERT INTO actor_bindings VALUES(?,?)').run(principalKey(p), owner.actorId);
        this.#audit(owner.actorId, owner.actorId, 'bind-identity', principalKey(p));
        changed = true;
      }
    });
    if (changed) this.#identityChanged(owner.actorId);
  }
  unbindHuman(owner: ActorContext, binding: Pick<Principal, 'provider' | 'subject'>): void {
    this.#transaction(() => {
      if (!this.isCurrent(owner) || this.get(owner.actorId)?.kind !== 'human'
        || this.findHuman(binding)?.id !== owner.actorId) throw new Error('Human verification required');
      if (this.bindings(owner.actorId).length <= 1) throw new Error('Cannot remove the last login identity');
      this.#db.prepare('DELETE FROM actor_bindings WHERE binding=? AND actor_id=?').run(principalKey(binding), owner.actorId);
      // Fence every cached context, including open sockets and browser sessions.
      this.#db.prepare('UPDATE actors SET generation=generation+1 WHERE id=?').run(owner.actorId);
      this.#audit(owner.actorId, owner.actorId, 'unbind-identity', principalKey(binding));
    });
    this.#identityChanged(owner.actorId);
  }
  #transaction<T>(run: () => T): T { return withPermissionWrite(() => sqliteTransaction(this.#db, run), this.#readCache); }
  #audit(operator: string, actorId: string, action: string, resource: string | null = null) {
    if (typeof operator !== 'string' || !operator || operator.length > 512) throw new Error('Invalid actor operator');
    this.#db.prepare('INSERT INTO actor_audit(at,operator,actor_id,action,resource) VALUES(?,?,?,?,?)')
      .run(this.now(), operator, actorId, action, resource);
  }
  #create(kind: ActorKind, displayName: string, createdBy: string | null): Actor {
    const id = `${kind}://${this.authority}/${randomUUID()}`;
    this.#db.prepare('INSERT INTO actors VALUES(?,?,?,1,1,?,?)').run(id, kind, name(displayName), this.now(), createdBy);
    this.#audit(createdBy ?? 'verified-provider', id, 'register');
    return this.get(id)!;
  }
  /** Only call after provider verification and admission. Aliases/display names never bind identities. */
  resolveHuman(verified: Principal): ActorContext | null {
    const p = parsePrincipal(verified);
    if (p.expiresAt <= this.now()) return null;
    if (this.#permissionProjectionEnabled) {
      const existing = this.findHuman(p);
      if (existing && (!existing.enabled || existing.kind !== 'human')) return null;
      if (existing?.displayName === p.displayName)
        return Object.freeze({ actorId: existing.id, generation: existing.generation, credentialId: null, expiresAt: p.expiresAt });
    }
    let registered = false;
    const context = this.#transaction(() => {
      const key = principalKey(p);
      const binding = this.#db.prepare('SELECT actor_id FROM actor_bindings WHERE binding=?').get(key);
      const existing = binding ? this.get(binding.actor_id as string)! : null;
      if (existing && (!existing.enabled || existing.kind !== 'human')) return null;
      let reserved: Actor | null = null;
      if (!existing && this.#reservationResolvers.size) {
        const claims = [...this.#reservationResolvers].map(resolve => resolve(p)).filter(value => value !== null);
        if (claims.length > 1) throw Error('Ambiguous human reservation claim');
        const claim = claims[0];
        if (claim) {
          const rows = this.#db.prepare('SELECT * FROM actor_human_reservations WHERE login_provider=? AND alias=?').all(p.provider, claim.alias);
          if (claim.binding && rows.some(row => row.binding === principalKey(claim.binding!) && row.state !== 'pending'))
            throw Error('Human reservation retired');
          const pending = rows.filter(row => row.state === 'pending');
          const match = claim.binding ? pending.find(row => row.binding === principalKey(claim.binding!)) : undefined;
          if ((rows.length && !claim.binding) || (pending.length && !match)) throw Error('Current directory evidence required for human reservation');
          if (match) {
            const candidate = this.get(String(match.actor_id));
            if (!candidate || candidate.enabled || candidate.kind !== 'human' || candidate.generation !== 1
              || this.bindings(candidate.id).length !== 0 || this.findHuman(claim.binding!)) throw Error('Human reservation conflict');
            this.#db.prepare('INSERT INTO actor_bindings VALUES(?,?)').run(String(match.binding), candidate.id);
            this.#db.prepare('UPDATE actors SET enabled=1,display_name=? WHERE id=?').run(name(p.displayName),candidate.id);
            this.#db.prepare("UPDATE actor_human_reservations SET state='claimed' WHERE binding=? AND state='pending'").run(String(match.binding));
            this.#audit('verified-provider',candidate.id,'claim-human',key);
            reserved = this.get(candidate.id);
          }
        }
      }
      const identity = existing ?? reserved ?? this.#create('human', p.displayName, null);
      if (!existing) {
        this.#db.prepare('INSERT INTO actor_bindings VALUES(?,?)').run(key, identity.id);
        registered = true;
      }
      else if (existing.displayName !== p.displayName) this.#db.prepare('UPDATE actors SET display_name=? WHERE id=?').run(name(p.displayName), identity.id);
      return Object.freeze({ actorId: identity.id, generation: identity.generation, credentialId: null, expiresAt: p.expiresAt });
    });
    if (registered && context) for (const listener of this.#humanRegistrationListeners) {
      try { listener(p, context); }
      catch { console.warn('Human registration credential adapter failed'); }
    }
    return context;
  }
  /** A committed disabled reservation confers neither identity nor permission. */
  acceptReservedHuman(value: Actor): void {
    if (value.kind !== 'human' || value.enabled || value.generation !== 1
      || !value.id.startsWith('human://' + this.authority + '/')) return;
    this.#readCache.seedMissing(JSON.stringify(['actor', value.id]), { id: value.id, kind: 'human',
      display_name: value.displayName, enabled: 0, generation: 1, created_at: value.createdAt, created_by: value.createdBy });
  }
  /** Trusted storage Worker publication only. Not an Actor/RPC mutation endpoint. */
  acceptCreatedSession(value: Actor): void {
    if(value.kind!=='session'||value.generation!==1||!value.enabled||!value.id.startsWith('session://'+this.authority+'/'))
      throw Error('Invalid created session publication');
    this.#readCache.seedMissing(JSON.stringify(['actor',value.id]),{id:value.id,kind:value.kind,display_name:value.displayName,
      enabled:1,generation:value.generation,created_at:value.createdAt,created_by:value.createdBy});
  }
  /** Publish a newly issued opaque credential's verification facts, never its secret. */
  acceptCreatedCredential(row: {id:string;actor_id:string;generation:number;expires_at:number;enabled:1}): void {
    const actor=this.get(row.actor_id);
    if(!actor || actor.kind!=='session' || actor.generation!==row.generation)throw Error('Invalid credential publication');
    this.#readCache.seedMissing(JSON.stringify(['credential',row.id]),row);
  }
  createSession(displayName: string, operator: string): Actor {
    return this.#transaction(() => this.#create('session', displayName, operator));
  }
  acceptRetiredCredential(id:string){
    if(!/^[0-9a-f-]{36}$/u.test(id))throw Error('Invalid credential retirement');
    this.#readCache.retireCredential(id);
  }
  /** Trusted communication receipt; display metadata is not an authorization mutation. */
  acceptSessionPresentation(id:string,displayName:string,revision:number){
    if(!id.startsWith('session://'+this.authority+'/')||!Number.isSafeInteger(revision)||revision<0)throw Error('Invalid session presentation');
    this.#readCache.updateActorName(id,name(displayName),revision);
  }
  /** Trusted storage owner only. Renaming does not replace identity or grant permissions. */
  renameSession(id:string,displayName:string,operator:string){
    if(this.get(id)?.kind!=='session')throw Error('Invalid session');
    this.#transaction(()=>{this.#db.prepare('UPDATE actors SET display_name=? WHERE id=?').run(name(displayName),id);this.#audit(operator,id,'rename');});
  }
  setEnabled(id: string, enabled: boolean, operator: string) {
    if (typeof enabled !== 'boolean' || !this.get(id)) throw new Error('Invalid actor');
    this.#transaction(() => {
      // An operator disable also revokes a pending directory reservation; later
      // login must never undo that decision merely because it was already disabled.
      if (!enabled && this.#hasReservations)
        this.#db.prepare("UPDATE actor_human_reservations SET state='revoked' WHERE actor_id=? AND state='pending'").run(id);
      // Every state transition fences old contexts and credentials, including re-enablement.
      this.#db.prepare('UPDATE actors SET enabled=?,generation=generation+1 WHERE id=? AND enabled<>?').run(enabled ? 1 : 0, id, enabled ? 1 : 0);
      this.#audit(operator, id, enabled ? 'enable' : 'disable');
    });
  }
  issueCredential(id: string, expiresAt: number, operator: string): { credentialId: string; token: string; expiresAt: number } {
    const a = this.get(id);
    if (!a?.enabled || a.kind !== 'session' || !Number.isSafeInteger(expiresAt) || expiresAt <= this.now()
      || expiresAt > this.now() + 30 * 86400_000) throw new Error('Invalid session credential');
    return this.#transaction(() => {
      const credentialId = randomUUID();
      const token = `${TOKEN_PREFIX}${this.authority}.${credentialId}.${randomBytes(32).toString('base64url')}`;
      this.#db.prepare('INSERT INTO actor_credentials VALUES(?,?,?,?,?,1)')
        .run(credentialId, id, createHash('sha256').update(token).digest('hex'), a.generation, expiresAt);
      this.#audit(operator, id, 'issue-credential', credentialId);
      return { credentialId, token, expiresAt };
    });
  }
  revokeCredential(id: string, operator: string) {
    this.#transaction(() => {
      const row = this.#db.prepare('SELECT actor_id FROM actor_credentials WHERE id=?').get(id);
      if (!row) throw new Error('Unknown credential');
      this.#db.prepare('UPDATE actor_credentials SET enabled=0 WHERE id=?').run(id);
      this.#audit(operator, row.actor_id as string, 'revoke-credential', id);
    });
  }
  authenticateSession(token: string): ActorContext | null {
    if (typeof token !== 'string' || token.length > 256) return null;
    const parts = token.split('.');
    if (parts.length !== 4 || `${parts[0]}.` !== TOKEN_PREFIX || parts[1] !== this.authority
      || !/^[0-9a-f-]{36}$/u.test(parts[2]!) || !/^[A-Za-z0-9_-]{43}$/u.test(parts[3]!)) return null;
    const row = this.#db.prepare('SELECT * FROM actor_credentials WHERE id=?').get(parts[2]!);
    if (!row || !timingSafeEqual(Buffer.from(row.digest as string, 'hex'), createHash('sha256').update(token).digest())) return null;
    const context = Object.freeze({ actorId: row.actor_id as string, credentialId: row.id as string,
      generation: row.generation as number, expiresAt: row.expires_at as number });
    return this.isCurrent(context) ? context : null;
  }
  isCurrent(context: ActorContext): boolean {
    const a = this.get(context.actorId);
    if (!a?.enabled || a.generation !== context.generation || !Number.isSafeInteger(context.expiresAt) || context.expiresAt <= this.now()) return false;
    if (context.credentialId === null) return a.kind === 'human';
    const row = this.#readCache.get(JSON.stringify(['credential', context.credentialId]), () => this.#db.prepare('SELECT * FROM actor_credentials WHERE id=?').get(context.credentialId));
    return a.kind === 'session' && !!row && row.actor_id === a.id && row.enabled === 1
      && row.generation === a.generation && (row.expires_at as number) >= context.expiresAt;
  }
  setGrant(id: string, resource: string, action: string, enabled: boolean, operator: string) {
    permission(resource, action);
    if (!this.get(id) || typeof enabled !== 'boolean') throw new Error('Invalid actor grant');
    // This store owns its registry and local Actor resources. It cannot grant a
    // foreign Hub's resources or an engine's workspace permissions on their behalf.
    if (resource !== this.managementResource && !this.get(resource) && ![...this.#resourceAuthorities].some(owns => owns(resource))) throw new Error('Resource authority required');
    this.#transaction(() => {
      this.#db.prepare('INSERT INTO actor_grants VALUES(?,?,?,?) ON CONFLICT(actor_id,resource,action) DO UPDATE SET enabled=excluded.enabled')
        .run(id, resource, action, enabled ? 1 : 0);
      this.#audit(operator, id, enabled ? 'grant:' + action : 'revoke:' + action, resource);
    });
  }
  can(context: ActorContext, resource: string, action: string): boolean {
    permission(resource, action);
    return this.isCurrent(context) && !!this.#readCache.get(JSON.stringify(['grant', context.actorId, resource, action]), () => this.#db.prepare('SELECT 1 FROM actor_grants WHERE actor_id=? AND resource=? AND action=? AND enabled=1').get(context.actorId, resource, action));
  }
  /** Revalidate a durably admitted operation; never use this to authenticate a request. */
  /**
   * Standing-based capability decision for a current Actor. It complements exact
   * grants and never authenticates a request; an unavailable Actor, stale context,
   * a throwing policy or any value other than `true` denies.
   */
  allows(context: ActorContext, capability: ActorCapability, resource?: string, use = false): boolean {
    return this.isCurrent(context) && this.#standing(this.get(context.actorId), capability, resource, use);
  }
  /** Revalidate a durably admitted operation's standing; never authenticates a request. */
  allowsAdmitted(actorId: string, generation: number, capability: ActorCapability, resource?: string): boolean {
    const actor = this.get(actorId);
    return !!actor?.enabled && actor.generation === generation && this.#standing(actor, capability, resource);
  }
  #standing(actor: Actor | null, capability: ActorCapability, resource?: string, use = false): boolean {
    if (!actor) return false;
    try { return this.#policy(Object.freeze({ actor, capability, ...(resource === undefined ? {} : { resource }), ...(use ? { use } : {}) })) === true; }
    catch { return false; }
  }
  canAdmitted(actorId: string, generation: number, resource: string, action: string): boolean {
    permission(resource, action);
    const current = this.get(actorId);
    return !!current?.enabled && current.generation === generation
      && !!this.#readCache.get(JSON.stringify(['grant', actorId, resource, action]), () => this.#db.prepare('SELECT 1 FROM actor_grants WHERE actor_id=? AND resource=? AND action=? AND enabled=1').get(actorId, resource, action));
  }
  audit() { return this.#db.prepare('SELECT * FROM actor_audit ORDER BY id DESC LIMIT 1000').all(); }
  close() { this.#readCache.close(); this.#humanRegistrationListeners.clear(); this.#identityListeners.clear(); this.#closeDatabase(); }
}

export function isActorAuthorization(value: string | undefined): boolean {
  return typeof value === 'string' && /^Bearer\s+oc_actor_/iu.test(value);
}
