import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type {
  TaskDetail,
  TasksSnapshot,
  TasksMethodMap,
} from "@opencraft/appserver-protocol";

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
const select = `SELECT id,title,description,status,project_server_id AS projectServerId,project_id AS projectId,
 sort_order AS sortOrder,revision,created_at AS createdAt,updated_at AS updatedAt,deleted_at AS deletedAt FROM tasks`;
type Params<M extends keyof TasksMethodMap> = TasksMethodMap[M]["params"];

export class TasksSqliteStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      if (path !== ":memory:") chmodSync(path, 0o600);
      this.db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000",
      );
      this.transaction(() => {
        const tables = this.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all();
        if (!tables.length) {
          this.db.exec(
            "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL) STRICT",
          );
          this.db.exec(schema);
          this.db
            .prepare("INSERT INTO schema_migrations VALUES(1,?,?,?)")
            .run("tasks-rows", this.checksum(), Date.now());
        } else {
          const rows = this.db
            .prepare(
              "SELECT version,name,checksum FROM schema_migrations ORDER BY version",
            )
            .all();
          if (
            rows.length !== 1 ||
            rows[0].version !== 1 ||
            rows[0].name !== "tasks-rows" ||
            rows[0].checksum !== this.checksum()
          )
            throw new Error("Unsupported Tasks database");
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
  list(): TasksSnapshot {
    return this.transaction(() => this.snapshot());
  }
  read(id: string): TaskDetail {
    return this.transaction(() => this.task(id));
  }
  forConversation(serverId: string, threadId: string): TasksSnapshot {
    return this.transaction(() => ({
      tasks: this.db
        .prepare(
          `${select} WHERE deleted_at IS NULL AND id IN
      (SELECT task_id FROM task_conversations WHERE server_id=? AND thread_id=?) ORDER BY sort_order,id`,
        )
        .all(serverId, threadId)
        .map((row) => this.detail(row)),
    }));
  }
  create(input: Params<"opencraft/tasks/create">): TasksSnapshot {
    return this.transaction(() => {
      const existing = this.db.prepare(`${select} WHERE id=?`).get(input.id);
      if (existing) {
        if (
          existing.deletedAt !== null ||
          existing.title !== input.title ||
          existing.description !== input.description ||
          existing.status !== input.status ||
          existing.projectServerId !== input.projectServerId ||
          existing.projectId !== input.projectId
        )
          throw new TasksFault(-32051, "Task ID already exists");
        return this.snapshot();
      }
      if (
        Number(
          this.db
            .prepare(
              "SELECT count(*) AS count FROM tasks WHERE deleted_at IS NULL",
            )
            .get()?.count,
        ) >= 1000
      )
        throw new TasksFault(-32054, "Task workspace is full");
      const now = Date.now();
      this.db
        .prepare(
          "INSERT INTO tasks(id,title,description,status,project_server_id,project_id,sort_order,revision,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,1,?,?,NULL)",
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
        );
      return this.snapshot();
    });
  }
  update(input: Params<"opencraft/tasks/update">): TasksSnapshot {
    return this.transaction(() => {
      this.task(input.id, input.expectedRevision);
      this.db
        .prepare(
          "UPDATE tasks SET title=?,description=?,project_server_id=?,project_id=?,revision=revision+1,updated_at=? WHERE id=?",
        )
        .run(
          input.title,
          input.description,
          input.projectServerId,
          input.projectId,
          Date.now(),
          input.id,
        );
      return this.snapshot();
    });
  }
  move(input: Params<"opencraft/tasks/move">): TasksSnapshot {
    return this.transaction(() => {
      const task = this.task(input.id, input.expectedRevision);
      if (input.beforeId === input.id) {
        if (task.status !== input.status)
          throw new TasksFault(-32602, "Invalid move target");
        return this.snapshot();
      }
      const ids = this.db
        .prepare(
          "SELECT id FROM tasks WHERE status=? AND deleted_at IS NULL AND id<>? ORDER BY sort_order,id",
        )
        .all(input.status, input.id)
        .map((row) => String(row.id));
      const index =
        input.beforeId === null ? ids.length : ids.indexOf(input.beforeId);
      if (index < 0) throw new TasksFault(-32051, "Move target changed");
      ids.splice(index, 0, input.id);
      const now = Date.now();
      ids.forEach((id, order) => {
        this.db
          .prepare(
            "UPDATE tasks SET status=?,sort_order=?,revision=revision+1,updated_at=? WHERE id=? AND (status<>? OR sort_order<>?)",
          )
          .run(input.status, order, now, id, input.status, order);
      });
      return this.snapshot();
    });
  }
  remove(input: Params<"opencraft/tasks/remove">): TasksSnapshot {
    return this.transaction(() => {
      this.task(input.id, input.expectedRevision);
      this.db
        .prepare(
          "UPDATE tasks SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?",
        )
        .run(Date.now(), Date.now(), input.id);
      return this.snapshot();
    });
  }
  attach(input: Params<"opencraft/tasks/conversations/attach">): TasksSnapshot {
    return this.link(input, true);
  }
  detach(input: Params<"opencraft/tasks/conversations/detach">): TasksSnapshot {
    return this.link(input, false);
  }
  private link(
    input: Params<"opencraft/tasks/conversations/attach">,
    attach: boolean,
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
          .run(input.id, input.serverId, input.threadId, Date.now());
      } else
        this.db
          .prepare(
            "DELETE FROM task_conversations WHERE task_id=? AND server_id=? AND thread_id=?",
          )
          .run(input.id, input.serverId, input.threadId);
      this.db
        .prepare("UPDATE tasks SET revision=revision+1,updated_at=? WHERE id=?")
        .run(Date.now(), input.id);
      return this.snapshot();
    });
  }
  private nextOrder(status: string): number {
    return Number(
      this.db
        .prepare(
          "SELECT coalesce(max(sort_order),-1)+1 AS value FROM tasks WHERE status=? AND deleted_at IS NULL",
        )
        .get(status)?.value,
    );
  }
  private detail(row: Record<string, unknown>): TaskDetail {
    const conversations = this.db
      .prepare(
        "SELECT server_id AS serverId,thread_id AS threadId,created_at AS createdAt FROM task_conversations WHERE task_id=? ORDER BY created_at,server_id,thread_id",
      )
      .all(String(row.id));
    return { ...row, conversations } as unknown as TaskDetail;
  }
  private task(id: string, revision?: number): TaskDetail {
    const row = this.db
      .prepare(`${select} WHERE id=? AND deleted_at IS NULL`)
      .get(id);
    if (!row) throw new TasksFault(-32052, "Task missing");
    if (revision !== undefined && row.revision !== revision)
      throw new TasksFault(-32051, "Task changed; refresh before retrying");
    return this.detail(row);
  }
  private snapshot(): TasksSnapshot {
    return {
      tasks: this.db
        .prepare(`${select} WHERE deleted_at IS NULL ORDER BY sort_order,id`)
        .all()
        .map((row) => this.detail(row)),
    };
  }
  private checksum(): string {
    return createHash("sha256").update(schema).digest("hex");
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
