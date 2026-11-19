import {
  readMemories,
  recallMemories,
  promptMemories,
  listMemoryFiles,
  memoryColumns,
  memoryJoin,
  memoryVisible,
  memoryVisibility,
} from "./memory-read.mjs";
import { searchHistory } from "./history-read.mjs";
const workColumns = `w.id,w.text,w.revision,w.status,w.error,w.updated_at,
  (SELECT goal_id FROM goal_work WHERE work_id=w.id) AS goal_id,
  e.id AS execution_id,e.harness,e.status AS execution_status,
  (e.conversation_id IS NOT NULL) AS session_bound,
  d.status AS delivery_status,d.accepted_at AS delivery_accepted_at`;
const workJoin = `work w JOIN conversation_work c ON c.work_id=w.id
  LEFT JOIN execution e ON e.id=w.active_execution_id
  LEFT JOIN delivery d ON d.result_id='result:' || e.id`;
/** SELECT-only read port. Private driver, no command/repository access in the public surface. */
export class SqliteReceptionReadModel {
  #db;
  constructor(uow) {
    this.#db = uow.db;
  }
  history(conversationId, messageId, limit, requireUser = true) {
    const anchor = this.#db
      .prepare(
        "SELECT seq,text FROM conversation_message WHERE id=? AND conversation_id=? AND (?=0 OR role='user')",
      )
      .get(messageId, conversationId, requireUser ? 1 : 0);
    if (!anchor) return null;
    const messages = this.#db
      .prepare(
        "SELECT id,seq,role,text FROM conversation_message WHERE conversation_id=? AND seq<=? ORDER BY seq DESC LIMIT ?",
      )
      .all(conversationId, anchor.seq, limit)
      .reverse();
    return { text: anchor.text, messages };
  }
  historyMessage(conversationId, messageId, anchorId, offset, limit) {
    const row = this.#db
      .prepare(
        `SELECT m.id,m.role,m.text FROM conversation_message m
      JOIN conversation_message a ON a.conversation_id=m.conversation_id
      WHERE m.conversation_id=? AND m.id=? AND a.id=? AND m.seq<=a.seq`,
      )
      .get(conversationId, messageId, anchorId);
    if (!row) return null;
    return {
      id: row.id,
      role: row.role,
      text: row.text.slice(offset, offset + limit),
      offset,
      nextOffset: offset + limit < row.text.length ? offset + limit : null,
    };
  }
  report(conversationId, workId) {
    return (
      this.#db
        .prepare(
          "SELECT r.* FROM execution_report r JOIN work w ON w.active_execution_id=r.execution_id JOIN conversation_work c ON c.work_id=w.id WHERE c.conversation_id=? AND w.id=?",
        )
        .get(conversationId, workId) ?? null
    );
  }
  goals(conversationId, after, limit) {
    return this.#db
      .prepare(
        "SELECT g.id,substr(g.objective,1,200) AS objective,(length(g.objective)>200) AS objectiveTruncated,g.revision,g.state,g.priority,g.max_parallel FROM goal g WHERE (? IS NULL OR g.id>?) AND EXISTS(SELECT 1 FROM goal_work gw JOIN conversation_work cw ON cw.work_id=gw.work_id WHERE gw.goal_id=g.id AND cw.conversation_id=?) ORDER BY g.id LIMIT ?",
      )
      .all(after ?? null, after ?? null, conversationId, limit);
  }
  goal(conversationId, id, { after, limit = 4 } = {}) {
    const g = this.#db
      .prepare(
        "SELECT g.* FROM goal g WHERE g.id=? AND EXISTS(SELECT 1 FROM goal_work gw JOIN conversation_work cw ON cw.work_id=gw.work_id WHERE gw.goal_id=g.id AND cw.conversation_id=?)",
      )
      .get(id, conversationId);
    if (!g) return null;
    const works = this.#db
      .prepare(
        "SELECT w.id,substr(w.text,1,400) AS text,(length(w.text)>400) AS textTruncated,w.revision,w.status,gw.task_key FROM work w JOIN goal_work gw ON gw.work_id=w.id WHERE gw.goal_id=? AND (? IS NULL OR w.id>?) ORDER BY w.id LIMIT ?",
      )
      .all(id, after ?? null, after ?? null, limit + 1);
    const value = {
      id: g.id,
      objective: g.objective,
      revision: g.revision,
      state: g.state,
      priority: g.priority,
      maxParallel: g.max_parallel,
      criteria: JSON.parse(g.criteria_json),
      works: works.map((w) => ({
        ...w,
        resultId:
          this.#db
            .prepare(
              "SELECT id FROM result WHERE execution_id=(SELECT active_execution_id FROM work WHERE id=?)",
            )
            .get(w.id)?.id ?? null,
        dependsOn: this.#db
          .prepare(
            "SELECT upstream_id,revision FROM work_dependency WHERE work_id=?",
          )
          .all(w.id),
      })),
      semanticReview: g.confirmation_json
        ? JSON.parse(g.confirmation_json).kind
        : "unverified",
    };
    let more = value.works.length > limit;
    value.works = value.works.slice(0, limit);
    while (
      value.works.length > 1 &&
      new TextEncoder().encode(JSON.stringify(value)).byteLength > 10500
    ) {
      value.works.pop();
      more = true;
    }
    return { ...value, next: more ? value.works.at(-1).id : null };
  }
  routines(limit) {
    return this.#db
      .prepare(
        "SELECT id,text,revision,status,interval_ms,next_at,notify,schedule_json,expires_at,max_runs,stop_when FROM routine ORDER BY id LIMIT ?",
      )
      .all(limit);
  }
  overview(conversationId) {
    return this.#db
      .prepare(
        `SELECT w.status,COUNT(*) AS count FROM work w
      JOIN conversation_work c ON c.work_id=w.id WHERE c.conversation_id=? GROUP BY w.status`,
      )
      .all(conversationId);
  }
  works(conversationId, after, limit, { state = "all", query = "" } = {}) {
    return this.#db
      .prepare(
        `SELECT ${workColumns} FROM ${workJoin}
         WHERE c.conversation_id=? AND (? IS NULL OR w.id>?)
         AND (?='all' OR (?='open' AND w.status NOT IN ('completed','cancelled')) OR (?='closed' AND w.status IN ('completed','cancelled')))
         AND (?='' OR instr(lower(w.text),lower(?))>0 OR w.id=?)
         ORDER BY w.id LIMIT ?`,
      )
      .all(
        conversationId,
        after ?? null,
        after ?? null,
        state,
        state,
        state,
        query,
        query,
        query,
        limit,
      );
  }
  attentionWorks(conversationId, limit) {
    return this.#db
      .prepare(
        `SELECT ${workColumns} FROM ${workJoin}
      WHERE c.conversation_id=? AND w.status NOT IN ('completed','cancelled')
      ORDER BY CASE w.status WHEN 'waiting_input' THEN 0 WHEN 'blocked' THEN 1
      WHEN 'awaiting_review' THEN 2 WHEN 'awaiting_delivery' THEN 3 WHEN 'running' THEN 4 ELSE 5 END,
      w.updated_at DESC,w.id LIMIT ?`,
      )
      .all(conversationId, limit);
  }
  work(conversationId, id) {
    const work = this.#db
      .prepare(
        `SELECT ${workColumns},w.completion_json FROM ${workJoin} WHERE c.conversation_id=? AND w.id=?`,
      )
      .get(conversationId, id);
    if (!work) return null;
    const assessment = this.#db
      .prepare(
        "SELECT data_json FROM completion_assessment WHERE execution_id=?",
      )
      .get(work.execution_id);
    const delivery = this.#db
      .prepare(
        "SELECT status,attempts,error,accepted_at FROM delivery WHERE result_id='result:' || ?",
      )
      .get(work.execution_id);
    return {
      work,
      assessment: assessment ? JSON.parse(assessment.data_json) : null,
      delivery: delivery ?? null,
    };
  }
  questions(conversationId, after, limit, workId = null) {
    return this.#db
      .prepare(
        `SELECT i.id,i.work_id,i.revision,i.question,i.kind,i.expires_at,i.metadata_json FROM interaction i JOIN conversation_work c ON c.work_id=i.work_id JOIN work w ON w.id=i.work_id AND w.revision=i.revision WHERE c.conversation_id=? AND i.state='pending' AND w.status='waiting_input' AND (? IS NULL OR i.work_id=?) AND (? IS NULL OR i.id>?) ORDER BY i.id LIMIT ?`,
      )
      .all(conversationId, workId, workId, after ?? null, after ?? null, limit);
  }
  memories(limit, projectId = null) {
    return readMemories(this.#db, projectId, { limit, deleted: true });
  }
  prompt(projectId) {
    return promptMemories(this.#db, projectId);
  }
  memoryFiles(view, options) {
    return listMemoryFiles(this.#db, view, options);
  }
  recall(projectId, options) {
    return recallMemories(this.#db, projectId, options);
  }
  searchHistory(conversationId, options) {
    return searchHistory(this.#db, conversationId, options);
  }
  memory(key, projectId = null) {
    const get = (address) =>
      this.#db
        .prepare(
          `SELECT ${memoryColumns} FROM ${memoryJoin} WHERE m.key=? AND ${memoryVisible}`,
        )
        .get(address, memoryVisibility(projectId));
    const row =
      get(key) ?? (!key.startsWith("@") ? get(`@agent/${key}`) : null);
    return row ? { ...row, value: row.deleted ? null : row.value } : null;
  }
}
