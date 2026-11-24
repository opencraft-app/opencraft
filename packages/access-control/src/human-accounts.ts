import { AuthorityChanges } from "./authority-changes.js";
import { randomToken, sha256Hex } from './portable-crypto.js';
import type { SqlDatabase } from '@opencraft/sql';
import type { DatabaseOutcome } from "@opencraft/sqlite-node";
import { openServerRepository, type ServerDatabaseSource } from "@opencraft/storage-node/server-repository";
import { parsePrincipal, type Principal } from '@opencraft/identity-core';
import type { ActorContext } from '@opencraft/identity-core/actors';
import type { ActorStore } from './actors.js';
import type { LocalAccountProvider, LocalAccountRecord, LocalAccountRepository } from '@opencraft/identity-core/local-account';


const hashToken = (token: string) => sha256Hex(token);
export interface HumanLogin {
  readonly digest: string;
  readonly principal: Principal;
  readonly context: ActorContext;
  readonly createdAt: number;
}
/** Browser sessions and backward-compatible storage; credential verification is injected. */
export class HumanAccounts {
  readonly #changes: AuthorityChanges;
  /** Every committed account/permission mutation; not a login or grant. */
  onAuthorityChanged = (listener: () => void) => this.#changes.subscribe(listener);

  readonly #db: SqlDatabase;
  #closed = false;
  #local: { provider: LocalAccountProvider; owner: symbol } | null = null;
  readonly localAccountRepository: LocalAccountRepository;
  readonly outcome: DatabaseOutcome;
  readonly #closeDatabase: () => void;
  constructor(path: ServerDatabaseSource, readonly actors: ActorStore, readonly now = Date.now) {
    const managed = openServerRepository(path, "human-logins");
    this.#closeDatabase = managed.close;
    this.#db = managed.database; this.#changes = new AuthorityChanges(typeof path === "string" ? this.#db : path.database); this.outcome = managed.outcome;
    const record = (row: ReturnType<ReturnType<SqlDatabase['prepare']>['get']>): LocalAccountRecord | null => row ? {
      id: row.id as string, username: row.username as string, displayName: row.display_name as string,
      salt: row.salt as string, passwordDigest: row.password_digest as string, enabled: row.enabled === 1, version: row.version as number,
    } : null;
    this.localAccountRepository = Object.freeze({
      byUsername: (username: string) => record(this.#db.prepare('SELECT * FROM local_accounts WHERE username=?').get(username)),
      byId: (id: string) => record(this.#db.prepare('SELECT * FROM local_accounts WHERE id=?').get(id)),
      insert: (account: LocalAccountRecord) => {
        this.#db.prepare('INSERT INTO local_accounts VALUES(?,?,?,?,?,?,?)').run(account.id, account.username, account.displayName,
          account.salt, account.passwordDigest, account.enabled ? 1 : 0, account.version);
        this.#changes.emit();
      },
      updatePassword: (id: string, salt: string, passwordDigest: string) =>
        this.#writeAccount(() => this.#db.prepare('UPDATE local_accounts SET salt=?,password_digest=?,version=version+1 WHERE id=?').run(salt, passwordDigest, id).changes > 0),
      setEnabled: (id: string, enabled: boolean) =>
        this.#writeAccount(() => this.#db.prepare('UPDATE local_accounts SET enabled=?,version=version+1 WHERE id=?').run(enabled ? 1 : 0, id).changes > 0),
    });
  }
  #writeAccount<T>(write: () => T): T { const result = write(); this.#changes.emit(); return result; }
  get localAccounts(): LocalAccountProvider | null {
    return this.#local?.provider.available ? this.#local.provider : null;
  }
  /** Management projection only; salt and password digests remain in their storage port. */
  listLocalAccounts(): { id: string; username: string; displayName: string; enabled: boolean }[] {
    return this.#db.prepare('SELECT id,username,display_name,enabled FROM local_accounts ORDER BY username').all()
      .map(row => ({ id: row.id as string, username: row.username as string, displayName: row.display_name as string, enabled: row.enabled === 1 }));
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
    finally { this.#db.prepare('DELETE FROM human_logins WHERE account_version IS NOT NULL').run(); this.#changes.emit(); }
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
  /** The local account version a login records; throws when a local login cannot be verified on this thread. */
  loginAccountVersion(verified: Principal): number | null {
    const accountVersion = verified.provider === 'local' ? this.localAccounts?.verifiedVersion(verified) ?? null : null;
    if (verified.provider === 'local' && accountVersion === null) throw new Error('Local account verification unavailable or changed');
    return accountVersion;
  }
  /** The storage owner committed login writes on its own connection; notify observers as a local write would. */
  ownerCommitted(): void {
    this.#changes.emit();
  }
  /** `accountVersion` is supplied by a caller that verified the local account on its own thread. */
  issue(verified: Principal, accountVersion: number | null = this.loginAccountVersion(verified)): { token: string; login: HumanLogin } {
    if (verified.provider === 'local' && accountVersion === null) throw new Error('Local account verification unavailable or changed');
    const context = this.actors.resolveHuman(verified);
    if (!context) throw new Error('Human unavailable');
    const expiresAt = Math.min(verified.expiresAt, this.now() + 8 * 3600_000);
    const principal = parsePrincipal({ ...verified, expiresAt });
    const token = randomToken(32), digest = hashToken(token), createdAt = this.now();
    this.#db.prepare('DELETE FROM human_logins WHERE expires_at<=?').run(createdAt);
    this.#db.prepare('INSERT INTO human_logins VALUES(?,?,?,?,?,?,?)')
      .run(digest, JSON.stringify(principal), context.actorId, context.generation, accountVersion, createdAt, expiresAt);
    this.#db.prepare('DELETE FROM human_logins WHERE digest IN (SELECT digest FROM human_logins WHERE actor_id=? ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 32)')
      .run(context.actorId);
    this.#changes.emit();
    return { token, login: { digest, principal, context: { ...context, expiresAt }, createdAt } };
  }
  authenticate(token: string): HumanLogin | null {
    return /^[A-Za-z0-9_-]{43}$/u.test(token) ? this.byDigest(hashToken(token)) : null;
  }
  byDigest(digest: string): HumanLogin | null {
    if (this.#closed) return null;
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
  revoke(token: string) { this.#db.prepare('DELETE FROM human_logins WHERE digest=?').run(hashToken(token)); this.#changes.emit(); }
  // Process shutdown preserves durable sessions; explicit deactivation revokes them.
  close() {
    this.#closed = true; this.#changes.close();
    const provider = this.#local?.provider; this.#local = null;
    try { provider?.close(); } finally { this.#closeDatabase(); }
  }
}
