import { Collaboration } from './collaboration.js';
import { ActorStore } from './actors.js';
import { createHash, randomUUID } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import type { ActorContext } from '@opencraft/identity-core/actors';
import { sqliteTransaction } from '@opencraft/sqlite-node';
import { canonical } from './orchestration-ledger.js';
import { AutomationError, automationFields, automationRecord, automationRunKey, automationText, parseAutomationSchedule,
  parseAutomationTarget, type Automation, type AutomationRun, type AutomationTarget } from './automation.js';

export interface AutomationGrant {
  id: string; serverId: string; projectId: string; actorId: string; generation: number;
  target: AutomationTarget; permissionSnapshot: string; permissionProfile: string; revokedAt: number | null; createdAt: number;
}
export interface AutomationCaller { context: ActorContext; authorityId?: string }
/** Borrows the installation owner's migrated connection in its serialized Worker. */
export class AutomationLedger {
  constructor(private readonly db: DatabaseSync, private readonly now: number) {
    if (isMainThread) throw Error('Automation SQL requires a Worker');
  }
  private row(sql: string, ...args: any[]) { return this.db.prepare(sql).get(...args); }
  private all(sql: string, ...args: any[]) { return this.db.prepare(sql).all(...args); }
  private run(sql: string, ...args: any[]) { return this.db.prepare(sql).run(...args); }
  private actor(context: ActorContext): void {
    const actor=this.row('SELECT kind,enabled,generation FROM actors WHERE id=?',context.actorId);
    if (actor?.kind!=='human' || actor.enabled!==1 || actor.generation!==context.generation || context.expiresAt<=this.now || context.credentialId!==null)
      throw new AutomationError('automation_human_authority_required',403);
  }
  private grant(id: string): AutomationGrant {
    const row=this.row('SELECT * FROM automation_grants WHERE id=?',id);
    if (!row) throw new AutomationError('automation_grant_unavailable',404);
    return {id,serverId:String(row.server_id),projectId:String(row.project_id),actorId:String(row.actor_id),generation:Number(row.generation),
      ...JSON.parse(String(row.scope_json)),revokedAt:row.revoked_at===null?null:Number(row.revoked_at),createdAt:Number(row.created_at)};
  }
  private currentGrant(id: string): AutomationGrant {
    const grant=this.grant(id), actor=this.row('SELECT kind,enabled,generation FROM actors WHERE id=?',grant.actorId);
    if(grant.revokedAt!==null || actor?.kind!=='human' || actor.enabled!==1 || actor.generation!==grant.generation)
      throw new AutomationError('automation_grant_revoked',403);
    return grant;
  }
  private mutation<T>(caller: AutomationCaller, key: unknown, input: unknown, change:()=>T): T {
    this.actor(caller.context);
    const id=automationText(key,128),digest=createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
    return sqliteTransaction(this.db,()=>{
      const old=this.row('SELECT digest,result FROM automation_mutations WHERE actor_id=? AND key=?',caller.context.actorId,id);
      if(old) {
        if(old.digest!==digest)throw new AutomationError('automation_idempotency_conflict',409);
        return JSON.parse(String(old.result)) as T;
      }
      const result=change();
      this.run('INSERT INTO automation_mutations VALUES(?,?,?,?)',caller.context.actorId,id,digest,JSON.stringify(result));
      return result;
    });
  }
  private definition(id: string, caller?: AutomationCaller): Automation {
    const row=this.row('SELECT value FROM project_automations WHERE id=? AND deleted=0',id);
    if(!row)throw new AutomationError('automation_unavailable',404);
    const value=JSON.parse(String(row.value)) as Automation;
    if(caller && value.creatorActorId!==caller.context.actorId)throw new AutomationError('automation_unavailable',404);
    return value;
  }
  private write(value: Automation): void {
    this.run('UPDATE project_automations SET grant_id=?,revision=?,enabled=?,value=? WHERE id=?',value.grantId,value.revision,value.enabled?1:0,JSON.stringify(value),value.id);
  }
  private derived(authorityId?: string): boolean {
    if (!authorityId) return false;
    const root=this.row('SELECT root_authority_id FROM opencraft_delegation_roots WHERE authority_id=?',authorityId)?.root_authority_id??authorityId;
    return !!this.row('SELECT 1 FROM automation_delegations WHERE authority_id=?',String(root));
  }
  grantReplay(caller:AutomationCaller,command:string,body:Record<string,unknown>,key:unknown):unknown {
    this.actor(caller.context);
    const id=automationText(key,128),old=this.row('SELECT digest,result FROM automation_mutations WHERE actor_id=? AND key=?',caller.context.actorId,id);
    if(!old)return null;
    const digest=createHash('sha256').update(JSON.stringify(canonical(['grant',command,body]))).digest('hex');
    if(old.digest!==digest)throw new AutomationError('automation_idempotency_conflict',409);
    return JSON.parse(String(old.result));
  }
  grantCommand(caller: AutomationCaller, command: string, body: Record<string,unknown>, key: unknown): unknown {
    // Only the authenticated human HTTP surface can invoke this method.
    if(caller.authorityId)throw new AutomationError('automation_human_authority_required',403);
    const {permissionSnapshot:_snapshot,...identity}=body;
    return this.mutation(caller,key,['grant',command,identity],()=>{
      if(command==='revoke') {
        automationFields(body,['id']);
        const grant=this.grant(automationText(body.id));
        if(grant.actorId!==caller.context.actorId)throw new AutomationError('automation_grant_unavailable',404);
        this.run('UPDATE automation_grants SET revoked_at=COALESCE(revoked_at,?) WHERE id=?',this.now,grant.id);
        return {...grant,revokedAt:grant.revokedAt??this.now};
      }
      if(command!=='create')throw new AutomationError('unknown_grant_command');
      automationFields(body,['serverId','projectId','target','permissionProfile','permissionSnapshot']);
      const grant:AutomationGrant={id:randomUUID(),serverId:automationText(body.serverId),projectId:automationText(body.projectId),
        actorId:caller.context.actorId,generation:caller.context.generation,target:parseAutomationTarget(body.target),
        permissionProfile:automationText(body.permissionProfile),permissionSnapshot:automationText(body.permissionSnapshot,4096),revokedAt:null,createdAt:this.now};
      this.run('INSERT INTO automation_grants VALUES(?,?,?,?,?,?,NULL,?)',grant.id,grant.serverId,grant.projectId,grant.actorId,grant.generation,
        JSON.stringify({target:grant.target,permissionProfile:grant.permissionProfile,permissionSnapshot:grant.permissionSnapshot}),this.now);
      return grant;
    });
  }
  command(caller: AutomationCaller, command: string, body: Record<string,unknown>, key?: unknown): unknown {
    this.actor(caller.context);
    if(command==='list'||command==='runs') {
      automationFields(body,command==='list'?['projectId','cursor','limit']:['id','cursor','limit']);
      const scope=command==='list'?automationText(body.projectId):automationText(body.id);
      if(command==='runs')this.definition(scope,caller);
      const limit=body.limit??20;
      if(!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>100)throw new AutomationError('invalid_automation_limit');
      let after='';
      if(body.cursor!==undefined) {
        try { const value=JSON.parse(Buffer.from(automationText(body.cursor,2048),'base64url').toString());
          if(value.command!==command || value.scope!==scope || value.actor!==caller.context.actorId)throw Error();
          after=automationText(value.after);
        } catch {throw new AutomationError('invalid_automation_cursor');}
      }
      const rows=command==='list'
        ?this.all('SELECT id AS cursor,value FROM project_automations WHERE project_id=? AND actor_id=? AND deleted=0 AND id>? ORDER BY id LIMIT ?',scope,caller.context.actorId,after,Number(limit)+1)
        :this.all('SELECT key AS cursor,value FROM automation_runs WHERE automation_id=? AND key>? ORDER BY key LIMIT ?',scope,after,Number(limit)+1);
      const page:typeof rows=[];let bytes=0;
      for(const row of rows.slice(0,Number(limit))){const size=Buffer.byteLength(String(row.value));if(page.length&&bytes+size>24*1024)break;page.push(row);bytes+=size;}
      return {items:page.map(row=>{const value=JSON.parse(String(row.value));if(command==='runs'&&Buffer.byteLength(String(row.value))>20*1024)value.result={truncated:true,reason:'output_exceeds_page_limit'};return value;}),nextCursor:rows.length>page.length?Buffer.from(JSON.stringify({command,scope,actor:caller.context.actorId,after:page.at(-1)!.cursor})).toString('base64url'):null};
    }
    if(command==='show') {automationFields(body,['id']);return this.definition(automationText(body.id),caller);}
    if(this.derived(caller.authorityId))throw new AutomationError(command==='create'?'automation_recursive_creation_denied':'automation_recursive_mutation_denied',403);
    return this.mutation(caller,key,['automation',command,body],()=>{
      if(command==='create') {
        automationFields(body,['grantId','schedule']);
        const grant=this.currentGrant(automationText(body.grantId));
        if(grant.actorId!==caller.context.actorId)throw new AutomationError('automation_grant_unavailable',404);
        const schedule=parseAutomationSchedule(body.schedule);
        if(grant.target.kind!=='script' && grant.target.kind!==schedule.kind)throw new AutomationError('automation_schedule_target_mismatch');
        const value:Automation={id:randomUUID(),projectId:grant.projectId,creatorActorId:grant.actorId,revision:1,enabled:true,schedule,
          target:grant.target,permissionProfile:grant.permissionProfile,grantId:grant.id,concurrencyPolicy:'skip',failurePolicy:{consecutiveFailures:3},createdAt:this.now};
        this.run('INSERT INTO project_automations(id,grant_id,project_id,actor_id,revision,enabled,value) VALUES(?,?,?,?,1,1,?)',value.id,value.grantId,value.projectId,value.creatorActorId,JSON.stringify(value));
        return value;
      }
      const value=this.definition(automationText(body.id),caller);
      if(command==='run') {
        automationFields(body,['id','runKey','occurrenceId']);
        const occurrenceId=automationText(body.occurrenceId),expected=automationRunKey(value.id,value.revision,occurrenceId);
        if(body.runKey!==expected)throw new AutomationError('automation_run_key_required');
        // Claim separately after the mutation receipt commits. Reusing the key
        // finds this same immutable occurrence, never creates a replacement.
        return {automation:value,occurrenceId,runKey:expected};
      }
      if(command==='update') {
        automationFields(body,['id','revision','schedule']);
        if(body.revision!==value.revision)throw new AutomationError('automation_revision_conflict',409);
        value.schedule=parseAutomationSchedule(body.schedule);
        if(value.target.kind!=='script' && value.target.kind!==value.schedule.kind)throw new AutomationError('automation_schedule_target_mismatch');
      } else {
        automationFields(body,['id']);
        if(!['pause','resume','delete'].includes(command))throw new AutomationError('unknown_automation_command');
        value.enabled=command==='resume';
        if(command==='resume'){this.currentGrant(value.grantId);this.run('UPDATE project_automations SET failures=0 WHERE id=?',value.id);}
        if(command==='delete')this.run('UPDATE project_automations SET deleted=1 WHERE id=?',value.id);
      }
      value.revision++;this.write(value);return value;
    });
  }
  eligible(): Automation[] {return this.all('SELECT value FROM project_automations WHERE enabled=1 AND deleted=0').map(row=>JSON.parse(String(row.value)));}
  recover(): void {
    sqliteTransaction(this.db,()=>{
      for(const row of this.all("SELECT key,value FROM automation_runs WHERE state IN ('admitted','running')")) {
        const value=JSON.parse(String(row.value)) as AutomationRun;
        this.storeRun({...value,state:'unknown'});
      }
    });
  }
  private storeRun(run: AutomationRun): void {
    this.run('INSERT INTO automation_runs VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET state=excluded.state,value=excluded.value',
      run.key,run.automationId,run.revision,run.occurrenceId,run.state,run.at,JSON.stringify(run));
  }
  claim(id: string, revision: number, occurrenceId: string): { run: AutomationRun; fresh: boolean; grant?: AutomationGrant; automation?: Automation } {
    return sqliteTransaction(this.db,()=>{
      const key=automationRunKey(id,revision,occurrenceId),old=this.row('SELECT value FROM automation_runs WHERE key=?',key);
      if(old)return {run:JSON.parse(String(old.value)),fresh:false};
      const value=this.definition(id);
      if(value.revision!==revision || !value.enabled)throw new AutomationError('automation_revision_conflict',409);
      const active=this.row("SELECT state FROM automation_runs WHERE automation_id=? AND state IN ('planned','admitted','running','unknown') LIMIT 1",id);
      const run:AutomationRun={key,automationId:id,revision,occurrenceId,state:active?'skipped':'admitted',at:this.now,...(active?{result:{reason:active.state==='unknown'?'reconciliation_required':'overlap'}}:{})};
      let grant:AutomationGrant;
      try {grant=this.currentGrant(value.grantId);} catch {
        run.state='skipped';run.result={reason:'grant_revoked'};value.enabled=false;this.write(value);this.storeRun(run);return {run,fresh:false};
      }
      this.storeRun(run);
      return {run,fresh:!active,grant,automation:value};
    });
  }
  settle(key: string, state: AutomationRun['state'], result?: unknown, proof?: string): AutomationRun {
    return sqliteTransaction(this.db,()=>{
      const row=this.row('SELECT value FROM automation_runs WHERE key=?',key);
      if(!row)throw new AutomationError('automation_run_unavailable',404);
      const run=JSON.parse(String(row.value)) as AutomationRun;
      if(['completed','failed','skipped'].includes(run.state))return run;
      if(run.state==='unknown' && !proof)throw new AutomationError('automation_reconciliation_required',409);
      if(!['running','completed','failed','unknown'].includes(state))throw new AutomationError('invalid_automation_settlement');
      run.state=state;if(result!==undefined)run.result=result;this.storeRun(run);
      if(state==='completed'||state==='failed') {
        const owner=this.row('SELECT value,failures FROM project_automations WHERE id=?',run.automationId)!;
        const value=JSON.parse(String(owner.value)) as Automation, failures=state==='completed'?0:Number(owner.failures)+1;
        if(failures>=3 || value.schedule.kind==='once' && value.revision===run.revision)value.enabled=false;
        this.run('UPDATE project_automations SET failures=? WHERE id=?',failures,value.id);this.write(value);
      }
      return run;
    });
  }
  delegation(key: string, sourceThreadId: string): {id:string;context:ActorContext;sourceThreadId:string;expiresAtMs:number} {
    return sqliteTransaction(this.db,()=>{
      const run=this.row("SELECT * FROM automation_runs WHERE key=? AND state='admitted'",key);
      if(!run)throw new AutomationError('automation_run_not_admitted',409);
      const automation=this.definition(String(run.automation_id)),grant=this.currentGrant(automation.grantId);
      const id=randomUUID(),expiresAt=this.now+3_600_000;
      this.run('INSERT INTO conversation_authorities VALUES(?,?,NULL,?,?,?,?,?,?)',id,sourceThreadId,`automation-${key}`,grant.actorId,grant.generation,null,expiresAt,this.now);
      this.run('INSERT INTO automation_delegations VALUES(?,?,?)',id,key,grant.id);
      return {id,sourceThreadId,context:{actorId:grant.actorId,generation:grant.generation,credentialId:null,expiresAt},expiresAtMs:expiresAt};
    });
  }
  enqueue(key:string, id:string, threadId:string):{requestId:string;inputId:string} {
    return sqliteTransaction(this.db,()=>{
      const grantCheck=this.checkDelegation(id);
      if(!grantCheck.valid || !grantCheck.grant)throw new AutomationError('automation_grant_revoked',403);
      const grant=grantCheck.grant,target=grant.target;
      if(target.kind!=='cron'||target.threadId!==threadId)throw new AutomationError('automation_target_changed',403);
      const authority=this.row('SELECT * FROM conversation_authorities WHERE id=?',id)!;
      const context={actorId:grant.actorId,generation:grant.generation,credentialId:null,expiresAt:Number(authority.expires_at)};
      const source={database:this.db,outcome:{status:'up-to-date',path:''} as any};
      const actors=new ActorStore(source,()=>this.now);
      const collaboration=new Collaboration(source,actors,{serverId:grant.serverId,hostId:target.environment,
        async validate(){},async receipt(){return null;},async add(){return null;},async steer(){},async cancel(){return false;},},()=>this.now);
      try {
        const sent=collaboration.sendConversation(context,{reference:{serverId:grant.serverId,threadId},content:target.prompt,idempotencyKey:key,execution:{mode:'queue'}},null,id,true,key);
        if(!sent.requestId)throw new AutomationError('automation_input_unavailable',503);
        const inputId='actor-input:'+sent.requestId;
        this.run('INSERT OR IGNORE INTO opencraft_input_authorities(thread_id,input_id,authority_id) VALUES(?,?,?)',threadId,inputId,id);
        const row=this.row('SELECT value FROM automation_runs WHERE key=?',key)!;
        const run=JSON.parse(String(row.value)) as AutomationRun;
        run.result={serverId:grant.serverId,threadId,inputId};this.storeRun(run);
        return {requestId:sent.requestId,inputId};
      } finally {actors.close();void collaboration.close();}
    });
  }
  projection(): {authorityId:string;grantId:string;valid:boolean}[] {
    // Only live run authorities participate. Historical audit rows stay durable
    // without entering the per-second projection or the main-thread Map.
    return sqliteTransaction(this.db,()=>this.all(`SELECT d.authority_id,d.grant_id FROM automation_runs r
      JOIN automation_delegations d ON d.run_key=r.key WHERE r.state IN ('admitted','running','unknown')`).map(row=>{
      const id=String(row.authority_id),valid=this.checkDelegation(id).valid;
      if(valid){
        const authority=this.row('SELECT expires_at FROM conversation_authorities WHERE id=?',id);
        if(authority && Number(authority.expires_at)<this.now+900_000){
          const pending=this.all(`SELECT r.id FROM actor_execution_requests r JOIN opencraft_input_origins o
            ON o.thread_id=r.thread_id AND o.input_id='actor-input:'||r.id
            WHERE json_extract(o.origin_json,'$.delegationId')=? AND r.state IN ('accepted','transferring','queued')`,id);
          if(pending.length){
            const expiresAt=this.now+3_600_000;
            this.run('UPDATE conversation_authorities SET expires_at=? WHERE id=?',expiresAt,id);
            for(const request of pending)this.run('UPDATE actor_execution_requests SET expires_at=? WHERE id=?',expiresAt,String(request.id));
            this.run(`UPDATE conversation_authorities SET expires_at=? WHERE id IN
              (SELECT authority_id FROM opencraft_delegation_roots WHERE root_authority_id=?)`,expiresAt,id);
          }
        }
      }
      return {authorityId:id,grantId:String(row.grant_id),valid};
    }));
  }
  unknownRuns():AutomationRun[] {return this.all("SELECT value FROM automation_runs WHERE state='unknown'").map(row=>JSON.parse(String(row.value)));}
  runGrant(key:string):AutomationGrant {
    const run=this.row('SELECT automation_id FROM automation_runs WHERE key=?',key);
    if(!run)throw new AutomationError('automation_run_unavailable',404);
    const owner=this.row('SELECT grant_id FROM project_automations WHERE id=?',String(run.automation_id));
    if(!owner)throw new AutomationError('automation_unavailable',404);
    return this.grant(String(owner.grant_id));
  }
  checkRunGrant(key: string): boolean {
    const run=this.row('SELECT automation_id FROM automation_runs WHERE key=?',key);
    if(!run)return false;
    const value=this.definition(String(run.automation_id));
    if(!value.enabled)return false;
    this.currentGrant(value.grantId);return true;
  }
  checkDelegation(id: string): {derived:boolean; valid:boolean; grant?:AutomationGrant; runKey?:string} {
    const root=String(this.row('SELECT root_authority_id FROM opencraft_delegation_roots WHERE authority_id=?',id)?.root_authority_id??id);
    const derived=this.row('SELECT grant_id,run_key FROM automation_delegations WHERE authority_id=?',root);
    if(!derived)return {derived:false,valid:true};
    try {const grant=this.currentGrant(String(derived.grant_id));return {derived:true,valid:true,grant,runKey:String(derived.run_key)};}catch{return {derived:true,valid:false,runKey:String(derived.run_key)};}
  }
}
