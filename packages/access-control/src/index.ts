import type { DatabaseSync } from "node:sqlite";
import { createSchemaValidator, openManagedDatabase, type DatabaseOutcome } from "@opencraft/sqlite-node";
import { parsePrincipal, principalKey, type Principal } from "@opencraft/identity-core";
import type { IdentityProvider, IdentityRequest } from "@opencraft/identity-core/node";
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ActorStore } from './actors.js';
const BASELINE = `CREATE TABLE members (binding TEXT PRIMARY KEY NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), enabled INTEGER NOT NULL CHECK(enabled IN (0,1))) STRICT;
CREATE TABLE access_audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, operator TEXT NOT NULL, binding TEXT NOT NULL, action TEXT NOT NULL) STRICT;
CREATE TABLE access_imports (source TEXT PRIMARY KEY NOT NULL) STRICT;`;
const ACTOR_MEMBERSHIPS = `CREATE TABLE actor_members (actor_id TEXT PRIMARY KEY NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('admin','member')), enabled INTEGER NOT NULL CHECK(enabled IN (0,1))) STRICT;`;
export type MemberRole = "admin" | "member";
/** Optional trusted provider policy. Cached decisions never authenticate a request. */
export interface InstanceAdmissionPolicy {
  prepare(identity: Principal): Promise<void>;
  allows(identity: Principal): boolean;
  allowsBinding(binding: Pick<Principal, 'provider' | 'subject'>): boolean;
}
export class MembershipStore {
  readonly #db: DatabaseSync;
  readonly outcome: DatabaseOutcome;
  constructor(path: string) {
    const managed = openManagedDatabase({ path, migrations: [
      { version: 1, name: "instance-memberships", sql: BASELINE },
      { version: 2, name: 'actor-memberships', sql: ACTOR_MEMBERSHIPS },
    ], validateSchema: createSchemaValidator(BASELINE + ACTOR_MEMBERSHIPS) });
    this.#db = managed.database; this.outcome = managed.outcome;
  }
  membership(p: Pick<Principal, "provider" | "subject">): { role: MemberRole; enabled: boolean } | null {
    const row = this.#db.prepare("SELECT role,enabled FROM members WHERE binding=?").get(principalKey(p));
    return row ? { role: row.role as MemberRole, enabled: row.enabled === 1 } : null;
  }
  role(p: Pick<Principal, "provider" | "subject">): MemberRole | null {
    const membership = this.membership(p);
    return membership?.enabled ? membership.role : null;
  }
  bindLegacyAlias(p: Principal) {
    const binding = principalKey(p);
    // An explicit stable-subject grant/revocation always wins over a legacy name.
    if (this.#db.prepare('SELECT binding FROM members WHERE binding=?').get(binding)) return;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const subject of p.aliases ?? []) {
        const alias = principalKey({ provider: p.provider, subject });
        const row = this.#db.prepare('SELECT role FROM members WHERE binding=? AND enabled=1').get(alias);
        if (!row) continue;
        this.#db.prepare('INSERT OR IGNORE INTO members(binding,role,enabled) VALUES(?,?,1)').run(binding, row.role!);
        this.#db.prepare('UPDATE members SET enabled=0 WHERE binding=?').run(alias);
        this.#db.prepare('INSERT INTO access_audit(at,operator,binding,action) VALUES(?,?,?,?)').run(Date.now(), 'verified-provider', binding, 'bind-legacy-alias:' + alias);
        break;
      }
      this.#db.exec('COMMIT');
    } catch (e) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw e; }
  }
  list() { return this.#db.prepare("SELECT binding,role,enabled FROM members ORDER BY binding").all(); }
  listActors() { return this.#db.prepare('SELECT actor_id,role,enabled FROM actor_members ORDER BY actor_id').all(); }
  actorMembership(actorId: string): { role: MemberRole; enabled: boolean } | null {
    const row = this.#db.prepare('SELECT role,enabled FROM actor_members WHERE actor_id=?').get(actorId);
    return row ? { role: row.role as MemberRole, enabled: row.enabled === 1 } : null;
  }
  importActorMembership(actorId: string, role: MemberRole) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#db.prepare('INSERT OR IGNORE INTO actor_members VALUES(?,?,1)').run(actorId, role);
      if (result.changes) this.#db.prepare('INSERT INTO access_audit(at,operator,binding,action) VALUES(?,?,?,?)')
        .run(Date.now(), 'verified-provider', actorId, 'import-legacy-actor-membership:' + role);
      this.#db.exec('COMMIT');
    } catch (e) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw e; }
  }
  setActor(actorId: string, role: MemberRole, enabled: boolean, operator: string) {
    if (!/^human:\/\/[^/]+\/[^/]+$/u.test(actorId) || !['admin', 'member'].includes(role)
      || typeof enabled !== 'boolean' || !operator || operator.length > 256) throw new Error('Invalid actor membership');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('INSERT INTO actor_members VALUES(?,?,?) ON CONFLICT(actor_id) DO UPDATE SET role=excluded.role,enabled=excluded.enabled')
        .run(actorId, role, enabled ? 1 : 0);
      this.#db.prepare('INSERT INTO access_audit(at,operator,binding,action) VALUES(?,?,?,?)')
        .run(Date.now(), operator, actorId, JSON.stringify({ role, enabled }));
      this.#db.exec('COMMIT');
    } catch (e) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw e; }
  }
  audit() { return this.#db.prepare("SELECT id,at,operator,binding,action FROM access_audit ORDER BY id DESC LIMIT 1000").all(); }
  set(p: Pick<Principal, "provider" | "subject">, role: MemberRole, enabled: boolean, operator: string) {
    parsePrincipal({ ...p, displayName: p.subject, expiresAt: 0 });
    if (!["admin", "member"].includes(role) || typeof enabled !== "boolean" || !operator || operator.length > 256) throw new Error("Invalid membership change");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("INSERT INTO members(binding,role,enabled) VALUES(?,?,?) ON CONFLICT(binding) DO UPDATE SET role=excluded.role,enabled=excluded.enabled").run(principalKey(p), role, enabled ? 1 : 0);
      this.#db.prepare("INSERT INTO access_audit(at,operator,binding,action) VALUES(?,?,?,?)").run(Date.now(), operator, principalKey(p), JSON.stringify({ role, enabled }));
      this.#db.exec("COMMIT");
    } catch (e) { if (this.#db.isTransaction) this.#db.exec("ROLLBACK"); throw e; }
  }
  /** Compatibility import only once; later administration never resurrects revoked entries. */
  importBindings(source: string, bindings: readonly Pick<Principal, "provider" | "subject">[]) {
    if (this.#db.prepare("SELECT source FROM access_imports WHERE source=?").get(source)) return;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const p of bindings) {
        parsePrincipal({ ...p, displayName: p.subject, expiresAt: 0 });
        this.#db.prepare("INSERT OR IGNORE INTO members(binding,role,enabled) VALUES(?,'member',1)").run(principalKey(p));
      }
      this.#db.prepare("INSERT INTO access_imports(source) VALUES(?)").run(source);
      this.#db.prepare("INSERT INTO access_audit(at,operator,binding,action) VALUES(?,?,?,?)").run(Date.now(), "local-operator", source, "legacy-membership-import");
      this.#db.exec("COMMIT");
    } catch (e) { if (this.#db.isTransaction) this.#db.exec("ROLLBACK"); throw e; }
  }
  close() { this.#db.close(); }
}
export class InstanceAccess {
  readonly #cache = new WeakMap<object, Principal | null>();
  readonly #sources = new WeakMap<Principal, IdentityProvider>();
  private readonly authenticatedMemberProviders: ReadonlySet<string>;
  constructor(readonly store: MembershipStore, readonly providers: readonly IdentityProvider[], readonly actors?: ActorStore,
    authenticatedMemberProviders: readonly string[] = [], readonly admissionPolicy?: InstanceAdmissionPolicy) {
    if (authenticatedMemberProviders.some(provider => !/^[a-z][a-z0-9._-]{0,127}$/u.test(provider))) throw new Error('Invalid authenticated member provider');
    this.authenticatedMemberProviders = new Set(authenticatedMemberProviders);
  }
  authenticate(request: IdentityRequest): Principal | null {
    if (this.#cache.has(request)) return this.#cache.get(request)!;
    // Provider ambiguity is rejected rather than choosing whichever happens to run first.
    const identities = this.providers.map(provider => ({ provider, identity: provider.authenticate(request) }))
      .filter((p): p is { provider: IdentityProvider; identity: Principal } => p.identity !== null);
    const actorIds = identities.map(p => this.actors?.findHuman(p.identity)?.id ?? null);
    const sameHuman = identities.length > 1 && actorIds[0] !== null && actorIds.every(id => id === actorIds[0]);
    const accepted = identities.length === 1 || sameHuman ? identities[0] : null;
    const result = accepted?.identity ?? null;
    if (result && accepted) this.#sources.set(result, accepted.provider);
    if (result && result.expiresAt > Date.now()) this.store.bindLegacyAlias(result);
    this.#cache.set(request, result); return result;
  }
  role(identity: Principal): MemberRole | null {
    if (!this.isCurrent(identity) || this.admissionPolicy?.allows(identity) === false) return null;
    const entry = this.store.membership(identity);
    const legacy = entry?.enabled ? entry.role : null;
    // An explicit stable-subject revocation wins over the provider default.
    if (entry && !entry.enabled) return null;
    const implicit = this.authenticatedMemberProviders.has(identity.provider) ? 'member' as const : null;
    if (!this.actors) return legacy ?? implicit;
    let actor = this.actors.findHuman(identity);
    if (!actor && (legacy || implicit)) {
      const context = this.actors.resolveHuman(identity);
      actor = context ? this.actors.get(context.actorId) : null;
    }
    if (!actor?.enabled || actor.kind !== 'human') return null;
    if (!this.store.actorMembership(actor.id)) {
      const roles = this.actors.bindings(actor.id).map(binding => this.store.role(binding));
      const inherited = roles.includes('admin') ? 'admin' : roles.includes('member') ? 'member' : null;
      if (inherited) this.store.importActorMembership(actor.id, inherited);
    }
    const membership = this.store.actorMembership(actor.id);
    return membership ? (membership.enabled ? membership.role : null) : implicit;
  }
  /** Stable membership recheck for work already admitted; never authenticates a login. */
  admitsActor(actorId: string): boolean {
    const actor = this.actors?.get(actorId);
    if (!actor?.enabled) return false;
    if (actor.kind === 'session') return true;
    const bindings = this.actors!.bindings(actorId);
    if (bindings.some(binding => this.admissionPolicy?.allowsBinding(binding) === false)) return false;
    // Durable work has no live login to choose between aliases. An explicit
    // binding revocation therefore fences it until an operator resolves access.
    if (bindings.some(binding => this.store.membership(binding)?.enabled === false)) return false;
    const member = this.store.actorMembership(actorId);
    if (member) return member.enabled;
    return bindings.some(binding => this.store.membership(binding)?.enabled === true
      || this.authenticatedMemberProviders.has(binding.provider));
  }
  isCurrent(identity: Principal): boolean {
    return identity.expiresAt > Date.now() && (this.#sources.get(identity)?.isCurrent?.(identity) ?? true);
  }
  admissionStatus(request: IdentityRequest): 204 | 401 | 403 {
    const identity = this.authenticate(request);
    return !identity || identity.expiresAt <= Date.now() ? 401 : this.role(identity) ? 204 : 403;
  }
  /** Called before both ordinary and Actor HTTP/WS interfaces. */
  async prepare(request: IdentityRequest): Promise<void> {
    if (!this.admissionPolicy) return;
    const identity = this.authenticate(request);
    if (identity && this.isCurrent(identity)) await this.admissionPolicy.prepare(identity);
  }
  trustedOrigin(request: IdentityRequest): string | null {
    const identity = this.authenticate(request);
    if (!identity || identity.expiresAt <= Date.now()) return null;
    return this.providers.map(p => p.trustedOrigin?.(request) ?? null).find(origin => origin !== null) ?? null;
  }
  watch(identity: Principal, revoke: () => void): () => void {
    const timer = setInterval(() => {
      let allowed = false;
      try { allowed = this.role(identity) !== null; } catch { /* Storage read failure revokes access. */ }
      if (!allowed) revoke();
    }, 500); timer.unref();
    return () => clearInterval(timer);
  }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = new URL(request.url ?? '/', 'http://access.invalid').pathname;
    if (!path.startsWith('/__opencraft_access/')) return false;
    const send = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'private, no-store' }); response.end(JSON.stringify(body)); };
    if (path === '/__opencraft_access/admission' && request.method === 'GET') { response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); return true; }
    const identity = this.authenticate(request);
    if (path === '/__opencraft_access/session' && request.method === 'GET') { send(200, { principal: identity, role: identity ? this.role(identity) : null }); return true; }
    if (!identity || this.role(identity) !== 'admin') { send(403, { error: 'administrator_required' }); return true; }
    if (path === '/__opencraft_access/members' && request.method === 'GET') { send(200, { members: this.store.list(), actors: this.store.listActors() }); return true; }
    if (path === '/__opencraft_access/audit' && request.method === 'GET') { send(200, { events: this.store.audit() }); return true; }
    if (path !== '/__opencraft_access/members' || request.method !== 'POST') { send(404, { error: 'missing' }); return true; }
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !['http:', 'https:'].some(scheme => origin === scheme + '//' + request.headers.host)
      || request.headers['content-type']?.split(';')[0] !== 'application/json') { send(403, { error: 'same_origin_json_required' }); return true; }
    try {
      let body = ''; for await (const chunk of request) { body += chunk.toString(); if (Buffer.byteLength(body) > 16_384) { send(413, { error: 'too_large' }); return true; } }
      const change = JSON.parse(body);
      if (this.role(identity) !== 'admin') { send(403, { error: 'administrator_required' }); return true; }
      if (change && typeof change.actorId === 'string' && this.actors) {
        if (Object.keys(change).some(k => !['actorId', 'role', 'enabled'].includes(k)) || this.actors.get(change.actorId)?.kind !== 'human') throw new Error('Invalid member');
        if (this.actors.findHuman(identity)?.id === change.actorId && (!change.enabled || change.role !== 'admin')) { send(409, { error: 'cannot_remove_own_administration' }); return true; }
        this.store.setActor(change.actorId, change.role, change.enabled, principalKey(identity)); send(200, { ok: true }); return true;
      }
      if (Object.keys(change).some(k => !['provider', 'subject', 'role', 'enabled'].includes(k))) throw new Error('Invalid member');
      // Local administration remains the recovery path; prevent self-removal in the remote API.
      if (principalKey(change) === principalKey(identity) && (!change.enabled || change.role !== 'admin')) { send(409, { error: 'cannot_remove_own_administration' }); return true; }
      const targetActor = this.actors?.findHuman(change);
      if (targetActor && targetActor.id === this.actors?.findHuman(identity)?.id && (!change.enabled || change.role !== 'admin')) { send(409, { error: 'cannot_remove_own_administration' }); return true; }
      this.store.set(change, change.role, change.enabled, principalKey(identity));
      if (targetActor) this.store.setActor(targetActor.id, change.role, change.enabled, principalKey(identity));
      send(200, { ok: true });
    } catch { send(400, { error: 'invalid_membership_change' }); }
    return true;
  }
}
