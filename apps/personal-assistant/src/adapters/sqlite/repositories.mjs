import { SqliteUserMessages } from "./user-messages.mjs";
import { SqliteConversationContext } from "./conversation-context.mjs";
import { searchHistory } from "./history-read.mjs";
import {
  memoryColumns,
  memoryJoin,
  readMemories,
  recallMemories,
  promptMemories,
  listMemoryFiles,
} from "./memory-read.mjs";
import { stable } from "../../domain/values.mjs";

class Repository {
  constructor(uow) {
    this.db = uow.db;
  }
}
export class GoalRepository extends Repository {
  get(id) {
    return this.db.prepare("SELECT * FROM goal WHERE id=?").get(id);
  }
  list() {
    return this.db
      .prepare("SELECT * FROM goal ORDER BY priority DESC,created_at,id")
      .all();
  }
  forWork(id) {
    return this.db
      .prepare(
        "SELECT g.* FROM goal g JOIN goal_work gw ON gw.goal_id=g.id WHERE gw.work_id=?",
      )
      .get(id);
  }
  members(id) {
    return this.db
      .prepare(
        "SELECT w.*,gw.task_key FROM work w JOIN goal_work gw ON gw.work_id=w.id WHERE gw.goal_id=? ORDER BY w.created_at,w.id",
      )
      .all(id);
  }
  add(g) {
    this.db
      .prepare("INSERT INTO goal VALUES(?,?,?,1,'active',?,?,?,NULL,?)")
      .run(
        g.id,
        g.objective,
        stable(g.criteria),
        g.priority,
        g.maxParallel,
        g.at,
        stable(g.resources),
      );
  }
  update(g) {
    this.db
      .prepare(
        "UPDATE goal SET revision=?,state=?,priority=?,max_parallel=?,confirmation_json=? WHERE id=?",
      )
      .run(
        g.revision,
        g.state,
        g.priority,
        g.max_parallel,
        g.confirmation_json ?? null,
        g.id,
      );
  }
  link(goalId, workId, key) {
    this.db
      .prepare("INSERT INTO goal_work VALUES(?,?,?)")
      .run(goalId, workId, key);
  }
  dependencies(id) {
    return this.db
      .prepare(
        "SELECT * FROM work_dependency WHERE work_id=? ORDER BY upstream_id",
      )
      .all(id);
  }
  depend(workId, upstreamId, revision) {
    this.db
      .prepare("INSERT INTO work_dependency VALUES(?,?,?)")
      .run(workId, upstreamId, revision);
  }
  rebind(workId, upstreamId, revision) {
    this.db
      .prepare(
        "UPDATE work_dependency SET revision=? WHERE work_id=? AND upstream_id=?",
      )
      .run(revision, workId, upstreamId);
  }
  result(workId, revision) {
    return this.db
      .prepare(
        "SELECT r.*,a.data_json AS assessment_json FROM result r JOIN work w ON w.active_execution_id=r.execution_id JOIN completion_assessment a ON a.execution_id=r.execution_id WHERE r.work_id=? AND r.revision=? AND w.revision=? AND w.status IN ('awaiting_delivery','completed')",
      )
      .get(workId, revision, revision);
  }
  inputs(id) {
    return this.db
      .prepare(
        "SELECT * FROM execution_dependency WHERE execution_id=? ORDER BY upstream_id",
      )
      .all(id);
  }
  input(id, upstreamId, resultId) {
    this.db
      .prepare("INSERT INTO execution_dependency VALUES(?,?,?)")
      .run(id, upstreamId, resultId);
  }
}
export class MetaRepository extends Repository {
  identity() {
    const r = this.db
      .prepare("SELECT value FROM meta WHERE key='identity'")
      .get();
    return r && JSON.parse(r.value);
  }
  bind(identity) {
    this.db
      .prepare("INSERT OR IGNORE INTO meta VALUES('identity',?)")
      .run(stable(identity));
    this.db
      .prepare("INSERT OR IGNORE INTO meta VALUES('memory_epoch','0')")
      .run();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO meta(key,value) SELECT 'memory_guard_epoch',value FROM meta WHERE key='memory_epoch'",
      )
      .run();
  }
  explicitMemoryEpoch() {
    return Number(
      this.db
        .prepare("SELECT value FROM meta WHERE key='memory_guard_epoch'")
        .get().value,
    );
  }
  advanceExplicitMemoryEpoch() {
    this.db
      .prepare(
        "UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='memory_guard_epoch'",
      )
      .run();
  }
  memoryEpoch() {
    return Number(
      this.db.prepare("SELECT value FROM meta WHERE key='memory_epoch'").get()
        .value,
    );
  }
  advanceMemoryEpoch() {
    this.db
      .prepare(
        "UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='memory_epoch'",
      )
      .run();
  }
}
export class InputRepository extends Repository {
  get(id) {
    return this.db.prepare("SELECT * FROM input WHERE id=?").get(id);
  }
  add(id, payload, response, at) {
    this.db
      .prepare("INSERT INTO input VALUES(?,?,?,?,NULL)")
      .run(id, stable(payload), stable(response), at);
  }
  delivered(id, at) {
    this.db
      .prepare(
        "UPDATE input SET delivered_at=COALESCE(delivered_at,?) WHERE id=?",
      )
      .run(at, id);
  }
  forWork(id) {
    return this.db
      .prepare(
        "SELECT i.id,i.received_at,i.delivered_at FROM input i JOIN execution e ON e.input_id=i.id WHERE e.work_id=? ORDER BY e.revision",
      )
      .all(id);
  }
}
export class WorkRepository extends Repository {
  activate(workId, id) {
    this.db
      .prepare("UPDATE work SET active_execution_id=? WHERE id=?")
      .run(id, workId);
  }
  get(id) {
    return this.db.prepare("SELECT * FROM work WHERE id=?").get(id);
  }
  list() {
    return this.db.prepare("SELECT * FROM work ORDER BY created_at,id").all();
  }
  pending() {
    return this.db
      .prepare(
        "SELECT * FROM work WHERE status IN ('queued','running') ORDER BY created_at,id",
      )
      .all();
  }
  add(w) {
    this.db
      .prepare(
        "INSERT INTO work(id,text,revision,status,source,routine_id,routine_revision,created_at,updated_at,error,delegation_json,completion_json,origin_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        w.id,
        w.text,
        w.revision,
        w.status,
        w.source,
        w.routine_id,
        w.routine_revision,
        w.created_at,
        w.updated_at,
        w.error,
        stable(w.delegation),
        w.completion_json ?? null,
        w.origin_json ?? null,
      );
  }
  save(w) {
    this.db
      .prepare(
        "UPDATE work SET text=?,revision=?,status=?,updated_at=?,error=?,completion_json=? WHERE id=?",
      )
      .run(
        w.text,
        w.revision,
        w.status,
        w.updated_at,
        w.error,
        w.completion_json ?? null,
        w.id,
      );
  }
  forRoutine(id) {
    return this.db
      .prepare(
        "SELECT * FROM work WHERE routine_id=? AND status NOT IN ('completed','cancelled')",
      )
      .all(id);
  }
  routineBusy(id) {
    return !!this.db
      .prepare(
        "SELECT id FROM work WHERE routine_id=? AND status NOT IN ('completed','cancelled','blocked')",
      )
      .get(id);
  }
}
export class ExecutionRepository extends Repository {
  threadLink(executionId, id) {
    return this.db
      .prepare(
        "SELECT * FROM execution_thread_link WHERE execution_id=? AND id=?",
      )
      .get(executionId, id);
  }
  threadLinks(executionId) {
    return this.db
      .prepare(
        "SELECT * FROM execution_thread_link WHERE execution_id=? ORDER BY rowid",
      )
      .all(executionId);
  }
  addThreadLink(executionId, id, argv) {
    this.db
      .prepare(
        "INSERT INTO execution_thread_link(execution_id,id,argv_json) VALUES(?,?,?)",
      )
      .run(executionId, id, argv);
  }
  bindThreadLink(executionId, id, operationId) {
    this.db
      .prepare(
        "UPDATE execution_thread_link SET operation_id=? WHERE execution_id=? AND id=?",
      )
      .run(operationId, executionId, id);
  }
  settleThreadLink(executionId, id, outcome) {
    const old = this.threadLink(executionId, id),
      value = stable(outcome);
    if (!old || (old.outcome_json && old.outcome_json !== value))
      throw Error("Immutable platform outcome changed");
    this.db
      .prepare(
        "UPDATE execution_thread_link SET outcome_json=? WHERE execution_id=? AND id=?",
      )
      .run(value, executionId, id);
  }
  pendingThreadLinks(after = 0) {
    return this.db
      .prepare(
        `SELECT l.rowid AS scan_id,l.*,e.work_id,e.revision FROM execution_thread_link l JOIN execution e ON e.id=l.execution_id JOIN work w ON w.active_execution_id=e.id AND w.revision=e.revision WHERE l.rowid>? AND l.outcome_json IS NULL AND w.status IN ('queued','running') ORDER BY l.rowid LIMIT 8`,
      )
      .all(after);
  }
  threadAnswer(executionId) {
    return this.db
      .prepare("SELECT * FROM execution_thread_answer WHERE execution_id=?")
      .get(executionId);
  }
  saveThreadAnswer(executionId, value) {
    this.db
      .prepare("INSERT INTO execution_thread_answer VALUES(?,?,?)")
      .run(executionId, value.text, value.error);
  }
  waitingThreadWorks() {
    return this.db
      .prepare(
        `SELECT w.id FROM execution_thread_answer a JOIN work w ON w.active_execution_id=a.execution_id WHERE w.status IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM execution_report r WHERE r.execution_id=a.execution_id)`,
      )
      .all()
      .map((row) => row.id);
  }
  readyThreadReports(after = 0) {
    return this.db
      .prepare(
        `SELECT a.rowid AS scan_id,a.*,e.work_id,e.revision FROM execution_thread_answer a JOIN execution e ON e.id=a.execution_id JOIN work w ON w.active_execution_id=e.id AND w.revision=e.revision WHERE a.rowid>? AND w.status IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM execution_thread_link l WHERE l.execution_id=e.id AND l.outcome_json IS NULL) AND NOT EXISTS(SELECT 1 FROM execution_report r WHERE r.execution_id=e.id) ORDER BY a.rowid LIMIT 64`,
      )
      .all(after);
  }

  requiredHarnesses() {
    return this.db
      .prepare(
        "SELECT DISTINCT e.harness FROM execution e JOIN work w ON w.active_execution_id=e.id WHERE w.status NOT IN ('completed','cancelled')",
      )
      .all()
      .map((r) => r.harness);
  }
  nativeBindings() {
    return this.db
      .prepare(
        "SELECT e.conversation_id FROM execution e JOIN work w ON w.active_execution_id=e.id WHERE e.harness='codex' AND e.conversation_id IS NOT NULL AND w.status NOT IN ('completed','cancelled')",
      )
      .all()
      .map((r) => JSON.parse(r.conversation_id));
  }
  nativeCalls(id) {
    return this.db
      .prepare(
        "SELECT * FROM execution_native_receipt WHERE execution_id=? ORDER BY rowid",
      )
      .all(id);
  }
  nativeCall(id, callId) {
    return this.db
      .prepare(
        "SELECT * FROM execution_native_receipt WHERE execution_id=? AND call_id=?",
      )
      .get(id, callId);
  }
  prepareNativeCall(id, callId, tool, args) {
    this.db
      .prepare(
        "INSERT INTO execution_native_receipt(execution_id,call_id,tool,args_json,state) VALUES(?,?,?,?,'pending')",
      )
      .run(id, callId, tool, stable(args));
  }
  operationCount(id) {
    return this.db
      .prepare("SELECT COUNT(*) AS n FROM work_operation WHERE execution_id=?")
      .get(id).n;
  }
  recordOperation(id, callId, workId, tool, target, summary, at) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO work_operation(execution_id,call_id,work_id,tool,target,summary,at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(id, callId, workId, tool, target, summary, at);
  }
  nativeOutcome(id, callId, state, output) {
    this.db
      .prepare(
        "UPDATE execution_native_receipt SET state=?,output_json=? WHERE execution_id=? AND call_id=?",
      )
      .run(state, stable(output), id, callId);
  }
  guard(id, value) {
    this.db
      .prepare("UPDATE execution SET guard_json=? WHERE id=?")
      .run(stable(value), id);
  }

  report(executionId) {
    return this.db
      .prepare("SELECT * FROM execution_report WHERE execution_id=?")
      .get(executionId);
  }
  addReport(r) {
    this.db
      .prepare("INSERT INTO execution_report VALUES(?,?,?,?,?,?,?,?)")
      .run(
        r.id,
        r.execution_id,
        r.work_id,
        r.revision,
        r.status,
        r.text,
        r.error,
        r.created_at,
      );
  }
  get(work) {
    if (work.active_execution_id)
      return this.db
        .prepare(
          "SELECT * FROM execution WHERE id=? AND work_id=? AND revision=?",
        )
        .get(work.active_execution_id, work.id, work.revision);
    return this.db
      .prepare(
        "SELECT * FROM execution WHERE work_id=? AND revision=? ORDER BY attempt DESC LIMIT 1",
      )
      .get(work.id, work.revision);
  }
  priorBinding(e) {
    return this.db
      .prepare(
        "SELECT * FROM execution WHERE session_root=? AND attempt<? AND conversation_id IS NOT NULL ORDER BY attempt DESC LIMIT 1",
      )
      .get(e.session_root, e.attempt);
  }
  byId(id) {
    return this.db.prepare("SELECT * FROM execution WHERE id=?").get(id);
  }

  inherit(id, previous) {
    this.db
      .prepare("UPDATE execution SET session_root=?,guard_json=? WHERE id=?")
      .run(
        previous.session_root ?? previous.id,
        previous.guard_json
          ? stable({ ...JSON.parse(previous.guard_json), lastTaskId: null })
          : null,
        id,
      );
  }
  directives(workId, state) {
    return this.db
      .prepare(
        "SELECT * FROM work_directive WHERE work_id=? AND (? IS NULL OR state=?) ORDER BY seq",
      )
      .all(workId, state ?? null, state ?? null);
  }
  addDirective(d) {
    this.db
      .prepare(
        "INSERT INTO work_directive(id,work_id,revision,text,state,created_at) VALUES(?,?,?,?,'accepted',?)",
      )
      .run(d.id, d.workId, d.revision, d.text, d.at);
  }
  contextDirectives(workId, revision, executionId) {
    return this.db
      .prepare(
        "SELECT id,seq,text FROM work_directive WHERE work_id=? AND revision=? AND (state='submitted' OR (state='scheduled' AND execution_id=?)) ORDER BY seq DESC LIMIT 33",
      )
      .all(workId, revision, executionId);
  }
  scheduleDirectives(workId, revision, executionId) {
    this.db
      .prepare(
        "UPDATE work_directive SET state='scheduled',execution_id=? WHERE work_id=? AND revision=? AND state='accepted'",
      )
      .run(executionId, workId, revision);
  }
  submittedDirectives(executionId) {
    this.db
      .prepare(
        "UPDATE work_directive SET state='submitted' WHERE execution_id=? AND state='scheduled'",
      )
      .run(executionId);
  }
  retireDirectives(workId) {
    this.db
      .prepare(
        "UPDATE work_directive SET state='superseded' WHERE work_id=? AND state IN ('accepted','scheduled')",
      )
      .run(workId);
  }

  list(id) {
    return this.db
      .prepare(
        "SELECT * FROM execution WHERE work_id=? ORDER BY revision,attempt",
      )
      .all(id);
  }
  add(e) {
    this.db
      .prepare(
        "INSERT INTO execution(id,work_id,revision,input_id,status,request_json,harness,attempt,predecessor_id,session_root) VALUES(?,?,?,?,'queued',?,?,?,?,?)",
      )
      .run(
        e.id,
        e.workId,
        e.revision,
        e.inputId,
        e.request ? stable(e.request) : null,
        e.harness ?? "pi",
        e.attempt ?? 1,
        e.predecessorId ?? null,
        e.sessionRoot ?? e.id,
      );
  }
  retire(workId, state) {
    this.db
      .prepare(
        "UPDATE execution SET status=? WHERE work_id=? AND status IN ('queued','running','blocked','reported')",
      )
      .run(state, workId);
  }
  status(id, status) {
    this.db.prepare("UPDATE execution SET status=? WHERE id=?").run(status, id);
  }
  context(id, value) {
    this.db
      .prepare("UPDATE execution SET context_json=? WHERE id=?")
      .run(stable(value), id);
  }
  bind(id, conversation, submission) {
    this.db
      .prepare(
        "UPDATE execution SET conversation_id=?,submission_id=? WHERE id=?",
      )
      .run(JSON.stringify(conversation), JSON.stringify(submission), id);
  }
}
export class OutcomeRepository extends Repository {
  results(id) {
    return this.db
      .prepare("SELECT * FROM result WHERE work_id=? ORDER BY revision")
      .all(id);
  }
  deliveriesFor(id) {
    return this.db
      .prepare("SELECT * FROM delivery WHERE work_id=? ORDER BY revision")
      .all(id);
  }
  addResult(r) {
    this.db
      .prepare("INSERT OR IGNORE INTO result VALUES(?,?,?,?,?,?)")
      .run(r.id, r.executionId, r.workId, r.revision, r.text, r.at);
  }
  addDelivery(d) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO delivery(id,result_id,work_id,revision,status,message_text,suppress_notification,user_message_json) VALUES(?,?,?,?,'pending',?,?,?)",
      )
      .run(
        d.id,
        d.resultId,
        d.workId,
        d.revision,
        d.messageText ?? null,
        d.suppressNotification ? 1 : 0,
        d.userMessage ? stable(d.userMessage) : null,
      );
  }
  withdraw(id) {
    this.db
      .prepare(
        "UPDATE delivery SET status='withdrawn' WHERE work_id=? AND status='pending'",
      )
      .run(id);
  }
  pending(at) {
    return this.db
      .prepare(
        "SELECT d.*,COALESCE(d.message_text,r.text) AS text FROM delivery d JOIN result r ON r.id=d.result_id WHERE d.status='pending' AND d.next_at<=? ORDER BY r.created_at",
      )
      .all(at);
  }
  accepted(id, at) {
    this.db
      .prepare(
        "UPDATE delivery SET status='accepted',accepted_at=?,error=NULL WHERE id=? AND status='pending'",
      )
      .run(at, id);
  }
  failed(id, at, error) {
    this.db
      .prepare(
        "UPDATE delivery SET attempts=attempts+1,next_at=?,error=? WHERE id=?",
      )
      .run(at, String(error), id);
  }
}
export class MemoryRepository extends Repository {
  tombstone(id, value) {
    this.db
      .prepare("INSERT OR REPLACE INTO memory_tombstone VALUES(?,?,?,?,?)")
      .run(id, value.scope, value.projectId, value.content, value.at);
  }
  tombstoned(id) {
    return !!this.db
      .prepare("SELECT 1 FROM memory_tombstone WHERE id=?")
      .get(id);
  }
  clearTombstone(id) {
    this.db.prepare("DELETE FROM memory_tombstone WHERE id=?").run(id);
  }
  nextReview(scope) {
    return (
      this.db
        .prepare("SELECT next_at FROM memory_refresh WHERE scope=?")
        .get(scope)?.next_at ?? 0
    );
  }
  reviewed(scope, next) {
    this.db
      .prepare(
        "INSERT INTO memory_refresh VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET next_at=excluded.next_at",
      )
      .run(scope, next);
  }
  browse(view, options) {
    return readMemories(this.db, view, { ...options, scope: "agent" });
  }
  catalog(projectId = null) {
    return readMemories(this.db, projectId, { limit: 10000, deleted: true });
  }
  prompt(projectId) {
    return promptMemories(this.db, projectId);
  }
  memoryFiles(view, options) {
    return listMemoryFiles(this.db, view, options);
  }
  recall(projectId, options) {
    return recallMemories(this.db, projectId, options);
  }
  detail(key, value) {
    this.db
      .prepare(
        "INSERT INTO memory_detail VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET scope=excluded.scope,project_id=excluded.project_id,kind=excluded.kind,updated_at=excluded.updated_at",
      )
      .run(key, value.scope, value.projectId, value.kind, value.updatedAt);
  }
  get(key) {
    return this.db
      .prepare(`SELECT ${memoryColumns} FROM ${memoryJoin} WHERE m.key=?`)
      .get(key);
  }
  list(projectId = null) {
    return readMemories(this.db, projectId, { limit: 10000 });
  }
  provenance(key) {
    return this.db
      .prepare("SELECT * FROM memory_provenance WHERE key=?")
      .get(key);
  }
  recordProvenance(key, revision, origin, evidence) {
    this.db
      .prepare(
        "INSERT INTO memory_provenance VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,origin=excluded.origin,evidence_json=excluded.evidence_json",
      )
      .run(key, revision, origin, stable(evidence));
  }
  save(m) {
    this.db
      .prepare(
        "INSERT INTO memory VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,revision=excluded.revision,input_id=excluded.input_id,deleted=excluded.deleted",
      )
      .run(m.key, m.value, m.revision, m.input_id, m.deleted);
  }
}
export class RoutineRepository extends Repository {
  get(id) {
    return this.db.prepare("SELECT * FROM routine WHERE id=?").get(id);
  }
  list() {
    return this.db.prepare("SELECT * FROM routine ORDER BY id").all();
  }
  active() {
    return this.db.prepare("SELECT * FROM routine WHERE status='active'").all();
  }
  add(r) {
    this.db
      .prepare(
        "INSERT INTO routine(id,text,revision,status,interval_ms,next_at,expires_at,max_runs,created_count,notify,resources_json,schedule_json,last_scheduled_at,stop_when) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        r.id,
        r.text,
        r.revision,
        r.status,
        r.interval_ms,
        r.next_at,
        r.expires_at,
        r.max_runs,
        r.created_count,
        r.notify ?? "never",
        r.resources_json ?? null,
        r.schedule_json ?? null,
        r.last_scheduled_at ?? null,
        r.stop_when ?? null,
      );
  }
  save(r) {
    this.db
      .prepare(
        "UPDATE routine SET revision=?,status=?,next_at=?,created_count=?,text=?,interval_ms=?,expires_at=?,max_runs=?,notify=?,schedule_json=?,last_scheduled_at=?,stop_when=? WHERE id=?",
      )
      .run(
        r.revision,
        r.status,
        r.next_at,
        r.created_count,
        r.text,
        r.interval_ms,
        r.expires_at,
        r.max_runs,
        r.notify,
        r.schedule_json ?? null,
        r.last_scheduled_at ?? null,
        r.stop_when ?? null,
        r.id,
      );
  }
  occurrence(o) {
    this.db
      .prepare("INSERT INTO occurrence VALUES(?,?,?,?,?,?)")
      .run(
        o.id,
        o.routineId,
        o.revision,
        o.scheduledAt,
        o.observedAt,
        o.workId,
      );
  }
}
export class EventRepository extends Repository {
  append(kind, workId, data, at) {
    this.db
      .prepare("INSERT INTO event(at,kind,work_id,data) VALUES(?,?,?,?)")
      .run(at, kind, workId ?? null, stable(data));
  }
  list(after) {
    return this.db
      .prepare("SELECT * FROM event WHERE seq>? ORDER BY seq LIMIT 1000")
      .all(after)
      .map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }
}
export class ConversationRepository extends Repository {
  get(id) {
    return (
      this.db.prepare("SELECT * FROM conversation WHERE id=?").get(id) ?? null
    );
  }
  list(assistantId, after, limit) {
    return this.db
      .prepare(
        "SELECT * FROM conversation WHERE assistant_id=? AND id>? ORDER BY id LIMIT ?",
      )
      .all(assistantId, after, limit);
  }
  memoryEvidence(assistantId, id) {
    return (
      this.db
        .prepare(
          "SELECT m.id,m.text,m.at FROM conversation_message m JOIN conversation c ON c.id=m.conversation_id WHERE c.assistant_id=? AND m.id=? AND m.role='user'",
        )
        .get(assistantId, id) ?? null
    );
  }
  message(conversationId, id) {
    return (
      this.db
        .prepare(
          "SELECT id,role,text,at,data FROM conversation_message WHERE conversation_id=? AND id=?",
        )
        .get(conversationId, id) ?? null
    );
  }
  search(conversationId, options) {
    return searchHistory(this.db, conversationId, options);
  }
  ensure(c) {
    this.db
      .prepare("INSERT OR IGNORE INTO conversation VALUES(?,?)")
      .run(c.id, c.assistant_id);
  }
  append(m) {
    const old = this.db
      .prepare("SELECT * FROM conversation_message WHERE id=?")
      .get(m.id);
    if (old) {
      if (old.text !== m.text || old.role !== m.role)
        throw new Error("Message identity reused with different content");
      return;
    }
    this.db
      .prepare(
        "INSERT INTO conversation_message(id,conversation_id,role,text,at,data) VALUES(?,?,?,?,?,?)",
      )
      .run(m.id, m.conversation_id, m.role, m.text, m.at, stable(m.data));
  }
  messages(id, limit = 100) {
    return this.db
      .prepare(
        "SELECT * FROM conversation_message WHERE conversation_id=? ORDER BY seq DESC LIMIT ?",
      )
      .all(id, limit)
      .reverse()
      .map((m) => ({ ...m, data: JSON.parse(m.data) }));
  }
  link(conversationId, workId) {
    this.db
      .prepare("INSERT OR IGNORE INTO conversation_work VALUES(?,?)")
      .run(conversationId, workId);
  }
  linked(conversationId, workId) {
    return !!this.db
      .prepare(
        "SELECT * FROM conversation_work WHERE conversation_id=? AND work_id=?",
      )
      .get(conversationId, workId);
  }
  works(id) {
    return this.db
      .prepare(
        "SELECT w.* FROM work w JOIN conversation_work c ON c.work_id=w.id WHERE c.conversation_id=? ORDER BY w.created_at",
      )
      .all(id);
  }
  destinations(workId) {
    return this.db
      .prepare("SELECT conversation_id FROM conversation_work WHERE work_id=?")
      .all(workId)
      .map((r) => r.conversation_id);
  }
}
export class ReceptionRepository extends Repository {
  add(t) {
    this.db
      .prepare(
        "INSERT INTO reception(id,conversation_id,text,status,created_at,query_scope_json,source_json,work_id) VALUES(?,?,?,'queued',?,?,?,?)",
      )
      .run(
        t.id,
        t.conversationId,
        t.text,
        t.at,
        t.queryScope ? stable(t.queryScope) : null,
        t.source ? stable(t.source) : null,
        t.workId ?? null,
      );
  }
  get(id) {
    return this.db.prepare("SELECT * FROM reception WHERE id=?").get(id);
  }
  pending(at = Date.now()) {
    return this.db
      .prepare(
        "SELECT * FROM reception WHERE status IN ('queued','running') AND next_at<=? ORDER BY created_at,rowid",
      )
      .all(at);
  }
  retry(id, error, trace, at) {
    this.db
      .prepare(
        "UPDATE reception SET attempts=attempts+1,status=CASE WHEN attempts>=2 THEN 'blocked' ELSE 'queued' END,next_at=?,reply_text=?,decision_json=? WHERE id=? AND status!='settled'",
      )
      .run(at, String(error), stable({ queries: trace }), id);
  }

  activity(conversationId) {
    const row = this.db
      .prepare(
        "SELECT COUNT(CASE WHEN status='queued' THEN 1 END) AS queued, COUNT(CASE WHEN status='running' THEN 1 END) AS running FROM reception WHERE conversation_id=? AND source_json IS NULL AND status IN ('queued','running')",
      )
      .get(conversationId);
    return { queued: row.queued, running: row.running };
  }
  started(id) {
    this.db.prepare("UPDATE reception SET status='running' WHERE id=?").run(id);
  }
  settled(id, proposal, text, workId) {
    this.db
      .prepare(
        "UPDATE reception SET status='settled',decision_json=?,reply_text=?,work_id=? WHERE id=?",
      )
      .run(stable(proposal), text, workId ?? null, id);
  }
  blocked(id, error, trace = [], commandFailure) {
    this.db
      .prepare(
        "UPDATE reception SET status='blocked',reply_text=?,decision_json=? WHERE id=? AND status!='settled'",
      )
      .run(
        String(error),
        stable({
          queries: trace,
          ...(commandFailure ? { commandFailure } : {}),
        }),
        id,
      );
  }
}

export class InteractionRepository extends Repository {
  rejectPending(workId, revision, inputId, now) {
    this.db
      .prepare(
        "UPDATE interaction SET state='rejected',answer_input_id=?,answered_at=? WHERE work_id=? AND revision=? AND state='pending'",
      )
      .run(inputId, now, workId, revision);
  }
  get(id) {
    return this.db.prepare("SELECT * FROM interaction WHERE id=?").get(id);
  }
  list() {
    return this.db
      .prepare("SELECT * FROM interaction ORDER BY created_at,rowid")
      .all();
  }
  pendingForWork(workId, revision) {
    return this.db
      .prepare(
        "SELECT * FROM interaction WHERE work_id=? AND revision=? AND state='pending'",
      )
      .all(workId, revision);
  }
  expiring(at) {
    return this.db
      .prepare(
        "SELECT * FROM interaction WHERE state='pending' AND expires_at IS NOT NULL AND expires_at<=? ORDER BY expires_at LIMIT 64",
      )
      .all(at);
  }
  forConversation(id) {
    return this.db
      .prepare(
        "SELECT i.* FROM interaction i JOIN conversation_work c ON c.work_id=i.work_id WHERE c.conversation_id=? AND i.state='pending' ORDER BY i.created_at",
      )
      .all(id);
  }
  add(i) {
    this.db
      .prepare(
        "INSERT INTO interaction(id,work_id,revision,execution_id,call_id,question,owner,state,answer,answer_input_id,created_at,answered_at,kind,expires_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        i.id,
        i.work_id,
        i.revision,
        i.execution_id,
        i.call_id,
        i.question,
        i.owner,
        i.state,
        i.answer,
        i.answer_input_id,
        i.created_at,
        i.answered_at,
        i.kind ?? "question",
        i.expires_at ?? null,
        i.metadata_json ?? "{}",
      );
  }
  save(i) {
    this.db
      .prepare(
        "UPDATE interaction SET state=?,answer=?,answer_input_id=?,answered_at=? WHERE id=?",
      )
      .run(i.state, i.answer, i.answer_input_id, i.answered_at, i.id);
  }
  answeredQuestions(workId, revision, now, limit) {
    return this.db
      .prepare(
        "SELECT id,execution_id,revision,question,answer,answered_at,expires_at FROM interaction WHERE work_id=? AND revision=? AND state='answered' AND kind='question' AND (expires_at IS NULL OR expires_at>?) ORDER BY answered_at DESC,id LIMIT ?",
      )
      .all(workId, revision, now, limit);
  }
  retire(workId, reason, preserveAnswers = false) {
    this.db
      .prepare(
        "UPDATE interaction SET state=? WHERE work_id=? AND (state='pending' OR (state='answered' AND (?=0 OR kind!='question')))",
      )
      .run(reason, workId, preserveAnswers ? 1 : 0);
  }
}

export class CompletionRepository extends Repository {
  evidence(executionId) {
    return this.db
      .prepare(
        "SELECT * FROM completion_evidence WHERE execution_id=? ORDER BY created_at,id",
      )
      .all(executionId)
      .map((r) => ({ ...r, data: JSON.parse(r.data_json) }));
  }
  assessment(executionId) {
    const r = this.db
      .prepare("SELECT * FROM completion_assessment WHERE execution_id=?")
      .get(executionId);
    return r ? { ...r, data: JSON.parse(r.data_json) } : null;
  }
  addEvidence(e) {
    this.db
      .prepare("INSERT INTO completion_evidence VALUES(?,?,?,?,?)")
      .run(e.id, e.executionId, e.kind, stable(e.data), e.at);
  }
  addAssessment(a) {
    this.db
      .prepare("INSERT INTO completion_assessment VALUES(?,?,?,?,?)")
      .run(a.executionId, a.workId, a.revision, stable(a.data), a.at);
  }
}

export class AttentionRepository extends Repository {
  ensure(at) {
    this.db
      .prepare("INSERT OR IGNORE INTO attention VALUES(1,?,?,0,0,NULL,NULL,0)")
      .run(at, at);
  }
  get() {
    return this.db.prepare("SELECT * FROM attention WHERE id=1").get();
  }
  save(s) {
    this.db
      .prepare(
        "UPDATE attention SET last_active_at=?,last_viewed_at=?,unread_count=?,fire_count=?,nudged_at=?,paused_at=?,snoozed_until=? WHERE id=1",
      )
      .run(
        s.last_active_at,
        s.last_viewed_at,
        s.unread_count,
        s.fire_count,
        s.nudged_at,
        s.paused_at,
        s.snoozed_until,
      );
  }
}

export class TriggerRepository extends Repository {
  decode(row) {
    return row && { ...row, resources: JSON.parse(row.resources_json) };
  }
  rule(id) {
    return this.decode(
      this.db.prepare("SELECT * FROM trigger_rule WHERE id=?").get(id),
    );
  }
  rules() {
    return this.db
      .prepare("SELECT * FROM trigger_rule ORDER BY id")
      .all()
      .map((r) => this.decode(r));
  }
  addRule(r) {
    this.db
      .prepare(
        "INSERT INTO trigger_rule(id,type,path,goal,notify,resources_json) VALUES(?,?,?,?,?,?)",
      )
      .run(r.id, r.type, r.path, r.goal, r.notify, stable(r.resources));
  }
  enable(id, enabled) {
    this.db
      .prepare(
        "UPDATE trigger_rule SET enabled=?,revision=revision+1 WHERE id=?",
      )
      .run(Number(enabled), id);
  }
  addEvent(id, type, data, at) {
    this.db
      .prepare("INSERT INTO assistant_event VALUES(?,?,?,?)")
      .run(id, type, stable(data), at);
  }
  occurrence(eventId, rule, workId) {
    this.db
      .prepare("INSERT INTO trigger_occurrence VALUES(?,?,?,?)")
      .run(eventId, rule.id, rule.revision, workId);
  }
  observation(path) {
    return this.db
      .prepare("SELECT * FROM file_observation WHERE path=?")
      .get(path);
  }
  observe(path, sha, revision) {
    this.db
      .prepare(
        "INSERT INTO file_observation VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET sha256=excluded.sha256,revision=excluded.revision",
      )
      .run(path, sha, revision);
  }
}
export class NotificationRepository extends Repository {
  get(deliveryId) {
    return this.db
      .prepare("SELECT * FROM notification WHERE delivery_id=? LIMIT 1")
      .get(deliveryId);
  }
  latest(key) {
    return this.db
      .prepare(
        "SELECT * FROM notification WHERE origin_key=? AND state IN ('pending','sent') ORDER BY rowid DESC LIMIT 1",
      )
      .get(key);
  }
  add(n) {
    this.db
      .prepare(
        "INSERT INTO notification(id,delivery_id,conversation_id,origin_key,content_hash,work_id,text,state,created_at,user_message_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        n.id,
        n.deliveryId,
        n.conversationId,
        n.key,
        n.hash,
        n.workId,
        n.text,
        n.state,
        n.at,
        n.userMessageJson ?? null,
      );
  }
  pending(at) {
    return this.db
      .prepare(
        "SELECT * FROM notification WHERE state='pending' AND created_at<=? ORDER BY created_at,rowid LIMIT 64",
      )
      .all(at);
  }
  sent(id) {
    this.db.prepare("UPDATE notification SET state='sent' WHERE id=?").run(id);
  }
}

export class MemoryLearningRepository extends Repository {
  control(id) {
    return (
      this.db
        .prepare("SELECT value FROM memory_learning_control WHERE id=?")
        .get(id)?.value ?? 0
    );
  }
  setControl(id, value) {
    this.db
      .prepare(
        "INSERT INTO memory_learning_control VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(id, value);
  }
  defer(id, at) {
    this.db
      .prepare(
        "UPDATE memory_learning SET next_at=? WHERE id=? AND state='queued'",
      )
      .run(at, id);
  }
  deferForCapacity(id, at) {
    this.db
      .prepare(
        "UPDATE memory_learning SET next_at=MAX(next_at,?) WHERE id=? AND state IN ('queued','proposed')",
      )
      .run(at, id);
  }
  unbatched() {
    return this.db
      .prepare(
        "SELECT * FROM memory_learning WHERE state='queued' AND batch_ids_json IS NULL AND temporal=0 ORDER BY created_at,rowid LIMIT 65",
      )
      .all()
      .map((r) => this.decode(r));
  }
  freeze(id, evidence, snapshot, batchIds, today, temporal = 0) {
    this.db
      .prepare(
        "UPDATE memory_learning SET evidence_json=?,snapshot_json=?,batch_ids_json=?,today=?,temporal=? WHERE id=?",
      )
      .run(
        stable(evidence),
        stable(snapshot),
        stable(batchIds),
        today,
        temporal,
        id,
      );
  }
  activeTemporal(projectId) {
    return this.db
      .prepare(
        "SELECT 1 FROM memory_learning WHERE temporal=1 AND state IN ('queued','proposed') AND json_extract(snapshot_json,'$.projectId') IS ?",
      )
      .get(projectId);
  }
  decode(row) {
    return (
      row && {
        ...row,
        evidence: JSON.parse(row.evidence_json),
        snapshot: JSON.parse(row.snapshot_json),
        proposal: row.proposal_json ? JSON.parse(row.proposal_json) : null,
        batchIds: row.batch_ids_json ? JSON.parse(row.batch_ids_json) : null,
      }
    );
  }
  get(id) {
    return this.decode(
      this.db.prepare("SELECT * FROM memory_learning WHERE id=?").get(id),
    );
  }
  pending(now) {
    return this.db
      .prepare(
        "SELECT * FROM memory_learning WHERE state IN ('queued','proposed') AND next_at<=? ORDER BY created_at,rowid LIMIT 1",
      )
      .all(now)
      .map((row) => this.decode(row));
  }
  add(j) {
    this.db
      .prepare(
        "INSERT INTO memory_learning(id,state,evidence_json,snapshot_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run(j.id, j.state, stable(j.evidence), stable(j.snapshot), j.at);
  }
  proposed(id, proposal) {
    this.db
      .prepare(
        "UPDATE memory_learning SET state='proposed',proposal_json=? WHERE id=? AND state='queued'",
      )
      .run(stable(proposal), id);
  }
  finished(id, state) {
    this.db
      .prepare("UPDATE memory_learning SET state=?,error=NULL WHERE id=?")
      .run(state, id);
  }
  rebase(id, snapshot) {
    this.db
      .prepare(
        "UPDATE memory_learning SET snapshot_json=?,proposal_json=NULL,state='queued',attempts=attempts+1,next_at=0 WHERE id=?",
      )
      .run(stable(snapshot), id);
  }
  failed(id, error, nextAt) {
    this.db
      .prepare(
        "UPDATE memory_learning SET attempts=attempts+1,state=CASE WHEN attempts>=2 THEN 'failed' ELSE state END,error=?,next_at=? WHERE id=?",
      )
      .run(error, nextAt, id);
  }
}

export class SkillRepository extends Repository {
  count() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM skill").get().n;
  }
  countNew(ids) {
    return ids.filter((id) => !this.get(id)).length;
  }
  get(id) {
    return this.db.prepare("SELECT * FROM skill WHERE id=?").get(id);
  }
  catalog() {
    return this.db.prepare("SELECT * FROM skill ORDER BY id").all();
  }
  version(id, version) {
    return this.db
      .prepare("SELECT * FROM skill_version WHERE skill_id=? AND version=?")
      .get(id, version);
  }
  install(s, at) {
    this.db
      .prepare("INSERT OR IGNORE INTO skill_version VALUES(?,?,?,?,?)")
      .run(s.id, s.version, s.summary, s.body, at);
    this.db
      .prepare(
        "INSERT INTO skill(id,plugin_id,version,summary) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,summary=excluded.summary",
      )
      .run(s.id, s.pluginId, s.version, s.summary);
  }
  enable(id, enabled) {
    this.db
      .prepare("UPDATE skill SET enabled=? WHERE id=?")
      .run(Number(enabled), id);
  }
  loaded(executionId, id, version, at) {
    const old = this.db
      .prepare(
        "SELECT version FROM skill_load WHERE execution_id=? AND skill_id=?",
      )
      .get(executionId, id);
    if (old && old.version !== version) throw new Error("Pinned skill changed");
    this.db
      .prepare("INSERT OR IGNORE INTO skill_load VALUES(?,?,?,?)")
      .run(executionId, id, version, at);
  }
  loads(workId) {
    return this.db
      .prepare(
        "SELECT s.* FROM skill_load s JOIN execution e ON e.id=s.execution_id WHERE e.work_id=? ORDER BY s.loaded_at,s.skill_id",
      )
      .all(workId);
  }
}

export class UsageRepository extends Repository {
  get(id) {
    return this.db
      .prepare("SELECT * FROM usage_observation WHERE id=?")
      .get(id);
  }
  save(value) {
    this.db
      .prepare(
        "INSERT INTO usage_observation VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at",
      )
      .run(
        value.id,
        value.kind,
        value.workId,
        value.mode,
        stable(value.data),
        value.at,
      );
  }
  list(workId, after, limit) {
    return this.db
      .prepare(
        "SELECT * FROM usage_observation WHERE (? IS NULL OR work_id=?) AND (? IS NULL OR id>?) ORDER BY id LIMIT ?",
      )
      .all(workId ?? null, workId ?? null, after ?? null, after ?? null, limit)
      .map(({ data_json, ...r }) => ({ ...r, ...JSON.parse(data_json) }));
  }
  totals(workId) {
    const fields = [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "totalTokens",
      "estimatedCostUsd",
    ];
    const columns = fields
      .flatMap((key) => [
        `SUM(json_extract(data_json,'$.usage.${key}')) AS ${key}`,
        `SUM(CASE WHEN json_extract(data_json,'$.usage.${key}') IS NULL THEN 1 ELSE 0 END) AS ${key}_unknown`,
      ])
      .join(",");
    return this.db
      .prepare(
        `SELECT mode,COUNT(*) AS observations,${columns} FROM usage_observation WHERE (? IS NULL OR work_id=?) GROUP BY mode ORDER BY mode`,
      )
      .all(workId ?? null, workId ?? null)
      .map((row) => ({
        mode: row.mode,
        observations: row.observations,
        knownTotals: Object.fromEntries(fields.map((k) => [k, row[k]])),
        unknownObservations: Object.fromEntries(
          fields.map((k) => [k, row[k + "_unknown"]]),
        ),
      }));
  }
}

export function sqliteRepositories(uow) {
  return {
    messages: new SqliteUserMessages(uow),
    usage: new UsageRepository(uow),
    attention: new AttentionRepository(uow),
    triggers: new TriggerRepository(uow),
    notifications: new NotificationRepository(uow),
    memoryLearning: new MemoryLearningRepository(uow),
    skills: new SkillRepository(uow),
    meta: new MetaRepository(uow),
    inputs: new InputRepository(uow),
    works: new WorkRepository(uow),
    executions: new ExecutionRepository(uow),
    goals: new GoalRepository(uow),
    outcomes: new OutcomeRepository(uow),
    memories: new MemoryRepository(uow),
    routines: new RoutineRepository(uow),
    events: new EventRepository(uow),
    conversations: new ConversationRepository(uow),
    conversationContext: new SqliteConversationContext(uow),
    reception: new ReceptionRepository(uow),
    interactions: new InteractionRepository(uow),
    completion: new CompletionRepository(uow),
  };
}
