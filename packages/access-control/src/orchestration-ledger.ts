import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** Appended to the collaboration owner's migrations; never opened independently. */
export { ORCHESTRATION_SCHEMA } from "@opencraft/storage-node/server-legacy";

/** v5 adds durable runtime facts without fabricating parentage or ownership. */
export { ORCHESTRATION_VIEW_SCHEMA } from "@opencraft/storage-node/server-legacy";

export type ThreadRuntimeStatus = 'starting' | 'active' | 'recovering' | 'awaiting_interaction' | 'idle' | 'error';
export interface ThreadRelation {
  threadId: string; serverId: string; driverKind: string; ownerActorId: string;
  parentThreadId: string | null; lifecycleOwnerThreadId: string | null; forkedFromId: string | null;
  visibility: 'visible' | 'hidden'; engineHostGeneration: string | null; nativeSessionId: string | null;
  runtimeStatus: ThreadRuntimeStatus; rootTurnId: string | null; turnId: string | null;
  delegationRevision: number; autoExchangeDepth: number; hasDirectUserInput: boolean; userInputExcerpt: string | null;
}
export interface ToolOperation {
  operationId: string; toolCallKey: string; delegationId: string; issuerActorId: string;
  kind: string; senderThreadId: string; targetThreadId: string | null; clientMessageId: string | null;
  mode: string; state: string; waitingOn: string | null; result: unknown; arguments: Record<string, unknown>;
}
export interface WaitTicket {
  waitTicketId: string; callerThreadId: string; callerTurnId: string; targetThreadIds: string[];
  waitFor: 'all_settled' | 'any_settled'; state: 'active' | 'satisfied' | 'expired' | 'cancelled'; expiresAtMs: number;
}
export type ChildOutcome = 'completed' | 'failed' | 'exhausted' | 'unconfirmed' | 'interrupted_by_user' | 'awaiting_interaction';
export interface ParentNotification {
  batchId: string; parentThreadId: string; childThreadId: string; childRootTurnId: string;
  outcomeKind: ChildOutcome; hasDirectUserInput: boolean; userInputExcerpt: string | null; summary: unknown;
  firstQueuedAtMs: number; deliverAfterMs: number; maxDeadlineMs: number; clientMessageId: string | null;
}
/** Stable hashing ignores JSON object property order while retaining array order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
const decode = (value: unknown) => value === null ? null : JSON.parse(String(value));
type Row = Record<string, unknown>;
function operation(r: Row): ToolOperation {
  return {operationId:String(r.operation_id),toolCallKey:String(r.tool_call_key),delegationId:String(r.delegation_id),issuerActorId:String(r.issuer_actor_id),
    kind:String(r.kind),senderThreadId:String(r.sender_thread_id),targetThreadId:r.target_thread_id as string|null,clientMessageId:r.client_message_id as string|null,
    mode:String(r.mode),state:String(r.state),waitingOn:r.waiting_on as string|null,result:decode(r.result_json),arguments:decode(r.arguments_json)};
}
function ticket(r: Row): WaitTicket {
  return {waitTicketId:String(r.wait_ticket_id),callerThreadId:String(r.caller_thread_id),callerTurnId:String(r.caller_turn_id),targetThreadIds:decode(r.target_thread_ids_json),
    waitFor:r.wait_for as WaitTicket['waitFor'],state:r.state as WaitTicket['state'],expiresAtMs:Number(r.expires_at_ms)};
}
function notification(r: Row): ParentNotification {
  return {batchId:String(r.batch_id),parentThreadId:String(r.parent_thread_id),childThreadId:String(r.child_thread_id),childRootTurnId:String(r.child_root_turn_id),
    outcomeKind:r.outcome_kind as ChildOutcome,hasDirectUserInput:r.has_direct_user_input===1,userInputExcerpt:r.user_input_excerpt as string|null,summary:decode(r.summary_json),
    firstQueuedAtMs:Number(r.first_queued_at_ms),deliverAfterMs:Number(r.deliver_after_ms),maxDeadlineMs:Number(r.max_deadline_ms),clientMessageId:r.client_message_id as string|null};
}

/** Trusted Hub control storage. Callers authorize before writes; this owns no execution queue or connection. */
export class ThreadOrchestrationLedger {
  constructor(private readonly db: DatabaseSync, private readonly now = Date.now) {}
  transaction<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  observeRuntime(snapshot: import('@opencraft/appserver-protocol/collaboration').ThreadOrchestrationSnapshot): void {
    this.db.prepare('INSERT INTO opencraft_orchestration_runtime_views VALUES(?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET root_turn_id=excluded.root_turn_id,turn_id=excluded.turn_id,state=excluded.state,updated_at_ms=excluded.updated_at_ms WHERE root_turn_id IS NOT excluded.root_turn_id OR turn_id IS NOT excluded.turn_id OR state IS NOT excluded.state')
      .run(snapshot.threadId,snapshot.rootTurnId,snapshot.turnId,snapshot.state,this.now());
  }
  /** Durable observation is one transaction, including any resulting parent notice. */
  observeSnapshot(snapshot: import('@opencraft/appserver-protocol/collaboration').ThreadOrchestrationSnapshot): void {
    this.transaction(() => {
    this.observeRuntime(snapshot);
    const child=this.relation(snapshot.threadId);if(!child)return;
    const runtimeStatus:ThreadRelation['runtimeStatus']=snapshot.state==='recovering'?'recovering':snapshot.state==='starting'?'starting':snapshot.state==='active'?'active'
      :snapshot.state==='awaiting_interaction'||snapshot.state==='unconfirmed'?'awaiting_interaction':snapshot.state==='completed'?'idle':'error';
    this.runtime(child.threadId,{runtimeStatus,rootTurnId:snapshot.rootTurnId,turnId:snapshot.turnId});
    const origin=snapshot.turnId?this.turnOrigin(snapshot.threadId,snapshot.turnId):null;
    if(origin?.kind==='user')this.directUserInput(child.threadId,origin.userInputExcerpt??null);
    if(snapshot.state==='interrupted_by_user')this.directUserInput(child.threadId,null);
    if(!child.parentThreadId||!snapshot.rootTurnId||!['completed','failed','exhausted','unconfirmed','interrupted_by_user'].includes(snapshot.state)&&snapshot.state!=='awaiting_interaction')return;
    const current=this.relation(child.threadId)!;
    this.queueNotification({parentThreadId:child.parentThreadId,childThreadId:child.threadId,childRootTurnId:snapshot.rootTurnId,outcomeKind:snapshot.state as ChildOutcome,
      hasDirectUserInput:current.hasDirectUserInput,userInputExcerpt:current.userInputExcerpt,summary:{text:snapshot.summary?.slice(0,4096)??snapshot.state}});
    });
  }
  /** Provenance lookup only; this does not authorize execution or notifications. */
  turnOrigin(threadId: string, turnId: string): import('./orchestration-authority.js').OrchestrationMessageOrigin | null {
    const authority = this.db.prepare('SELECT a.* FROM conversation_authorities a JOIN conversation_turn_authorities t ON t.authority_id=a.id WHERE t.thread_id=? AND t.turn_id=? UNION ALL SELECT * FROM conversation_authorities WHERE thread_id=? AND turn_id=? LIMIT 1').get(threadId,turnId,threadId,turnId);
    if (!authority?.input_id) return null;
    const row = this.db.prepare('SELECT origin_json FROM opencraft_input_origins WHERE thread_id=? AND input_id=?').get(threadId,authority.input_id);
    return row ? JSON.parse(String(row.origin_json)) : null;
  }
  runtimeSnapshot(threadId: string): import('@opencraft/appserver-protocol/collaboration').ThreadOrchestrationSnapshot | null {
    const row = this.db.prepare('SELECT * FROM opencraft_orchestration_runtime_views WHERE thread_id=?').get(threadId);
    return row ? {threadId,rootTurnId:row.root_turn_id as string|null,turnId:row.turn_id as string|null,
      state:row.state as import('@opencraft/appserver-protocol/collaboration').ThreadOrchestrationSnapshot['state']} : null;
  }
  observedRuntimeThreads(includeTerminal: boolean): string[] {
    return this.db.prepare("SELECT thread_id FROM opencraft_orchestration_runtime_views WHERE ? OR state IN ('starting','active','recovering','awaiting_interaction')")
      .all(includeTerminal?1:0).map(row => String(row.thread_id));
  }
  relation(threadId: string): ThreadRelation | null {
    const r = this.db.prepare('SELECT * FROM opencraft_thread_relations WHERE thread_id=?').get(threadId);
    return r ? {threadId:String(r.thread_id),serverId:String(r.server_id),driverKind:String(r.driver_kind),ownerActorId:String(r.owner_actor_id),
      parentThreadId:r.parent_thread_id as string|null,lifecycleOwnerThreadId:r.lifecycle_owner_thread_id as string|null,forkedFromId:r.forked_from_id as string|null,
      visibility:r.visibility as ThreadRelation['visibility'],engineHostGeneration:r.engine_host_generation as string|null,nativeSessionId:r.native_session_id as string|null,
      runtimeStatus:r.runtime_status as ThreadRuntimeStatus,rootTurnId:r.root_turn_id as string|null,turnId:r.turn_id as string|null,
      delegationRevision:Number(r.delegation_revision),autoExchangeDepth:Number(r.auto_exchange_depth),hasDirectUserInput:r.has_direct_user_input===1,userInputExcerpt:r.user_input_excerpt as string|null} : null;
  }
  children(parentThreadId: string, after: number, limit: number) {
    return this.db.prepare(`SELECT rowid AS cursor,thread_id,server_id,driver_kind,visibility,
      runtime_status,has_direct_user_input,updated_at_ms FROM opencraft_thread_relations
      WHERE parent_thread_id=? AND rowid>? ORDER BY rowid LIMIT ?`).all(parentThreadId,after,limit);
  }
  createThread(value: ThreadRelation): ThreadRelation {
    return this.transaction(() => {
      const prior = this.relation(value.threadId);
      if (prior) {
        if (prior.ownerActorId !== value.ownerActorId || prior.serverId !== value.serverId || prior.parentThreadId !== value.parentThreadId
          || prior.lifecycleOwnerThreadId !== value.lifecycleOwnerThreadId) throw new Error('Thread relationship already registered');
        return prior;
      }
      if (value.parentThreadId === value.threadId || value.lifecycleOwnerThreadId === value.threadId) throw new Error('Thread cannot own itself');
      for (const field of ['parentThreadId', 'lifecycleOwnerThreadId'] as const) {
        const seen = new Set([value.threadId]); let ancestor = value[field];
        while (ancestor) {
          if (seen.has(ancestor)) throw new Error('Cyclic thread relationship');
          seen.add(ancestor); ancestor = this.relation(ancestor)?.[field] ?? null;
        }
      }
      this.db.prepare('INSERT INTO opencraft_thread_relations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        value.threadId,value.serverId,value.driverKind,value.engineHostGeneration,value.nativeSessionId,value.ownerActorId,value.parentThreadId,value.lifecycleOwnerThreadId,
        value.forkedFromId,value.visibility,value.runtimeStatus,value.rootTurnId,value.turnId,value.delegationRevision,value.autoExchangeDepth,value.hasDirectUserInput?1:0,value.userInputExcerpt,this.now());
      return value;
    });
  }
  threads(): ThreadRelation[] { return this.db.prepare('SELECT thread_id FROM opencraft_thread_relations ORDER BY thread_id').all().map(r => this.relation(String(r.thread_id))!); }
  runtime(threadId: string, update: Pick<ThreadRelation,'runtimeStatus'|'rootTurnId'|'turnId'>): void {
    this.db.prepare('UPDATE opencraft_thread_relations SET has_direct_user_input=CASE WHEN root_turn_id IS ? THEN has_direct_user_input ELSE 0 END,user_input_excerpt=CASE WHEN root_turn_id IS ? THEN user_input_excerpt ELSE NULL END,runtime_status=?,root_turn_id=?,turn_id=?,updated_at_ms=? WHERE thread_id=? AND (runtime_status IS NOT ? OR root_turn_id IS NOT ? OR turn_id IS NOT ?)')
      .run(update.rootTurnId,update.rootTurnId,update.runtimeStatus,update.rootTurnId,update.turnId,this.now(),threadId,update.runtimeStatus,update.rootTurnId,update.turnId);
  }
  directUserInput(threadId: string, excerpt: string | null): void {
    this.db.prepare('UPDATE opencraft_thread_relations SET has_direct_user_input=1,user_input_excerpt=?,updated_at_ms=? WHERE thread_id=? AND (has_direct_user_input<>1 OR user_input_excerpt IS NOT ?)').run(excerpt?.slice(0,512)??null,this.now(),threadId,excerpt?.slice(0,512)??null);
  }
  operation(toolCallKey: string): ToolOperation | null {
    const row = this.db.prepare('SELECT o.* FROM opencraft_orchestration_operations o JOIN opencraft_orchestration_tool_calls c ON c.operation_id=o.operation_id WHERE c.tool_call_key=?').get(toolCallKey); return row ? operation(row) : null;
  }
  accept(value: Omit<ToolOperation,'operationId'|'state'|'waitingOn'|'result'> & {idempotencyKey?: string}): ToolOperation {
    return this.transaction(() => {
      const {toolCallKey, arguments: args, idempotencyKey, ...identity} = value;
      const fingerprint = createHash('sha256').update(JSON.stringify(canonical({identity,args}))).digest('hex');
      // Explicit keys are scoped to the source session, never shared across users or sessions.
      const scopedKey = idempotencyKey ? JSON.stringify([value.senderThreadId,idempotencyKey]) : null;
      const prior = this.db.prepare('SELECT DISTINCT o.* FROM opencraft_orchestration_operations o LEFT JOIN opencraft_orchestration_tool_calls c ON c.operation_id=o.operation_id WHERE c.tool_call_key=? OR o.idempotency_key=?').all(toolCallKey,scopedKey);
      if (prior.length) {
        if (prior.length !== 1 || prior[0]!.fingerprint !== fingerprint || scopedKey !== null && prior[0]!.idempotency_key !== scopedKey) throw new Error('Orchestration idempotency key reused');
        this.db.prepare('INSERT OR IGNORE INTO opencraft_orchestration_tool_calls VALUES(?,?)').run(toolCallKey,String(prior[0]!.operation_id));
        return operation(prior[0]!);
      }
      const id = randomUUID(), now = this.now();
      this.db.prepare("INSERT INTO opencraft_orchestration_operations(operation_id,tool_call_key,idempotency_key,fingerprint,arguments_json,delegation_id,issuer_actor_id,kind,sender_thread_id,target_thread_id,client_message_id,mode,state,waiting_on,result_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'accepted',NULL,NULL,?,?)").run(
        id,toolCallKey,scopedKey,fingerprint,JSON.stringify(args),value.delegationId,value.issuerActorId,value.kind,value.senderThreadId,value.targetThreadId,value.clientMessageId,value.mode,now,now);
      this.db.prepare('INSERT INTO opencraft_orchestration_tool_calls VALUES(?,?)').run(toolCallKey,id);
      return this.operation(toolCallKey)!;
    });
  }
  finish(toolCallKey: string, result: unknown, state = 'completed', targetThreadId: string | null = null, clientMessageId: string | null = null): ToolOperation {
    const json = JSON.stringify(result);
    if (json === undefined) throw new Error('Orchestration result must be JSON');
    return this.transaction(() => {
      const prior = this.operation(toolCallKey);
      if (!prior) throw new Error('Orchestration operation missing');
      if (this.db.prepare('SELECT result_json FROM opencraft_orchestration_operations WHERE operation_id=?').get(prior.operationId)?.result_json !== null) {
        if (JSON.stringify(prior.result) !== json) throw new Error('Orchestration receipt already finalized');
        return prior;
      }
      this.db.prepare('UPDATE opencraft_orchestration_operations SET result_json=?,state=?,target_thread_id=COALESCE(?,target_thread_id),client_message_id=COALESCE(?,client_message_id),updated_at_ms=? WHERE operation_id=?')
        .run(json,state,targetThreadId,clientMessageId,this.now(),prior.operationId);
      return this.operation(toolCallKey)!;
    });
  }
  operationById(id:string):ToolOperation|null {const row=this.db.prepare('SELECT * FROM opencraft_orchestration_operations WHERE operation_id=?').get(id);return row?operation(row):null;}
  /** Match exact Native Turn/Item identities, including replay aliases. */
  callForItem(senderThreadId: string, turnId: string, itemId: string): ToolOperation | null {
    const suffix = `:${senderThreadId}:${turnId}:${itemId}`;
    const key = this.db.prepare('SELECT c.tool_call_key FROM opencraft_orchestration_tool_calls c JOIN opencraft_orchestration_operations o ON o.operation_id=c.operation_id WHERE o.sender_thread_id=? AND (c.tool_call_key=? OR substr(c.tool_call_key,-length(?))=?) LIMIT 1')
      .get(senderThreadId,`${senderThreadId}:${turnId}:${itemId}`,suffix,suffix)?.tool_call_key;
    return key === undefined ? null : this.operation(String(key));
  }
  pendingOperations(): ToolOperation[] { return this.db.prepare('SELECT * FROM opencraft_orchestration_operations WHERE result_json IS NULL ORDER BY created_at_ms').all().map(operation); }
  createWait(value: Omit<WaitTicket,'state'>): WaitTicket {
    return this.transaction(() => {
      const prior = this.wait(value.waitTicketId);
      if (prior) {
        if (prior.callerThreadId!==value.callerThreadId || prior.callerTurnId!==value.callerTurnId || prior.waitFor!==value.waitFor || JSON.stringify(prior.targetThreadIds)!==JSON.stringify(value.targetThreadIds) || prior.expiresAtMs!==value.expiresAtMs) throw new Error('Wait ticket already registered');
        return prior;
      }
      this.db.prepare("INSERT INTO opencraft_wait_tickets VALUES(?,?,?,?,?,'active',?,?)").run(value.waitTicketId,value.callerThreadId,value.callerTurnId,JSON.stringify(value.targetThreadIds),value.waitFor,this.now(),value.expiresAtMs);
      return this.wait(value.waitTicketId)!;
    });
  }
  wait(id: string): WaitTicket | null { const r=this.db.prepare('SELECT * FROM opencraft_wait_tickets WHERE wait_ticket_id=?').get(id); return r ? ticket(r):null; }
  activeWaits(): WaitTicket[] {
    this.db.prepare("UPDATE opencraft_wait_tickets SET state='expired' WHERE state='active' AND expires_at_ms<=?").run(this.now());
    return this.db.prepare("SELECT * FROM opencraft_wait_tickets WHERE state='active' ORDER BY created_at_ms").all().map(ticket);
  }
  settleWait(id: string, state: 'satisfied'|'cancelled'): void { this.db.prepare("UPDATE opencraft_wait_tickets SET state=? WHERE wait_ticket_id=? AND state='active'").run(state,id); }
  queueNotification(value: Omit<ParentNotification,'batchId'|'firstQueuedAtMs'|'deliverAfterMs'|'maxDeadlineMs'|'clientMessageId'>): ParentNotification {
    return this.transaction(() => {
      const now=this.now();
      const prior=this.db.prepare('SELECT * FROM opencraft_parent_notification_batches WHERE parent_thread_id=? AND child_thread_id=? AND child_root_turn_id=? AND outcome_kind=?')
        .get(value.parentThreadId,value.childThreadId,value.childRootTurnId,value.outcomeKind);
      if (prior) return notification(prior);
      // Sliding debounce is per parent, bounded by the oldest pending child's deadline.
      const pending=this.db.prepare("SELECT MIN(max_deadline_ms) AS deadline FROM opencraft_parent_notification_batches WHERE parent_thread_id=? AND state='pending'").get(value.parentThreadId);
      const deadline=pending?.deadline===null ? now+5000 : Number(pending?.deadline??now+5000);
      const due=Math.min(now+2000,deadline), id=randomUUID();
      this.db.prepare("UPDATE opencraft_parent_notification_batches SET deliver_after_ms=? WHERE parent_thread_id=? AND state='pending'").run(due,value.parentThreadId);
      this.db.prepare("INSERT INTO opencraft_parent_notification_batches VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',NULL)").run(id,value.parentThreadId,value.childThreadId,value.childRootTurnId,value.outcomeKind,
        value.hasDirectUserInput?1:0,value.userInputExcerpt,JSON.stringify(value.summary),now,due,deadline);
      return notification(this.db.prepare('SELECT * FROM opencraft_parent_notification_batches WHERE batch_id=?').get(id)!);
    });
  }
  dueNotifications(): ParentNotification[] { return this.db.prepare("SELECT * FROM opencraft_parent_notification_batches WHERE state='pending' AND (deliver_after_ms<=? OR max_deadline_ms<=?) ORDER BY first_queued_at_ms,batch_id").all(this.now(),this.now()).map(notification); }
  markNotificationsDelivered(ids: readonly string[], clientMessageId: string): void {
    this.transaction(() => { for (const id of ids) this.db.prepare("UPDATE opencraft_parent_notification_batches SET state='delivered',client_message_id=? WHERE batch_id=? AND state='pending'").run(clientMessageId,id); });
  }
}
