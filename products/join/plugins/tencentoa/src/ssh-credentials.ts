import { createHash, timingSafeEqual } from 'node:crypto';
import ssh2 from 'ssh2';
import { openManagedDatabase } from '@opencraft/sqlite-node';
import { resolveMigrationContract } from '@opencraft/sqlite-node';
import { STORE_MIGRATIONS } from '../../../storage/migrations.generated.js';
import { parsePrincipal, type Principal } from '@opencraft/identity-core';
import type { InstanceAccess } from '@opencraft/access-control';
import type { ActorStore } from '@opencraft/access-control/actors';
import type { TransportSubmissionContext } from '@opencraft/appserver-client/transport';
import type { EmployeeSshCredential } from './contract';
import { EmployeeCliKeys, type EmployeeBinding } from './cli-keys';

const schema = `
CREATE TABLE employee_ssh_credentials(actor_id TEXT PRIMARY KEY,subject TEXT NOT NULL UNIQUE,username TEXT NOT NULL UNIQUE,generation INTEGER NOT NULL,private_key TEXT NOT NULL,public_key TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
`;
/** Private, deployment-owned key escrow; never included in ordinary identity responses. */
export class EmployeeSshCredentials {
  readonly managed;
  readonly cliKeys: EmployeeCliKeys;
  private closed = false;
  private readonly unsubscribe: () => void;
  constructor(path: string, private readonly actors: ActorStore, private readonly getAccess: () => InstanceAccess | undefined,
    employeeBindings: (name: string) => EmployeeBinding[] = () => []) {
    this.managed = openManagedDatabase({ path, legacyPolicy: 'reject', migrations: resolveMigrationContract("join-employee-ssh", [{ version: 1, name: 'new-employee-ssh-credentials', sql: schema }], STORE_MIGRATIONS["join-employee-ssh"]) });
    this.cliKeys = new EmployeeCliKeys(this.managed.database, actors, getAccess, name => {
      const known = employeeBindings(name);
      const old = this.managed.database.prepare('SELECT subject,username FROM employee_ssh_credentials WHERE lower(username)=?').all(name);
      return [...new Map([...known, ...old.map(row => ({ subject: String(row.subject), loginName: String(row.username) }))].map(row => [row.subject,row])).values()];
    });
    this.unsubscribe = actors.onHumanRegistered((principal, context) => this.register(principal, context.actorId));
  }
  get outcome() { return this.managed.outcome; }
  private admitted(p: Principal) {
    if (this.closed || p.provider !== 'tencentoa' || !/^[1-9][0-9]*$/u.test(p.subject)
      || !/^[A-Za-z0-9._-]{1,128}$/u.test(p.attributes?.loginName ?? '')) return null;
    const actor = this.actors.findHuman(p);
    return actor?.enabled && actor.kind === 'human' && this.getAccess()?.role(p) ? actor : null;
  }
  private register(p: Principal, actorId: string): void {
    const actor = this.admitted(p);
    if (!actor || actor.id !== actorId) return;
    this.generate(p, null);
  }

  /** Explicit owner action; compare-and-swap prevents stale pages from replacing a newer key. */
  generate(p: Principal, expectedFingerprint: string | null): EmployeeSshCredential {
    const actor = this.admitted(p);
    if (!actor) throw Error('employee_access_required');
    const db = this.managed.database;
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT subject,fingerprint FROM employee_ssh_credentials WHERE actor_id=?').get(actor.id);
      if (row && row.subject !== p.subject) throw Error('credential_identity_changed');
      if ((row?.fingerprint ?? null) !== expectedFingerprint) throw Error('credential_conflict');
      const pair = ssh2.utils.generateKeyPairSync('ed25519');
      const fingerprint = 'SHA256:' + createHash('sha256').update(Buffer.from(pair.public.split(' ')[1]!, 'base64')).digest('base64').replace(/=+$/u, '');
      db.prepare(`INSERT INTO employee_ssh_credentials VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(actor_id) DO UPDATE SET username=excluded.username,generation=excluded.generation,
        private_key=excluded.private_key,public_key=excluded.public_key,fingerprint=excluded.fingerprint,created_at=excluded.created_at`)
        .run(actor.id, p.subject, p.attributes!.loginName!, actor.generation, pair.private, pair.public, fingerprint, Date.now());
      db.exec('COMMIT');
      return { username: p.attributes!.loginName!, privateKey: pair.private, publicKey: pair.public, fingerprint };
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  /** Reads never create keys or backfill historical users. */
  read(p: Principal): EmployeeSshCredential | null {
    const actor = this.admitted(p);
    if (!actor) throw Error('employee_access_required');
    const row = this.managed.database.prepare('SELECT * FROM employee_ssh_credentials WHERE actor_id=?').get(actor.id);
    if (!row) return null;
    if (row.subject !== p.subject || row.username !== p.attributes?.loginName || row.generation !== actor.generation) throw Error('credential_identity_changed');
    return { username: String(row.username), privateKey: String(row.private_key), publicKey: String(row.public_key), fingerprint: String(row.fingerprint) };
  }
  private current(username: string) {
    if (this.closed || !/^[A-Za-z0-9._-]{1,128}$/u.test(username)) return null;
    const row = this.managed.database.prepare('SELECT actor_id,subject,username,generation,public_key FROM employee_ssh_credentials WHERE username=?').get(username);
    if (!row) return null;
    const principal = parsePrincipal({ provider: 'tencentoa', subject: row.subject, displayName: username,
      attributes: { loginName: username }, expiresAt: Date.now() + 86_400_000 });
    const actor = this.admitted(principal);
    return actor?.id === row.actor_id && actor.generation === row.generation ? { row, principal, actor } : null;
  }
  publicKeys(username: string): string[] {
    const current = this.current(username);
    return [...(current ? [String(current.row.public_key)] : []), ...this.cliKeys.publicKeys(username)];
  }
  isScopedUsername(username: string): boolean {
    return this.cliKeys.isEmployeeUsername(username) || !!this.managed.database.prepare('SELECT id FROM employee_cli_keys WHERE lower(username)=? LIMIT 1').get(username.toLowerCase());
  }
  authorize(username: string, key: Buffer): { submissionContext: TransportSubmissionContext; isCurrent(): boolean } | null {
    const cli = this.cliKeys.authorize(username, key); if (cli) return cli;
    const current = this.current(username);
    if (!current) return null;
    const expected = Buffer.from(String(current.row.public_key).split(' ')[1]!, 'base64');
    if (expected.length !== key.length || !timingSafeEqual(expected, key)) return null;
    const { actor, principal } = current;
    const expiresAt = Date.now() + 86_400_000;
    const isCurrent = () => {
      const latest = this.current(username);
      return Date.now() < expiresAt && latest?.actor.id === actor.id && latest.row.public_key === current.row.public_key;
    };
    return { isCurrent, submissionContext: {
      sender: { kind: 'employee', loginName: username },
      executionPrincipal: { provider: principal.provider, subject: principal.subject, loginName: username },
      actorContext: { actorId: actor.id, generation: actor.generation, credentialId: null, expiresAt }, validUntil: expiresAt,
      tokenUsageAuthority: () => isCurrent() ? { actorId: actor.id, administrator: this.getAccess()?.role({ ...principal, expiresAt: Date.now() + 1000 }) === 'admin' } : null,
      resourceOwner: { id: actor.id, assertCurrent: () => { if (!isCurrent()) throw Error('employee_access_required'); } },
    } };
  }
  close() { this.closed = true; this.unsubscribe(); this.managed.database.close(); }
}
