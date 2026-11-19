import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import ssh2 from 'ssh2';
import type { ActorStore } from '@opencraft/access-control/actors';
import type { InstanceAccess } from '@opencraft/access-control';
import type { TransportSubmissionContext } from '@opencraft/appserver-client/transport';

export type EmployeeBinding = { subject: string; loginName: string };
export type CliKeyRequest = { action: 'add' | 'list' | 'remove'; employee: string; name?: string; publicKey?: string; keyId?: string };
export class EmployeeCliKeys {
  constructor(private readonly db: DatabaseSync, private readonly actors: ActorStore,
    private readonly access: () => InstanceAccess | undefined,
    private readonly bindings: (name: string) => EmployeeBinding[]) {}
  private employee(name: string) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(name)) throw Error('invalid_employee');
    const bindings = this.bindings(name.toLowerCase());
    if (bindings.length !== 1) throw Error(bindings.length ? 'ambiguous_employee' : 'unknown_employee');
    const binding = bindings[0]!;
    const actor = this.actors.findHuman({ provider: 'tencentoa', subject: binding.subject });
    if (!actor || actor.kind !== 'human' || !actor.enabled || !this.access()?.admitsActor(actor.id)) throw Error('employee_access_required');
    const membershipRevision = this.access()!.store.revocationRevision(actor.id,this.actors.bindings(actor.id));
    return { binding, actor, membershipRevision };
  }
  /** Known names stay scoped even when disabled, revoked or all keys are removed. */
  isEmployeeUsername(name: string): boolean { return this.bindings(name.toLowerCase()).length > 0; }
  private audit(operator: string, request: CliKeyRequest, actorId: string | null, fingerprint: string | null, result: string) {
    this.db.prepare('INSERT INTO employee_cli_key_audit(operator,employee,actor_id,fingerprint,action,at,result) VALUES(?,?,?,?,?,?,?)')
      .run(operator, typeof request.employee === 'string' ? request.employee.slice(0,128) : '', actorId, fingerprint, typeof request.action==='string'?request.action.slice(0,32):'invalid', Date.now(), result);
  }
  manage(request: CliKeyRequest, operator: string) {
    if (!operator || operator.length > 256 || /[\x00-\x1f]/u.test(operator)) throw Error('invalid_operator');
    let actorId: string | null = null, fingerprint: string | null = null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { actor, binding, membershipRevision } = this.employee(request.employee); actorId = actor.id;
      if (request.action === 'add') {
        const value = request.publicKey;
        if (typeof request.name !== 'string' || !request.name.trim() || request.name.length > 128 || /[\x00-\x1f]/u.test(request.name)) throw Error('invalid_key_name');
        if (typeof value !== 'string' || value.length > 16384 || value.trim().split(/\r?\n/u).length !== 1) throw Error('invalid_public_key');
        const parsed = ssh2.utils.parseKey(value.trim());
        if (parsed instanceof Error || Array.isArray(parsed) || parsed.isPrivateKey()
          || !['ssh-ed25519','ssh-rsa','ecdsa-sha2-nistp256','ecdsa-sha2-nistp384','ecdsa-sha2-nistp521'].includes(parsed.type)
          || value.trim().split(/\s/u)[0] !== parsed.type) throw Error('invalid_public_key');
        const blob = parsed.getPublicSSH();
        fingerprint = 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/u,'');
        const prior = this.db.prepare('SELECT actor_id FROM employee_cli_keys WHERE fingerprint=? AND revoked_at IS NULL').get(fingerprint);
        if (prior && prior.actor_id !== actor.id) throw Error('key_belongs_to_another_employee');
        const existing = this.db.prepare('SELECT id FROM employee_cli_keys WHERE actor_id=? AND fingerprint=? AND generation=? AND membership_revision=? AND revoked_at IS NULL').get(actor.id,fingerprint,actor.generation,membershipRevision);
        if (!existing) this.db.prepare('INSERT INTO employee_cli_keys(id,actor_id,subject,username,generation,membership_revision,name,public_key,fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(randomUUID(),actor.id,binding.subject,binding.loginName,actor.generation,membershipRevision,request.name.trim(),parsed.type+' '+blob.toString('base64'),fingerprint,Date.now());
      } else if (request.action === 'remove') {
        if (typeof request.keyId !== 'string' || request.keyId.length > 128) throw Error('invalid_key_id');
        const key = this.db.prepare('SELECT fingerprint FROM employee_cli_keys WHERE id=? AND actor_id=?').get(request.keyId,actor.id);
        if (!key) throw Error('unknown_key'); fingerprint = String(key.fingerprint);
        this.db.prepare('UPDATE employee_cli_keys SET revoked_at=COALESCE(revoked_at,?),revoked_by=COALESCE(revoked_by,?) WHERE id=? AND actor_id=?').run(Date.now(),operator,request.keyId,actor.id);
      } else if (request.action !== 'list') throw Error('invalid_action');
      const keys = this.db.prepare('SELECT id,name,fingerprint,created_at,last_used_at,revoked_at,revoked_by,generation,membership_revision FROM employee_cli_keys WHERE actor_id=? ORDER BY created_at,id').all(actor.id);
      this.audit(operator,request,actorId,fingerprint,'ok'); this.db.exec('COMMIT');
      return { actorId, employee: binding.loginName, generation: actor.generation, membershipRevision,
        keys: keys.map(row=>({...row,active:row.revoked_at===null && row.generation===actor.generation && row.membership_revision===membershipRevision})) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      const reason = error instanceof Error && /^[a-z_]+$/u.test(error.message) ? error.message : 'cli_key_operation_failed';
      this.audit(operator,request,actorId,fingerprint,reason); throw Error(reason);
    }
  }
  private current(username: string) {
    try { return this.employee(username); } catch { return null; }
  }
  publicKeys(username: string): string[] {
    const current = this.current(username); if (!current) return [];
    return this.db.prepare('SELECT public_key FROM employee_cli_keys WHERE actor_id=? AND subject=? AND generation=? AND membership_revision=? AND revoked_at IS NULL')
      .all(current.actor.id,current.binding.subject,current.actor.generation,current.membershipRevision).map(row => String(row.public_key));
  }
  authorize(username: string, key: Buffer): { submissionContext: TransportSubmissionContext; isCurrent(): boolean } | null {
    const current = this.current(username); if (!current) return null;
    const { actor, binding, membershipRevision } = current;
    const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/u,'');
    const row = this.db.prepare('SELECT id,public_key FROM employee_cli_keys WHERE actor_id=? AND subject=? AND generation=? AND membership_revision=? AND fingerprint=? AND revoked_at IS NULL')
      .get(actor.id,binding.subject,actor.generation,membershipRevision,fingerprint); if (!row) return null;
    const expected = Buffer.from(String(row.public_key).split(' ')[1]!, 'base64');
    if (key.length !== expected.length || !timingSafeEqual(key,expected)) return null;
    const expiresAt = Date.now()+86_400_000;
    const isCurrent = () => {
      const latest = this.current(username);
      return Date.now()<expiresAt && latest?.actor.id===actor.id && latest.actor.generation===actor.generation && latest.membershipRevision===membershipRevision
        && !!this.db.prepare('SELECT id FROM employee_cli_keys WHERE id=? AND revoked_at IS NULL').get(row.id!);
    };
    this.db.prepare('UPDATE employee_cli_keys SET last_used_at=? WHERE id=?').run(Date.now(),row.id!);
    return { isCurrent, submissionContext: {
      sender: { kind:'employee',loginName:binding.loginName },
      executionPrincipal: { provider:'tencentoa',subject:binding.subject,loginName:binding.loginName },
      actorContext: { actorId:actor.id,generation:actor.generation,credentialId:null,expiresAt }, validUntil:expiresAt,
      resourceOwner: { id:actor.id,assertCurrent:()=>{if(!isCurrent())throw Error('employee_access_required');} },
      tokenUsageAuthority:()=>isCurrent()?{actorId:actor.id,administrator:this.access()?.store.actorMembership(actor.id)?.role==='admin'}:null,
    } };
  }
}
