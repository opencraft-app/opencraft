import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openManagedDatabase, createSchemaValidator, type DatabaseOutcome } from '@opencraft/sqlite-node';
import { parsePrincipal, type Principal } from '@opencraft/identity-core';
import type { ActorContext } from '@opencraft/identity-core/actors';
import type { ActorStore } from './actors.js';
import type { LocalAccountProvider, LocalAccountRecord, LocalAccountRepository } from '@opencraft/identity-core/local-account';

const SCHEMA = `
CREATE TABLE local_accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
 salt TEXT NOT NULL, password_digest TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), version INTEGER NOT NULL) STRICT;
CREATE TABLE human_logins (digest TEXT PRIMARY KEY, principal TEXT NOT NULL, actor_id TEXT NOT NULL,
 generation INTEGER NOT NULL, account_version INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
CREATE INDEX human_logins_expiry ON human_logins(expires_at);
CREATE TABLE human_identity_labels (binding TEXT PRIMARY KEY, label TEXT NOT NULL) STRICT;
`;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export interface HumanLogin {
  readonly digest: string;
  readonly principal: Principal;
  readonly context: ActorContext;
  readonly createdAt: number;
}
/** Browser sessions and backward-compatible storage; credential verification is injected. */
export class HumanAccounts {
  readonly #db: DatabaseSync;
  #local: { provider: LocalAccountProvider; owner: symbol } | null = null;
  readonly localAccountRepository: LocalAccountRepository;
  readonly outcome: DatabaseOutcome;
  constructor(path: string, readonly actors: ActorStore, readonly now = Date.now) {
    const managed = openManagedDatabase({ path, legacyPolicy: 'reject',
      migrations: [{ version: 1, name: 'human-browser-logins', sql: SCHEMA }], validateSchema: createSchemaValidator(SCHEMA) });
    this.#db = managed.database; this.outcome = managed.outcome;
    const record = (row: ReturnType<ReturnType<DatabaseSync['prepare']>['get']>): LocalAccountRecord | null => row ? {
      id: row.id as string, username: row.username as string, displayName: row.display_name as string,
      salt: row.salt as string, passwordDigest: row.password_digest as string, enabled: row.enabled === 1, version: row.version as number,
    } : null;
    this.localAccountRepository = Object.freeze({
      byUsername: (username: string) => record(this.#db.prepare('SELECT * FROM local_accounts WHERE username=?').get(username)),
      byId: (id: string) => record(this.#db.prepare('SELECT * FROM local_accounts WHERE id=?').get(id)),
      insert: (account: LocalAccountRecord) => {
        this.#db.prepare('INSERT INTO local_accounts VALUES(?,?,?,?,?,?,?)').run(account.id, account.username, account.displayName,
          account.salt, account.passwordDigest, account.enabled ? 1 : 0, account.version);
      },
      updatePassword: (id: string, salt: string, passwordDigest: string) =>
        this.#db.prepare('UPDATE local_accounts SET salt=?,password_digest=?,version=version+1 WHERE id=?').run(salt, passwordDigest, id).changes > 0,
      setEnabled: (id: string, enabled: boolean) =>
        this.#db.prepare('UPDATE local_accounts SET enabled=?,version=version+1 WHERE id=?').run(enabled ? 1 : 0, id).changes > 0,
    });
  }
  get localAccounts(): LocalAccountProvider | null {
    return this.#local?.provider.available ? this.#local.provider : null;
  }
  /** Trusted server activation. Its disposer revokes local logins, never instance admission. */
  registerLocalAccounts(provider: LocalAccountProvider): () => void {
    if (this.#local || !provider.available) throw new Error('Local account provider unavailable or already registered');
    const owner = Symbol(); this.#local = { provider, owner };
    return () => { if (this.#local?.owner === owner) this.disableLocalAccounts(); };
  }
  disableLocalAccounts() {
    const provider = this.#local?.provider; this.#local = null;
    try { provider?.close(); }
    finally { this.#db.prepare('DELETE FROM human_logins WHERE account_version IS NOT NULL').run(); }
  }
  rememberLabel(principal: Principal, label: string) {
    if (!label.trim() || label.length > 512 || /[\x00-\x1f]/u.test(label)) throw new Error('Invalid identity label');
    this.#db.prepare('INSERT INTO human_identity_labels VALUES(?,?) ON CONFLICT(binding) DO UPDATE SET label=excluded.label')
      .run(JSON.stringify([principal.provider, principal.subject]), label);
  }
  bindingLabel(binding: Pick<Principal, 'provider' | 'subject'>): string {
    if (binding.provider === 'local') {
      const label = this.localAccounts?.labelFor(binding.subject);
      if (label) return label;
      const account = this.#db.prepare('SELECT username FROM local_accounts WHERE id=?').get(binding.subject);
      if (account) return '本地账号 · ' + account.username;
    }
    const row = this.#db.prepare('SELECT label FROM human_identity_labels WHERE binding=?').get(JSON.stringify([binding.provider, binding.subject]));
    return row ? row.label as string : '企业账号 · ' + binding.subject;
  }
  issue(verified: Principal): { token: string; login: HumanLogin } {
    const accountVersion = verified.provider === 'local' ? this.localAccounts?.verifiedVersion(verified) ?? null : null;
    if (verified.provider === 'local' && accountVersion === null) throw new Error('Local account verification unavailable or changed');
    const context = this.actors.resolveHuman(verified);
    if (!context) throw new Error('Human unavailable');
    const expiresAt = Math.min(verified.expiresAt, this.now() + 8 * 3600_000);
    const principal = parsePrincipal({ ...verified, expiresAt });
    const token = randomBytes(32).toString('base64url'), digest = hashToken(token), createdAt = this.now();
    this.#db.prepare('DELETE FROM human_logins WHERE expires_at<=?').run(createdAt);
    this.#db.prepare('INSERT INTO human_logins VALUES(?,?,?,?,?,?,?)')
      .run(digest, JSON.stringify(principal), context.actorId, context.generation, accountVersion, createdAt, expiresAt);
    this.#db.prepare('DELETE FROM human_logins WHERE digest IN (SELECT digest FROM human_logins WHERE actor_id=? ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 32)')
      .run(context.actorId);
    return { token, login: { digest, principal, context: { ...context, expiresAt }, createdAt } };
  }
  authenticate(token: string): HumanLogin | null {
    return /^[A-Za-z0-9_-]{43}$/u.test(token) ? this.byDigest(hashToken(token)) : null;
  }
  byDigest(digest: string): HumanLogin | null {
    const row = this.#db.prepare('SELECT * FROM human_logins WHERE digest=?').get(digest);
    if (!row) return null;
    const principal = parsePrincipal(JSON.parse(row.principal as string));
    const context: ActorContext = { actorId: row.actor_id as string, generation: row.generation as number,
      credentialId: null, expiresAt: row.expires_at as number };
    if (!this.actors.isCurrent(context) || this.actors.findHuman(principal)?.id !== context.actorId) return null;
    if (principal.provider === 'local') {
      if (row.account_version === null || this.localAccounts?.currentVersion(principal.subject) !== row.account_version) return null;
    }
    return { digest, principal, context, createdAt: row.created_at as number };
  }
  revoke(token: string) { this.#db.prepare('DELETE FROM human_logins WHERE digest=?').run(hashToken(token)); }
  // Process shutdown preserves durable sessions; explicit deactivation revokes them.
  close() {
    const provider = this.#local?.provider; this.#local = null;
    try { provider?.close(); } finally { this.#db.close(); }
  }
}
