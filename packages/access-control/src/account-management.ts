import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openManagedDatabase, createSchemaValidator } from '@opencraft/sqlite-node';
import { parsePrincipal, type Principal } from '@opencraft/identity-core';
import type { ActorContext } from '@opencraft/identity-core/actors';
import type { LocalAccountProvider } from '@opencraft/identity-core/local-account';
import type { ActorStore } from './actors.js';
import type { HumanAccounts } from './human-accounts.js';
import type { MembershipStore } from './index.js';

const SCHEMA = `CREATE TABLE account_setup (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL,
 mode TEXT, username TEXT, subject TEXT, owner_actor TEXT) STRICT;
CREATE TABLE account_invitations (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, state TEXT NOT NULL,
 username TEXT, subject TEXT NOT NULL, actor_id TEXT, created_by TEXT NOT NULL) STRICT;`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class AccountManagementError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
function check(value: unknown, code: string, status = 409): asserts value {
  if (!value) throw new AccountManagementError(code, status);
}
function username(value: unknown): string {
  check(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/u.test(value), 'invalid_username', 400);
  return value.toLowerCase();
}
interface SetupRow { state: string; mode: string | null; username: string | null; subject: string | null; owner_actor: string | null }
interface InvitationRow { digest: string; expires_at: number; state: string; username: string | null; subject: string; actor_id: string | null; created_by: string }
export interface AccountSetupStatus { readonly state: 'new' | 'pending' | 'complete'; readonly mode: string | null }

/** Core owns one-time administration and member grants; credential plugins cannot grant access. */
export class HumanAccountManagement {
  readonly #db: DatabaseSync;
  readonly #operations = new Set<string>();
  #closed = false;
  constructor(path: string, readonly accounts: HumanAccounts, readonly actors: ActorStore,
    readonly members: MembershipStore, readonly now = Date.now) {
    this.#db = openManagedDatabase({ path, legacyPolicy: 'reject', migrations: [{ version: 1, name: 'account-onboarding', sql: SCHEMA }],
      validateSchema: createSchemaValidator(SCHEMA) }).database;
    if (!this.#db.prepare('SELECT id FROM account_setup WHERE id=1').get()) {
      const existing = actors.list().some(actor => actor.kind === 'human') || accounts.listLocalAccounts().length > 0
        || members.listActors().length > 0 || members.list().length > 0;
      this.#db.prepare('INSERT INTO account_setup VALUES(1,?,?,NULL,NULL,NULL)').run(existing ? 'complete' : 'new', existing ? 'existing' : null);
    }
  }
  #assertOpen() { check(!this.#closed, 'account_service_retired', 503); }
  #row() { return this.#db.prepare('SELECT * FROM account_setup WHERE id=1').get() as unknown as SetupRow; }
  status(): AccountSetupStatus {
    this.#assertOpen(); const row = this.#row();
    return { state: row.state as AccountSetupStatus['state'], mode: row.mode };
  }
  isDesktopOwner(actorId: string): boolean {
    this.#assertOpen(); const row = this.#row(); return row.mode === 'desktop' && row.owner_actor === actorId;
  }
  #transaction<T>(run: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.#db.exec('COMMIT'); return result; }
    catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
  }
  #provider(): LocalAccountProvider {
    const provider = this.accounts.localAccounts;
    check(provider?.available && provider.createWithId, 'account_provisioning_unavailable', 503); return provider;
  }
  async #provision(subject: string, name: string, password: string) {
    const provider = this.#provider();
    const existing = this.accounts.localAccountRepository.byUsername(name);
    check(!existing || existing.id === subject, 'username_unavailable');
    const principal = existing ? await provider.verify(name, password) : await provider.createWithId!(subject, name, name, password);
    this.#assertOpen();
    check(this.accounts.localAccounts === provider && principal?.subject === subject && provider.verifiedVersion(principal) !== null,
      'account_verification_required', 401);
    return principal;
  }
  /** Caller is the trusted installer adapter, which verifies its setup proof first. */
  async initialize(input: { mode: 'desktop' | 'web'; username?: string; password?: string }): Promise<Principal> {
    this.#assertOpen(); check(!this.#operations.has('setup'), 'setup_in_progress');
    check(input.mode === 'web' || input.mode === 'desktop', 'invalid_setup_mode', 400);
    const name = input.mode === 'web' ? username(input.username) : '';
    this.#operations.add('setup');
    try {
      const operation = this.#transaction(() => {
        let row = this.#row(); check(row.state !== 'complete', 'setup_already_completed');
        if (row.state === 'new') {
          check(!this.actors.list().some(a => a.kind === 'human') && !this.accounts.listLocalAccounts().length
            && !this.members.listActors().length && !this.members.list().length, 'existing_installation');
          this.#db.prepare("UPDATE account_setup SET state='pending',mode=?,username=?,subject=? WHERE id=1").run(input.mode, name, randomUUID());
          row = this.#row();
        }
        check(row.mode === input.mode && row.username === name, 'resume_original_setup'); return row;
      });
      const principal = input.mode === 'desktop'
        ? parsePrincipal({ provider: 'desktop', subject: operation.subject!, displayName: 'Local user', expiresAt: this.now() + 8 * 3600_000 })
        : await this.#provision(operation.subject!, name, input.password!);
      this.#assertOpen(); const context = this.actors.resolveHuman(principal);
      check(context, 'human_unavailable', 403);
      const membership = this.members.actorMembership(context.actorId);
      check(!membership || (membership.enabled && membership.role === 'admin'), 'existing_membership');
      if (!membership) this.members.setActor(context.actorId, 'admin', true, 'account-setup');
      this.#db.prepare("UPDATE account_setup SET state='complete',owner_actor=? WHERE id=1").run(context.actorId);
      return principal;
    } finally { this.#operations.delete('setup'); }
  }
  /** Native host only: never inferred from an HTTP loopback request or a caller-supplied Actor. */
  desktopIdentity(): Principal {
    this.#assertOpen(); const row = this.#row();
    check(row.state === 'complete' && row.mode === 'desktop' && row.subject && row.owner_actor, 'desktop_owner_unavailable', 403);
    const principal = parsePrincipal({ provider: 'desktop', subject: row.subject, displayName: 'Local user', expiresAt: this.now() + 8 * 3600_000 });
    check(this.actors.findHuman(principal)?.id === row.owner_actor && this.actors.get(row.owner_actor)?.enabled, 'desktop_owner_unavailable', 403);
    return principal;
  }
  requireAdministrator(context: ActorContext) {
    this.#assertOpen();
    check(this.actors.isCurrent(context) && this.actors.get(context.actorId)?.kind === 'human'
      && this.members.actorMembership(context.actorId)?.enabled && this.members.actorMembership(context.actorId)?.role === 'admin', 'administrator_required', 403);
  }
  list(context: ActorContext) {
    this.requireAdministrator(context);
    return { accounts: this.accounts.listLocalAccounts().map(account => ({ ...account,
      actorId: this.actors.findHuman({ provider: 'local', subject: account.id })?.id ?? null })),
      humans: this.actors.list().filter(actor => actor.kind === 'human').map(actor => ({ id: actor.id, displayName: actor.displayName, enabled: actor.enabled })),
      members: this.members.listActors() };
  }
  invite(context: ActorContext) {
    this.requireAdministrator(context); check(this.status().state === 'complete', 'setup_required');
    const code = randomBytes(32).toString('base64url'), expiresAt = this.now() + 86400_000;
    this.#db.prepare("DELETE FROM account_invitations WHERE expires_at<=? AND state='new'").run(this.now());
    check((this.#db.prepare("SELECT COUNT(*) AS count FROM account_invitations WHERE state<>'used' AND expires_at>?").get(this.now())!.count as number) < 1000, 'too_many_invitations', 429);
    this.#db.prepare("INSERT INTO account_invitations VALUES(?,?,'new',NULL,?,NULL,?)").run(digest(code), expiresAt, randomUUID(), context.actorId);
    return { code, expiresAt };
  }
  async accept(input: { code: string; username: string; password: string }): Promise<Principal> {
    this.#assertOpen(); check(typeof input.code === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(input.code), 'invitation_unavailable', 410);
    const key = digest(input.code), name = username(input.username); check(!this.#operations.has(key), 'invitation_in_progress');
    this.#operations.add(key);
    try {
      const row = this.#transaction(() => {
        const invitation = this.#db.prepare('SELECT * FROM account_invitations WHERE digest=?').get(key) as unknown as InvitationRow | undefined;
        check(invitation && invitation.expires_at > this.now() && invitation.state !== 'used', 'invitation_unavailable', 410);
        check(invitation.state !== 'pending' || invitation.username === name, 'resume_original_invitation');
        if (invitation.state === 'new') {
          check(!this.accounts.localAccountRepository.byUsername(name), 'username_unavailable');
          this.#db.prepare("UPDATE account_invitations SET state='pending',username=? WHERE digest=?").run(name, key);
        }
        return invitation;
      });
      const principal = await this.#provision(row.subject, name, input.password);
      const current = this.#db.prepare('SELECT * FROM account_invitations WHERE digest=?').get(key) as unknown as InvitationRow;
      check(current.expires_at > this.now() && current.state === 'pending', 'invitation_unavailable', 410);
      const context = this.actors.resolveHuman(principal); check(context, 'human_unavailable', 403);
      const membership = this.members.actorMembership(context.actorId);
      check(!membership || (membership.enabled && membership.role === 'member'), 'existing_membership');
      if (!membership) this.members.setActor(context.actorId, 'member', true, row.created_by);
      this.#db.prepare("UPDATE account_invitations SET state='used',actor_id=? WHERE digest=?").run(context.actorId, key);
      return principal;
    } finally { this.#operations.delete(key); }
  }
  async password(context: ActorContext, name: string, password: string) {
    this.requireAdministrator(context); const provider = this.#provider();
    await provider.resetPassword(username(name), password, () => this.requireAdministrator(context));
    this.#assertOpen(); check(this.accounts.localAccounts === provider, 'account_service_retired', 503);
  }
  setMember(context: ActorContext, actorId: string, role: 'admin' | 'member', enabled: boolean) {
    this.requireAdministrator(context);
    check(actorId !== context.actorId || (enabled && role === 'admin'), 'cannot_remove_own_administration');
    check(this.actors.get(actorId)?.kind === 'human' && ['admin', 'member'].includes(role) && typeof enabled === 'boolean', 'invalid_member', 400);
    this.members.setActor(actorId, role, enabled, context.actorId);
  }
  close() { if (this.#closed) return; this.#closed = true; this.#db.close(); }
}
