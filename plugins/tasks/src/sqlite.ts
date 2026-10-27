import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { tasksV1Migration, tasksV1Schema } from "./v1-schema";
import { tasksArchiveMigration, tasksArchiveSchema } from "./archive-schema";
import { openManagedDatabase, createSchemaValidator, type DatabaseOutcome } from "@opencraft/sqlite-node";
import type {
  TaskDetail,
  TasksSnapshot,
  TasksMethodMap,
  TaskEvent, TaskEventActor, TaskEventType, TaskEventsPage, TaskProgressSummary,
} from "@opencraft/appserver-protocol";

export interface TaskEventContext { readonly actor: TaskEventActor | null; readonly channel: "api" | "agent" | "system" }
const systemContext: TaskEventContext = { actor: null, channel: "system" };
export const TASK_RECYCLE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class TasksFault extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
const schema = `
CREATE TABLE tasks (
 id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK(length(trim(title))>0), description TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('backlog','todo','in_progress','in_review','done','canceled')),
 project_server_id TEXT, project_id TEXT, sort_order INTEGER NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
 CHECK((project_server_id IS NULL AND project_id IS NULL) OR (project_server_id IS NOT NULL AND project_id IS NOT NULL))
) STRICT;
CREATE TABLE task_conversations (
 task_id TEXT NOT NULL REFERENCES tasks(id), server_id TEXT NOT NULL, thread_id TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(task_id,server_id,thread_id)
) STRICT;
CREATE INDEX tasks_by_status ON tasks(status,sort_order,id) WHERE deleted_at IS NULL;
CREATE INDEX conversations_by_thread ON task_conversations(server_id,thread_id,task_id);
`;
const propertiesSchema = `
CREATE TABLE task_members (id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(trim(name))>0), revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
ALTER TABLE tasks ADD COLUMN assignee_id TEXT REFERENCES task_members(id);
ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'none' CHECK(priority IN ('none','low','normal','high','urgent'));
ALTER TABLE tasks ADD COLUMN due_date TEXT;
CREATE INDEX tasks_by_assignee ON tasks(assignee_id,status,sort_order) WHERE deleted_at IS NULL;
`;
const memberIdentitySchema = `
ALTER TABLE task_members ADD COLUMN identity_kind TEXT;
ALTER TABLE task_members ADD COLUMN identity_id TEXT CHECK(
 (identity_kind IS NULL AND identity_id IS NULL) OR
 (identity_kind IS NOT NULL AND identity_id IS NOT NULL AND length(trim(identity_kind)) BETWEEN 1 AND 64 AND length(trim(identity_id)) BETWEEN 1 AND 256)
);
`;
export const tasksMigrations = [{ version: 1, name: "tasks-rows", sql: schema }, { version: 2, name: "task-properties-and-members", sql: propertiesSchema }, { version: 3, name: "member-profile-identity", sql: memberIdentitySchema }];
const select = `SELECT id,title,description,status,project_server_id AS projectServerId,project_id AS projectId,
 kind,acceptance_criteria AS acceptanceCriteria,assignee_id AS assigneeId,priority,due_date AS dueDate,sort_order AS sortOrder,revision,created_at AS createdAt,updated_at AS updatedAt,deleted_at AS deletedAt,archived_at AS archivedAt FROM tasks`;
type Params<M extends keyof TasksMethodMap> = TasksMethodMap[M]["params"];

export class TasksSqliteStore {
  private readonly db: DatabaseSync;
  readonly outcome: DatabaseOutcome;
  constructor(path: string, private readonly now: () => number = Date.now) {
    const managed = openManagedDatabase({ path, legacyPolicy: "reject", validateSchema: createSchemaValidator(schema + propertiesSchema + memberIdentitySchema + tasksV1Schema + tasksArchiveSchema), migrations: [...tasksMigrations, tasksV1Migration, tasksArchiveMigration] });
    this.db = managed.database;
    this.outcome = managed.outcome;
    this.db.exec("PRAGMA foreign_keys=ON");
  }
  close(): void {
    this.db.close();
  }
  list(): TasksSnapshot {
    return this.transaction(() => this.snapshot());
  }
  read(id: string): TaskDetail {
    return this.transaction(() => this.task(id, undefined, true));
  }
  forConversation(serverId: string, threadId: string): TasksSnapshot {
    return this.transaction(() => ({
      tasks: this.details(this.db
        .prepare(
          `${select} WHERE deleted_at IS NULL AND archived_at IS NULL AND id IN
      (SELECT task_id FROM task_conversations WHERE server_id=? AND thread_id=?) ORDER BY sort_order,id`,
        )
        .all(serverId, threadId)),
    }));
  }
  create(input: Params<"opencraft/tasks/create">, context: TaskEventContext = systemContext): TasksSnapshot {
    return this.transaction(() => {
      const existing = this.db.prepare(`${select} WHERE id=?`).get(input.id);
      if (existing) {
        if (
          existing.deletedAt !== null || existing.archivedAt !== null ||
          (input.aiResearch !== undefined && this.research(input.id).aiResearch !== input.aiResearch) ||
          (input.aiResearchReason !== undefined && this.research(input.id).aiResearchReason !== input.aiResearchReason) ||
          existing.title !== input.title ||
          existing.description !== input.description ||
          existing.status !== input.status ||
          existing.projectServerId !== input.projectServerId ||
          existing.projectId !== input.projectId ||
          (input.assigneeId !== undefined && existing.assigneeId !== input.assigneeId) ||
          (input.priority !== undefined && existing.priority !== input.priority) ||
          (input.dueDate !== undefined && existing.dueDate !== input.dueDate) ||
          (input.kind !== undefined && existing.kind !== input.kind) ||
          (input.acceptanceCriteria !== undefined && existing.acceptanceCriteria !== input.acceptanceCriteria)
        )
          throw new TasksFault(-32051, "Task ID already exists");
        return this.snapshot();
      }
      if (
        Number(
          this.db
            .prepare(
              "SELECT count(*) AS count FROM tasks WHERE deleted_at IS NULL AND archived_at IS NULL",
            )
            .get()?.count,
        ) >= 1000
      )
        throw new TasksFault(-32054, "Task workspace is full");
      const research = this.researchInput(input);
      this.checkAssignee(input.assigneeId ?? null);
      const now = this.now();
      this.db
        .prepare(
          "INSERT INTO tasks(id,title,description,status,project_server_id,project_id,sort_order,revision,created_at,updated_at,deleted_at,assignee_id,priority,due_date,kind,acceptance_criteria) VALUES(?,?,?,?,?,?,?,1,?,?,NULL,?,?,?,?,?)",
        )
        .run(
          input.id,
          input.title,
          input.description,
          input.status,
          input.projectServerId,
          input.projectId,
          this.nextOrder(input.status),
          now,
          now,
          input.assigneeId ?? null, input.priority ?? "none", input.dueDate ?? null, input.kind ?? "unclassified", input.acceptanceCriteria ?? "",
        );
      this.appendEvent(input.id, "created", { title: input.title, status: input.status, ...research }, context);
      return this.snapshot();
    });
  }
  update(input: Params<"opencraft/tasks/update">, context: TaskEventContext = systemContext): TasksSnapshot {
    return this.transaction(() => {
      const current = this.task(input.id, input.expectedRevision);
      const research = this.researchInput(input, current);
      const assigneeId = input.assigneeId === undefined ? current.assigneeId ?? null : input.assigneeId;
      this.checkAssignee(assigneeId);
      this.db
        .prepare(
          "UPDATE tasks SET title=?,description=?,project_server_id=?,project_id=?,assignee_id=?,priority=?,due_date=?,kind=?,acceptance_criteria=?,revision=revision+1,updated_at=? WHERE id=?",
        )
        .run(
          input.title,
          input.description,
          input.projectServerId,
          input.projectId,
          assigneeId, input.priority ?? current.priority ?? "none", input.dueDate === undefined ? current.dueDate ?? null : input.dueDate,
          input.kind ?? current.kind ?? "unclassified", input.acceptanceCriteria ?? current.acceptanceCriteria ?? "",
          this.now(),
          input.id,
        );
      const fields = ["title", "description", "projectServerId", "projectId", "assigneeId", "priority", "dueDate", "kind", "acceptanceCriteria", "aiResearch", "aiResearchReason"] as const;
      const changed = fields.filter(field => input[field] !== undefined && input[field] !== current[field]);
      if (changed.length) this.appendEvent(input.id, "updated", { fields: changed, ...research }, context);
      return this.snapshot();
    });
  }
  move(input: Params<"opencraft/tasks/move">, context: TaskEventContext = systemContext): TasksSnapshot {
    return this.transaction(() => {
      const task = this.task(input.id, input.expectedRevision);
      if (input.beforeId === input.id) {
        if (task.status !== input.status)
          throw new TasksFault(-32602, "Invalid move target");
        return this.snapshot();
      }
      const ids = this.db
        .prepare(
          "SELECT id FROM tasks WHERE status=? AND deleted_at IS NULL AND archived_at IS NULL AND id<>? ORDER BY sort_order,id",
        )
        .all(input.status, input.id)
        .map((row) => String(row.id));
      const index =
        input.beforeId === null ? ids.length : ids.indexOf(input.beforeId);
      if (index < 0) throw new TasksFault(-32051, "Move target changed");
      ids.splice(index, 0, input.id);
      const now = this.now();
      ids.forEach((id, order) => {
        this.db
          .prepare(
            "UPDATE tasks SET status=?,sort_order=?,revision=revision+1,updated_at=? WHERE id=? AND (status<>? OR sort_order<>?)",
          )
          .run(input.status, order, now, id, input.status, order);
      });
      if (task.status !== input.status) this.appendEvent(input.id, "status_changed", { from: task.status, to: input.status }, context);
      return this.snapshot();
    });
  }
  remove(input: Params<"opencraft/tasks/remove">, context: TaskEventContext = systemContext): TasksSnapshot {
    return this.transaction(() => {
      this.task(input.id, input.expectedRevision);
      this.db
        .prepare(
          "UPDATE tasks SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?",
        )
        .run(this.now(), this.now(), input.id);
      this.appendEvent(input.id, "deleted", {}, context);
      return this.snapshot();
    });
  }
  restore(input: Params<"opencraft/tasks/restore">, context: TaskEventContext = systemContext): TasksSnapshot {
    return this.transaction(() => {
      const row = this.db.prepare(`${select} WHERE id=?`).get(input.id);
      const now = this.now();
      if (!row || row.deletedAt === null || Number(row.deletedAt) <= now - TASK_RECYCLE_RETENTION_MS)
        throw new TasksFault(-32052, "Task is no longer recoverable");
      if (row.revision !== input.expectedRevision)
        throw new TasksFault(-32051, "Task changed; refresh before retrying");
      if (Number(this.db.prepare("SELECT count(*) AS count FROM tasks WHERE deleted_at IS NULL AND archived_at IS NULL").get()?.count) >= 1000)
        throw new TasksFault(-32054, "Task workspace is full");
      this.db.prepare("UPDATE tasks SET deleted_at=NULL,sort_order=?,revision=revision+1,updated_at=? WHERE id=?")
        .run(this.nextOrder(String(row.status)), now, input.id);
      this.appendEvent(input.id, "restored", {}, context);
      return this.snapshot();
    });
  }
  archive(input: Params<"opencraft/tasks/archive">, archived: boolean, context: TaskEventContext = systemContext): TasksSnapshot {
    return this.transaction(() => {
      const current = this.task(input.id, input.expectedRevision, true);
      if ((current.archivedAt !== null) === archived) return this.snapshot();
      if (!archived && Number(this.db.prepare("SELECT count(*) AS count FROM tasks WHERE deleted_at IS NULL AND archived_at IS NULL").get()?.count) >= 1000)
        throw new TasksFault(-32054, "Task workspace is full");
      const now = this.now();
      this.db.prepare("UPDATE tasks SET archived_at=?,sort_order=?,revision=revision+1,updated_at=? WHERE id=?")
        .run(archived ? now : null, archived ? current.sortOrder : this.nextOrder(current.status), now, input.id);
      this.appendEvent(input.id, "updated", { fields: ["archivedAt"], archived }, context);
      return this.snapshot();
    });
  }
  archives(input: Params<"opencraft/tasks/archive/list">): import("@opencraft/appserver-protocol").TaskArchivePage {
    return this.transaction(() => {
      const search = input.search ?? "", limit = input.limit ?? 50;
      const cursor = input.before;
      const rows = this.db.prepare(`${select} WHERE deleted_at IS NULL AND archived_at IS NOT NULL
        AND (?='' OR instr(lower(title),lower(?))>0 OR instr(lower(description),lower(?))>0 OR instr(lower(acceptance_criteria),lower(?))>0 OR instr(lower(id),lower(?))>0)
        ${cursor ? "AND (archived_at < ? OR (archived_at = ? AND id < ?))" : ""}
        ORDER BY archived_at DESC,id DESC LIMIT ?`)
        .all(search, search, search, search, search, ...(cursor ? [cursor.archivedAt, cursor.archivedAt, cursor.id] : []), limit + 1);
      const last = rows[limit - 1];
      return { tasks: this.details(rows.slice(0, limit)), nextCursor: rows.length > limit ? { archivedAt: Number(last!.archivedAt), id: String(last!.id) } : null };
    });
  }
  attach(input: Params<"opencraft/tasks/conversations/attach">, context: TaskEventContext = systemContext): TasksSnapshot {
    return this.link(input, true, context);
  }
  detach(input: Params<"opencraft/tasks/conversations/detach">, context: TaskEventContext = systemContext): TasksSnapshot {
    return this.link(input, false, context);
  }
  private link(
    input: Params<"opencraft/tasks/conversations/attach">,
    attach: boolean,
    context: TaskEventContext,
  ): TasksSnapshot {
    return this.transaction(() => {
      this.task(input.id);
      const exists = !!this.db
        .prepare(
          "SELECT 1 FROM task_conversations WHERE task_id=? AND server_id=? AND thread_id=?",
        )
        .get(input.id, input.serverId, input.threadId);
      if (exists === attach) return this.snapshot();
      this.task(input.id, input.expectedRevision);
      if (attach) {
        if (
          Number(
            this.db
              .prepare(
                "SELECT count(*) AS count FROM task_conversations WHERE task_id=?",
              )
              .get(input.id)?.count,
          ) >= 64
        )
          throw new TasksFault(-32054, "Too many task conversations");
        this.db
          .prepare("INSERT INTO task_conversations VALUES(?,?,?,?)")
          .run(input.id, input.serverId, input.threadId, this.now());
      } else
        this.db
          .prepare(
            "DELETE FROM task_conversations WHERE task_id=? AND server_id=? AND thread_id=?",
          )
          .run(input.id, input.serverId, input.threadId);
      this.db
        .prepare("UPDATE tasks SET revision=revision+1,updated_at=? WHERE id=?")
        .run(this.now(), input.id);
      this.appendEvent(input.id, attach ? "linked" : "unlinked", { serverId: input.serverId, threadId: input.threadId }, context);
      return this.snapshot();
    });
  }
  private checkAssignee(id: string | null): void {
    if (id !== null && !this.db.prepare("SELECT 1 FROM task_members WHERE id=?").get(id)) throw new TasksFault(-32602, "Unknown team member");
  }
  properties(input: Params<"opencraft/tasks/properties/update">, context: TaskEventContext = systemContext): TasksSnapshot {
    return this.transaction(() => {
      const current = this.task(input.id, input.expectedRevision);
      const research = this.researchInput(input, current);
      const assigneeId = input.assigneeId === undefined ? current.assigneeId ?? null : input.assigneeId;
      const priority = input.priority ?? current.priority ?? "none";
      const dueDate = input.dueDate === undefined ? current.dueDate ?? null : input.dueDate;
      this.checkAssignee(assigneeId);
      this.db.prepare("UPDATE tasks SET assignee_id=?,priority=?,due_date=?,revision=revision+1,updated_at=? WHERE id=? AND (assignee_id IS NOT ? OR priority<>? OR due_date IS NOT ? OR ?)")
        .run(assigneeId, priority, dueDate, this.now(), input.id, assigneeId, priority, dueDate, Number(!!research));
      const fields = (["assigneeId", "priority", "dueDate", "aiResearch", "aiResearchReason"] as const).filter(field => input[field] !== undefined && input[field] !== current[field]);
      if (fields.length) this.appendEvent(input.id, "updated", { fields, ...research }, context);
      return this.snapshot();
    });
  }
  member(input: Params<"opencraft/tasks/members/upsert">): TasksSnapshot {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT revision,identity_kind,identity_id FROM task_members WHERE id=?").get(input.id);
      if ((existing?.revision ?? null) !== input.expectedRevision) throw new TasksFault(-32051, "Team member changed; refresh before retrying");
      if (!existing && Number(this.db.prepare("SELECT count(*) AS n FROM task_members").get()?.n) >= 500)
        throw new TasksFault(-32054, "Team directory is full");
      const kind = input.identity === undefined ? existing?.identity_kind ?? null : input.identity?.kind ?? null;
      const identityId = input.identity === undefined ? existing?.identity_id ?? null : input.identity?.id ?? null;
      this.db.prepare("INSERT INTO task_members(id,name,revision,identity_kind,identity_id) VALUES(?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,identity_kind=excluded.identity_kind,identity_id=excluded.identity_id,revision=task_members.revision+1")
        .run(input.id, input.name, kind, identityId);
      return this.snapshot();
    });
  }
  private nextOrder(status: string): number {
    return Number(
      this.db
        .prepare(
          "SELECT coalesce(max(sort_order),-1)+1 AS value FROM tasks WHERE status=? AND deleted_at IS NULL AND archived_at IS NULL",
        )
        .get(status)?.value,
    );
  }
  private researchInput(input: { aiResearch?: string; aiResearchReason?: string }, current?: TaskDetail): { aiResearch: string; aiResearchReason: string } | undefined {
    if (input.aiResearch === undefined && input.aiResearchReason === undefined) return undefined;
    const aiResearch = input.aiResearch ?? current?.aiResearch ?? "unassessed";
    const aiResearchReason = input.aiResearchReason ?? current?.aiResearchReason ?? "";
    if (aiResearch !== "unassessed" && !aiResearchReason.trim()) throw new TasksFault(-32602, "A research assessment requires a reason");
    if (current && aiResearch === current.aiResearch && aiResearchReason === current.aiResearchReason) return undefined;
    return { aiResearch, aiResearchReason };
  }
  private research(id: string): { aiResearch: string; aiResearchReason: string } {
    const row = this.db.prepare("SELECT payload FROM task_events WHERE task_id=? AND type IN ('created','updated') AND json_type(payload,'$.aiResearch')='text' ORDER BY seq DESC LIMIT 1").get(id);
    const payload = row ? JSON.parse(String(row.payload)) : null;
    return { aiResearch: payload?.aiResearch ?? "unassessed", aiResearchReason: payload?.aiResearchReason ?? "" };
  }
  private detail(row: Record<string, unknown>): TaskDetail {
    const conversations = this.db
      .prepare(
        "SELECT server_id AS serverId,thread_id AS threadId,created_at AS createdAt FROM task_conversations WHERE task_id=? ORDER BY created_at,server_id,thread_id",
      )
      .all(String(row.id)).map(row => ({ ...row }));
    const progress = this.db.prepare("SELECT event_id, payload, created_at FROM task_events WHERE task_id=? AND type='progress' ORDER BY seq DESC LIMIT 1").get(String(row.id));
    return { ...row, ...this.research(String(row.id)), conversations, latestProgress: progress ? { eventId: String(progress.event_id), text: String(JSON.parse(String(progress.payload)).text), createdAt: Number(progress.created_at) } : null } as unknown as TaskDetail;
  }
  private task(id: string, revision?: number, includeArchived = false): TaskDetail {
    const row = this.db
      .prepare(`${select} WHERE id=? AND deleted_at IS NULL${includeArchived ? "" : " AND archived_at IS NULL"}`)
      .get(id);
    if (!row) throw new TasksFault(-32052, "Task missing");
    if (revision !== undefined && row.revision !== revision)
      throw new TasksFault(-32051, "Task changed; refresh before retrying");
    return this.detail(row);
  }
  /** Batch relations and progress: snapshot query count is constant in task count. */
  private details(rows: Record<string, unknown>[]): TaskDetail[] {
    const ids = JSON.stringify(rows.map(row => String(row.id)));
    const links = new Map<string, Array<{ serverId: string; threadId: string; createdAt: number }>>();
    for (const row of this.db.prepare("SELECT task_id,server_id,thread_id,created_at FROM task_conversations WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY created_at,server_id,thread_id").all(ids)) {
      const id = String(row.task_id), values = links.get(id) ?? [];
      values.push({ serverId: String(row.server_id), threadId: String(row.thread_id), createdAt: Number(row.created_at) }); links.set(id, values);
    }
    const progress = new Map<string, TaskProgressSummary>();
    for (const row of this.db.prepare("SELECT task_id,event_id,payload,created_at FROM task_events WHERE seq IN (SELECT max(seq) FROM task_events WHERE type='progress' AND task_id IN (SELECT value FROM json_each(?)) GROUP BY task_id)").all(ids))
      progress.set(String(row.task_id), { eventId: String(row.event_id), text: String(JSON.parse(String(row.payload)).text), createdAt: Number(row.created_at) });
    const assessments = new Map<string, { aiResearch: string; aiResearchReason: string }>();
    for (const event of this.db.prepare("SELECT task_id,payload FROM task_events WHERE seq IN (SELECT max(seq) FROM task_events WHERE type IN ('created','updated') AND json_type(payload,'$.aiResearch')='text' AND task_id IN (SELECT value FROM json_each(?)) GROUP BY task_id)").all(ids)) {
      const payload = JSON.parse(String(event.payload));
      assessments.set(String(event.task_id), { aiResearch: payload.aiResearch, aiResearchReason: payload.aiResearchReason ?? "" });
    }
    return rows.map(row => ({ ...row, ...(assessments.get(String(row.id)) ?? { aiResearch: "unassessed", aiResearchReason: "" }), conversations: links.get(String(row.id)) ?? [], latestProgress: progress.get(String(row.id)) ?? null }) as unknown as TaskDetail);
  }
  private snapshot(): TasksSnapshot {
    const rows = this.db.prepare(`${select} WHERE (deleted_at IS NULL AND archived_at IS NULL) OR deleted_at > ? ORDER BY sort_order,id`).all(this.now() - TASK_RECYCLE_RETENTION_MS);
    const details = this.details(rows);
    return {
      members: this.db.prepare("SELECT id,name,revision,identity_kind,identity_id FROM task_members ORDER BY name,id").all().map(row => ({ id: String(row.id), name: String(row.name), revision: Number(row.revision), identity: row.identity_kind === null ? null : { kind: String(row.identity_kind), id: String(row.identity_id) } })),
      recycled: details.filter(row => row.deletedAt !== null).sort((a, b) => b.deletedAt! - a.deletedAt! || a.id.localeCompare(b.id)),
      tasks: details.filter(row => row.deletedAt === null),
    };
  }
  private decodeEvent(row: Record<string, unknown>): TaskEvent {
    return { seq: Number(row.seq), eventId: String(row.event_id), taskId: String(row.task_id), type: row.type as TaskEventType, taskRevision: Number(row.task_revision), actor: row.actor === null ? null : JSON.parse(String(row.actor)), channel: row.channel as TaskEvent["channel"], payload: JSON.parse(String(row.payload)), createdAt: Number(row.created_at) };
  }
  private appendEvent(taskId: string, type: TaskEventType, payload: Readonly<Record<string, unknown>>, context: TaskEventContext, eventId: string = randomUUID()): TaskEvent {
    const row = this.db.prepare("SELECT revision FROM tasks WHERE id=?").get(taskId)!;
    this.db.prepare("INSERT INTO task_events(event_id,task_id,type,task_revision,actor,channel,payload,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(eventId, taskId, type, Number(row.revision), context.actor === null ? null : JSON.stringify(context.actor), context.channel, JSON.stringify(payload), this.now());
    return this.decodeEvent(this.db.prepare("SELECT * FROM task_events WHERE event_id=?").get(eventId)!);
  }
  events(input: Params<"opencraft/tasks/events/list">): TaskEventsPage {
    return this.transaction(() => {
      this.task(input.taskId, undefined, true);
      const limit = input.limit ?? 20;
      const rows = this.db.prepare("SELECT * FROM task_events WHERE task_id=? AND seq<? ORDER BY seq DESC LIMIT ?").all(input.taskId, input.beforeSeq ?? Number.MAX_SAFE_INTEGER, limit + 1);
      return { events: rows.slice(0, limit).map(row => this.decodeEvent(row)), nextBeforeSeq: rows.length > limit ? Number(rows[limit - 1]!.seq) : null };
    });
  }
  event(taskId: string, eventId: string): TaskEvent | null {
    return this.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(taskId)) throw new TasksFault(-32052, "Task missing");
      const row = this.db.prepare("SELECT * FROM task_events WHERE task_id=? AND event_id=?").get(taskId, eventId);
      return row ? this.decodeEvent(row) : null;
    });
  }
  progress(input: Params<"opencraft/tasks/progress/append">, context: TaskEventContext = systemContext): TaskEvent {
    return this.transaction(() => {
      this.task(input.taskId);
      const row = this.db.prepare("SELECT * FROM task_events WHERE event_id=?").get(input.eventId);
      if (row) {
        const event = this.decodeEvent(row);
        if (event.taskId !== input.taskId || event.type !== "progress" || event.payload.text !== input.text)
          throw new TasksFault(-32051, "Progress event ID already exists with different content");
        return event;
      }
      // Progress does not change content revision, ordering or task updatedAt.
      return this.appendEvent(input.taskId, "progress", { text: input.text }, context, input.eventId);
    });
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
