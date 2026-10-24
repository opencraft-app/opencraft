import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createSchemaValidator, openManagedDatabase, type DatabaseOutcome } from '@opencraft/sqlite-node';
import { parsePrincipal, principalKey, type Principal } from '@opencraft/identity-core';
import type { Actor, ActorContext, ActorKind } from '@opencraft/identity-core/actors';

const SCHEMA = `
CREATE TABLE actor_authority (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL) STRICT;
CREATE TABLE actors (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('human','session')),
 display_name TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), generation INTEGER NOT NULL,
 created_at INTEGER NOT NULL, created_by TEXT) STRICT;
CREATE TABLE actor_bindings (binding TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES actors(id)) STRICT;
CREATE TABLE actor_credentials (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES actors(id),
 digest TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1))) STRICT;
CREATE TABLE actor_grants (actor_id TEXT NOT NULL REFERENCES actors(id), resource TEXT NOT NULL,
 action TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), PRIMARY KEY(actor_id,resource,action)) STRICT;
CREATE TABLE actor_audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, operator TEXT NOT NULL,
 actor_id TEXT NOT NULL, action TEXT NOT NULL, resource TEXT) STRICT;
`;
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
  readonly #resourceAuthorities = new Set<(resource: string) => boolean>();
  /** Trusted local resource adapters only; registration confers no grants. */
  registerResourceAuthority(owns: (resource: string) => boolean): () => void { this.#resourceAuthorities.add(owns); return () => { this.#resourceAuthorities.delete(owns); }; }
  readonly #db: DatabaseSync;
  readonly authority: string;
  readonly outcome: DatabaseOutcome;
  constructor(path: string, readonly now: () => number = Date.now) {
    const managed = openManagedDatabase({ path, legacyPolicy: 'reject', migrations: [{ version: 1, name: 'actor-identities', sql: SCHEMA }], validateSchema: createSchemaValidator(SCHEMA) });
    this.#db = managed.database;
    this.outcome = managed.outcome;
    this.#db.exec('PRAGMA foreign_keys=ON');
    this.#db.prepare('INSERT OR IGNORE INTO actor_authority(singleton,id) VALUES(1,?)').run(randomUUID());
    this.authority = this.#db.prepare('SELECT id FROM actor_authority WHERE singleton=1').get()!.id as string;
  }
  get managementResource() { return `actor-registry://${this.authority}`; }
  get(id: string): Actor | null {
    const row = this.#db.prepare('SELECT * FROM actors WHERE id=?').get(id);
    return row ? actor(row) : null;
  }
  list(): Actor[] { return this.#db.prepare('SELECT * FROM actors ORDER BY created_at,id').all().map(actor); }
  /** Lookup only: an unrecognized verified identity is not registered by a read. */
  findHuman(verified: Pick<Principal, 'provider' | 'subject'>): Actor | null {
    const row = this.#db.prepare('SELECT actor_id FROM actor_bindings WHERE binding=?').get(principalKey(verified));
    return row ? this.get(row.actor_id as string) : null;
  }
  bindings(actorId: string): Pick<Principal, 'provider' | 'subject'>[] {
    return this.#db.prepare('SELECT binding FROM actor_bindings WHERE actor_id=? ORDER BY binding').all(actorId)
      .map(row => { const [provider, subject] = JSON.parse(row.binding as string); return { provider, subject }; });
  }
  /** Both arguments must come from trusted, independently verified authentication. */
  bindHuman(owner: ActorContext, verified: Principal): void {
    const p = parsePrincipal(verified);
    this.#transaction(() => {
      if (!this.isCurrent(owner) || this.get(owner.actorId)?.kind !== 'human' || p.expiresAt <= this.now()) throw new Error('Human verification required');
      const existing = this.findHuman(p);
      if (existing && existing.id !== owner.actorId) throw new Error('Identity already belongs to another human');
      if (!existing) {
        if (this.bindings(owner.actorId).length >= 32) throw new Error('Too many login identities');
        this.#db.prepare('INSERT INTO actor_bindings VALUES(?,?)').run(principalKey(p), owner.actorId);
        this.#audit(owner.actorId, owner.actorId, 'bind-identity', principalKey(p));
      }
    });
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
  }
  #transaction<T>(run: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.#db.exec('COMMIT'); return result; }
    catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
  }
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
    return this.#transaction(() => {
      const key = principalKey(p);
      const binding = this.#db.prepare('SELECT actor_id FROM actor_bindings WHERE binding=?').get(key);
      const existing = binding ? this.get(binding.actor_id as string)! : null;
      if (existing && (!existing.enabled || existing.kind !== 'human')) return null;
      const identity = existing ?? this.#create('human', p.displayName, null);
      if (!existing) this.#db.prepare('INSERT INTO actor_bindings VALUES(?,?)').run(key, identity.id);
      else if (existing.displayName !== p.displayName) this.#db.prepare('UPDATE actors SET display_name=? WHERE id=?').run(name(p.displayName), identity.id);
      return Object.freeze({ actorId: identity.id, generation: identity.generation, credentialId: null, expiresAt: p.expiresAt });
    });
  }
  createSession(displayName: string, operator: string): Actor {
    return this.#transaction(() => this.#create('session', displayName, operator));
  }
  setEnabled(id: string, enabled: boolean, operator: string) {
    if (typeof enabled !== 'boolean' || !this.get(id)) throw new Error('Invalid actor');
    this.#transaction(() => {
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
    const row = this.#db.prepare('SELECT * FROM actor_credentials WHERE id=?').get(context.credentialId);
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
    return this.isCurrent(context) && !!this.#db.prepare('SELECT 1 FROM actor_grants WHERE actor_id=? AND resource=? AND action=? AND enabled=1')
      .get(context.actorId, resource, action);
  }
  /** Revalidate a durably admitted operation; never use this to authenticate a request. */
  canAdmitted(actorId: string, generation: number, resource: string, action: string): boolean {
    permission(resource, action);
    const current = this.get(actorId);
    return !!current?.enabled && current.generation === generation
      && !!this.#db.prepare('SELECT 1 FROM actor_grants WHERE actor_id=? AND resource=? AND action=? AND enabled=1')
        .get(actorId, resource, action);
  }
  audit() { return this.#db.prepare('SELECT * FROM actor_audit ORDER BY id DESC LIMIT 1000').all(); }
  close() { this.#db.close(); }
}

export function isActorAuthorization(value: string | undefined): boolean {
  return typeof value === 'string' && /^Bearer\s+oc_actor_/iu.test(value);
}
