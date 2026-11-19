import type { IncomingMessage, ServerResponse } from 'node:http';
import { javascript, jsonFunctionSource } from '@opencraft/javascript-runtime';
import { captureSqliteReadGuard, openManagedDatabase } from '@opencraft/sqlite-node';
import { resolveMigrationContract } from '@opencraft/sqlite-node';
import { STORE_MIGRATIONS } from '../../../storage/migrations.generated.js';
import { principalKey, type Principal } from '@opencraft/identity-core';
import type { InstanceAccess, InstanceAdmissionPolicy } from '@opencraft/access-control';
import { IOA_ACCESS_PATH, type EmployeeAdmissionConfig, type EmployeeAdmissionInput } from './admission-contract';

const schema = `
CREATE TABLE employee_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, active TEXT NOT NULL, draft TEXT NOT NULL) STRICT;
CREATE TABLE employee_policy_versions(revision INTEGER PRIMARY KEY, config TEXT NOT NULL, at INTEGER NOT NULL, operator TEXT NOT NULL) STRICT;
CREATE TABLE employee_policy_audit(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL, operator TEXT NOT NULL) STRICT;
CREATE TABLE employee_policy_identities(subject TEXT PRIMARY KEY, login_name TEXT NOT NULL) STRICT;
`;
export const employeePolicyMigrations = [{ version: 1, name: 'employee-admission-policy', sql: schema }];
const login = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(v)) throw Error('invalid_policy');
  return v.toLowerCase();
};
export function admissionConfig(v: unknown): EmployeeAdmissionConfig {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('invalid_policy');
  const p = v as Record<string, unknown>;
  const fields = p.mode === 'inherit' ? ['mode'] : p.mode === 'allowlist' ? ['mode', 'loginNames'] : ['mode', 'source'];
  if (Object.keys(p).some(k => !fields.includes(k))) throw Error('invalid_policy');
  if (p.mode === 'inherit') return { mode: 'inherit' };
  if (p.mode === 'allowlist' && Array.isArray(p.loginNames) && p.loginNames.length <= 10_000)
    return { mode: 'allowlist', loginNames: [...new Set(p.loginNames.map(login))] };
  if (p.mode === 'javascript') {
    jsonFunctionSource(p.source, 'admit');
    return { mode: 'javascript', source: p.source as string };
  }
  throw Error('invalid_policy');
}
export async function evaluateAdmission(config: EmployeeAdmissionConfig, input: EmployeeAdmissionInput): Promise<boolean> {
  if (config.mode === 'inherit') return true;
  if (config.mode === 'allowlist') return config.loginNames.includes(input.identity.loginName.toLowerCase());
  const result = await javascript({ source: jsonFunctionSource(config.source, 'admit'), args: input, context: null });
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).length !== 1 || typeof (result as { allow?: unknown }).allow !== 'boolean') throw Error('invalid_policy_result');
  return (result as { allow: boolean }).allow;
}

type Decision = { loginName: string; allow: boolean; retryAt?: number };

/** One deployment owns policy, history and verified entitlement facts, never login proofs. */
export class EmployeeAdmissionPolicy implements InstanceAdmissionPolicy {
  readonly managed;
  private active: EmployeeAdmissionConfig;
  private generation = 0;
  private decisionRevision = 0;
  private closed = false;
  private readonly decisions = new Map<string, Decision>();
  private readonly pending = new Map<string, Promise<void>>();
  constructor(path: string, readonly server: { id: string; name: string }, readonly getAccess: () => InstanceAccess | undefined) {
    this.managed = openManagedDatabase({ path, legacyPolicy: 'reject', migrations: resolveMigrationContract("join-employee-admission", employeePolicyMigrations, STORE_MIGRATIONS["join-employee-admission"]) });
    const db = this.managed.database;
    try {
      db.prepare('INSERT OR IGNORE INTO employee_policy VALUES(1,0,?,?)').run('{"mode":"inherit"}', '{"mode":"inherit"}');
      const row = this.row();
      this.active = admissionConfig(JSON.parse(String(row.active)));
      admissionConfig(JSON.parse(String(row.draft)));
    } catch (error) {
      db.close();
      throw error;
    }
  }
  get outcome() { return this.managed.outcome; }
  /** Previously verified identities only; lookup never registers a Principal or Actor. */
  employeeBindings(loginName: string): { subject: string; loginName: string }[] {
    return this.managed.database.prepare('SELECT subject,login_name FROM employee_policy_identities WHERE login_name=?')
      .all(loginName.toLowerCase()).map(row => ({ subject: String(row.subject), loginName: String(row.login_name) }));
  }
  /** Provider-verified durable RTX for an existing OA subject, independent of browser session lifetime. */
  employeeBindingForSubject(subject: string): { subject: string; loginName: string } | null {
    const row=this.managed.database.prepare('SELECT subject,login_name FROM employee_policy_identities WHERE subject=?').get(subject);
    if(!row)return null;
    const matches=this.employeeBindings(String(row.login_name));
    return matches.length===1&&matches[0]!.subject===subject?matches[0]!:null;
  }
  private row() { return this.managed.database.prepare('SELECT * FROM employee_policy WHERE singleton=1').get()!; }
  private input(subject: string, loginName: string): EmployeeAdmissionInput {
    return { server: { id: this.server.id }, identity: { staffId: subject, loginName } };
  }
  async initialize(): Promise<void> {
    for (const row of this.managed.database.prepare('SELECT * FROM employee_policy_identities').all()) {
      const subject = String(row.subject), loginName = login(row.login_name);
      const decision: Decision = { loginName, allow: false };
      try { decision.allow = await evaluateAdmission(this.active, this.input(subject, loginName)); } catch { decision.retryAt = Date.now() + 1000; }
      this.decisions.set(subject, decision); this.decisionRevision++;
    }
  }
  async prepare(p: Principal): Promise<void> {
    if (p.provider !== 'tencentoa' || this.closed) return;
    const loginName = login(p.attributes?.loginName);
    const current = this.decisions.get(p.subject);
    if (current?.loginName === loginName && (!current.retryAt || current.retryAt > Date.now())) return;
    const startedGeneration = this.generation;
    const key = JSON.stringify([this.generation, p.subject, loginName]);
    let work = this.pending.get(key);
    if (!work) {
      const generation = this.generation, config = this.active;
      work = (async () => {
        const decision: Decision = { loginName, allow: false };
        try { decision.allow = await evaluateAdmission(config, this.input(p.subject, loginName)); } catch { decision.retryAt = Date.now() + 1000; }
        if (this.closed || generation !== this.generation) return;
        this.managed.database.prepare('INSERT INTO employee_policy_identities VALUES(?,?) ON CONFLICT(subject) DO UPDATE SET login_name=excluded.login_name').run(p.subject, loginName);
        this.decisions.set(p.subject, decision); this.decisionRevision++;
      })().finally(() => { this.pending.delete(key); });
      this.pending.set(key, work);
    }
    await work;
    // A publication during evaluation must use the newly active revision.
    if (!this.closed && startedGeneration !== this.generation) await this.prepare(p);
  }
  /** Opaque proof of this original policy's effective decisions and lifecycle.
   * No policy evaluation, preparation or identity registration is performed.
   */
  captureCountReadGuard(): (() => boolean) | null {
    const revision = this.decisionRevision, generation = this.generation, active = this.active;
    const access = this.getAccess(), serverId = this.server.id;
    return captureSqliteReadGuard(this.managed.database, () => !this.closed
      && this.generation === generation && this.decisionRevision === revision
      && this.active === active && this.getAccess() === access && this.server.id === serverId);
  }
  allows(p: Principal): boolean {
    if (p.provider !== 'tencentoa') return true;
    if (this.closed) return false;
    if (this.active.mode === 'inherit') return true;
    const result = this.decisions.get(p.subject);
    return result !== undefined && result.loginName === p.attributes?.loginName?.toLowerCase() && result.allow;
  }
  allowsBinding(p: Pick<Principal, 'provider' | 'subject'>): boolean {
    return p.provider !== 'tencentoa' || (!this.closed && (this.active.mode === 'inherit' || this.decisions.get(p.subject)?.allow === true));
  }
  private document(canManage: boolean) {
    if (!canManage) return { server: this.server, canManage };
    const row = this.row();
    return { server: this.server, canManage, revision: Number(row.revision), active: JSON.parse(String(row.active)), draft: JSON.parse(String(row.draft)),
      versions: this.managed.database.prepare('SELECT revision,config,at FROM employee_policy_versions ORDER BY revision DESC LIMIT 20').all()
        .map(r => ({ revision: Number(r.revision), config: JSON.parse(String(r.config)), at: Number(r.at) })) };
  }
  private administrator(request: IncomingMessage): Principal {
    const access = this.getAccess(), p = access?.authenticate(request);
    if (!p || access?.role(p) !== 'admin') throw Error('administrator_required');
    return p;
  }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (new URL(request.url ?? '/', 'http://policy.invalid').pathname !== IOA_ACCESS_PATH) return false;
    const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value)); };
    if (request.method === 'GET') {
      const access = this.getAccess(), p = access?.authenticate(request);
      if (!p || !access?.role(p)) { send(403, { error: 'instance_access_denied' }); return true; }
      send(200, this.document(access.role(p) === 'admin')); return true;
    }
    if (request.method !== 'POST') { send(405, { error: 'method_not_allowed' }); return true; }
    try {
      this.administrator(request);
      const origin = request.headers.origin;
      const access = this.getAccess();
      if (typeof origin !== 'string' || !(origin === access?.trustedOrigin(request) || ['http:', 'https:'].some(s => origin === s + '//' + request.headers.host))
        || request.headers['sec-fetch-site'] === 'cross-site' || request.headers['content-type']?.split(';')[0] !== 'application/json') throw Error('same_origin_required');
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const c of request) { bytes += Buffer.byteLength(c); if (bytes > 131_072) throw Error('invalid_policy'); chunks.push(Buffer.from(c)); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(k => !['action', 'revision', 'config', 'identity'].includes(k))) throw Error('invalid_policy');
      const config = admissionConfig(body.config);
      if (!['preview', 'draft', 'publish'].includes(body.action)) throw Error('invalid_policy');
      if (config.mode === 'javascript') await javascript({ compile: true, sources: [jsonFunctionSource(config.source, 'admit')] });
      if (body.action === 'preview') {
        const identity = body.identity;
        if (!identity || Object.keys(identity).some(k => !['loginName', 'staffId'].includes(k))
          || typeof identity.staffId !== 'string' || !/^[1-9][0-9]{0,31}$/u.test(identity.staffId)) throw Error('invalid_policy');
        const allow = await evaluateAdmission(config, this.input(identity.staffId, login(identity.loginName)));
        this.administrator(request); send(200, { allow, sideEffects: false }); return true;
      }
      if (!Number.isSafeInteger(body.revision) || body.revision !== Number(this.row().revision)) throw Error('revision_conflict');
      const decisions = new Map<string, Decision>();
      const generation = this.generation;
      if (body.action === 'publish') {
        const p = this.administrator(request);
        if (p.provider === 'tencentoa' && !await evaluateAdmission(config, this.input(p.subject, login(p.attributes?.loginName)))) throw Error('cannot_remove_own_administration');
        for (const row of this.managed.database.prepare('SELECT * FROM employee_policy_identities').all()) {
          const loginName = login(row.login_name); const decision: Decision = { loginName, allow: false };
          try { decision.allow = await evaluateAdmission(config, this.input(String(row.subject), loginName)); } catch { decision.retryAt = Date.now() + 1000; }
          decisions.set(String(row.subject), decision);
        }
        if (p.provider === 'tencentoa' && decisions.get(p.subject)?.allow !== true) throw Error('cannot_remove_own_administration');
      }
      const operator = principalKey(this.administrator(request));
      const db = this.managed.database;
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = this.row();
        if (body.revision !== Number(row.revision) || generation !== this.generation) throw Error('revision_conflict');
        const serialized = JSON.stringify(config);
        if (body.action === 'publish') {
          db.prepare('INSERT INTO employee_policy_versions VALUES(?,?,?,?)').run(body.revision, String(row.active), Date.now(), operator);
          db.prepare('UPDATE employee_policy SET active=?,draft=?,revision=revision+1 WHERE singleton=1').run(serialized, serialized);
        } else db.prepare('UPDATE employee_policy SET draft=?,revision=revision+1 WHERE singleton=1').run(serialized);
        db.prepare('INSERT INTO employee_policy_audit(revision,action,at,operator) VALUES(?,?,?,?)').run(body.revision + 1, body.action, Date.now(), operator);
        db.exec('COMMIT');
      } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
      if (body.action === 'publish') {
        this.active = config; this.generation++; this.decisions.clear();
        for (const [subject, decision] of decisions) this.decisions.set(subject, decision);
        this.decisionRevision++;
      }
      send(200, this.document(true));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const known = ['administrator_required', 'same_origin_required', 'revision_conflict', 'cannot_remove_own_administration', 'invalid_policy', 'invalid_policy_result'];
      const code = known.includes(message) ? message : 'policy_failed';
      send(code === 'administrator_required' || code === 'same_origin_required' ? 403 : code === 'revision_conflict' || code === 'cannot_remove_own_administration' ? 409 : 400, { error: code });
    }
    return true;
  }
  close() { this.closed = true; this.generation++; this.decisions.clear(); this.managed.database.close(); }
}
