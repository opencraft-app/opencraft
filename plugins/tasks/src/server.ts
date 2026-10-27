import { isAbsolute } from "node:path";
import {
  TASKS,
  type TaskContent,
  TASK_STATUSES,
  TASK_KINDS,
  TASK_PRIORITIES,
  TASK_AI_RESEARCH,
  type TaskStatus,
  type TaskProperties,
  type TaskPriority,
} from "@opencraft/appserver-protocol";
import { TasksFault, TasksSqliteStore, TASK_RECYCLE_RETENTION_MS, type TaskEventContext } from "./sqlite";
export { TasksFault } from "./sqlite";
function text(input: unknown, max: number, empty = false): string {
  if (
    typeof input !== "string" ||
    input.length > max ||
    input.includes("\0") ||
    (!empty && !input.trim())
  )
    throw new TasksFault(-32602, "Invalid Tasks request");
  return empty ? input : input.trim();
}
function id(input: unknown): string {
  return text(input, 256);
}
function revision(input: unknown): number {
  if (!Number.isSafeInteger(input) || Number(input) < 1)
    throw new TasksFault(-32602, "Invalid Task revision");
  return Number(input);
}
function memberIdentity(input: unknown): import("@opencraft/appserver-protocol").TaskMemberIdentity | null {
  if (input === null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "kind" && key !== "id"))
    throw new TasksFault(-32602, "Invalid member profile identity");
  const p = input as Record<string, unknown>, kind = text(p.kind, 64);
  if (!/^[a-z][a-z0-9._-]*$/.test(kind)) throw new TasksFault(-32602, "Invalid identity kind");
  return { kind, id: id(p.id) };
}
function status(input: unknown): TaskStatus {
  if (
    typeof input !== "string" ||
    !TASK_STATUSES.some((value) => value === input)
  )
    throw new TasksFault(-32602, "Invalid Task status");
  return input as TaskStatus;
}
function dueDate(input: unknown): string | null {
  const value = input === null ? null : text(input, 10);
  if (value !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value))
    throw new TasksFault(-32602, "Invalid due date");
  return value;
}
function priority(input: unknown): TaskPriority {
  if (!TASK_PRIORITIES.some(value => value === input)) throw new TasksFault(-32602, "Invalid priority");
  return input as TaskPriority;
}
function researchMode(input: unknown): string {
  if (!TASK_AI_RESEARCH.some(mode => mode === input)) throw new TasksFault(-32602, "Invalid AI research disposition");
  return String(input);
}
function properties(p: Record<string, unknown>): Partial<TaskProperties> {
  return {
    ...("aiResearch" in p ? { aiResearch: researchMode(p.aiResearch) } : {}),
    ...("aiResearchReason" in p ? { aiResearchReason: text(p.aiResearchReason, 2048, true).trim() } : {}),
    ...("assigneeId" in p ? { assigneeId: p.assigneeId === null ? null : id(p.assigneeId) } : {}),
    ...("priority" in p ? { priority: priority(p.priority) } : {}),
    ...("dueDate" in p ? { dueDate: dueDate(p.dueDate) } : {}),
  };
}
function taskKind(input: unknown): string {
  if (!TASK_KINDS.some(kind => kind === input)) throw new TasksFault(-32602, "Unsupported Task kind");
  return String(input);
}
function pageNumber(input: unknown, maximum: number): number {
  if (!Number.isSafeInteger(input) || Number(input) < 1 || Number(input) > maximum) throw new TasksFault(-32602, "Invalid activity page");
  return Number(input);
}
function content(p: Record<string, unknown>): TaskContent {
  const projectServerId =
      p.projectServerId === null ? null : id(p.projectServerId),
    projectId = p.projectId === null ? null : id(p.projectId);
  if ((projectServerId === null) !== (projectId === null))
    throw new TasksFault(-32602, "Invalid project reference");
  return {
    ...properties(p),
    ...("kind" in p ? { kind: taskKind(p.kind) } : {}),
    ...("acceptanceCriteria" in p ? { acceptanceCriteria: text(p.acceptanceCriteria, 16384, true) } : {}),
    title: text(p.title, 200),
    description: text(p.description, 16384, true),
    projectServerId,
    projectId,
  };
}
export class TasksService {
  private store: TasksSqliteStore | null = null;
  private closed = false;
  constructor(
    private readonly path: string | null,
    private readonly onChange: () => void = () => {},
    store?: TasksSqliteStore,
  ) { this.store = store ?? null; }
  get outcome() { return this.store?.outcome; }
  /** Required configured authority opens before the owning Host reports ready. */
  open(): void {
    if (this.closed) throw new TasksFault(-32050, "Tasks storage unavailable");
    if (this.path && isAbsolute(this.path)) this.store ??= new TasksSqliteStore(this.path);
  }
  handle(method: string, input: unknown, context: TaskEventContext = { channel: "api", actor: null }): unknown {
    if (this.closed) throw new TasksFault(-32050, "Tasks storage unavailable");
    if (!this.path || !isAbsolute(this.path))
      throw new TasksFault(-32601, "Tasks storage is not configured");
    const fields: Record<string, readonly string[]> = {
      [TASKS.archive]: ["id", "expectedRevision"],
      [TASKS.unarchive]: ["id", "expectedRevision"],
      [TASKS.archives]: ["search", "limit", "before"],
      [TASKS.events]: ["taskId", "beforeSeq", "limit"],
      [TASKS.event]: ["taskId", "eventId"],
      [TASKS.progress]: ["taskId", "eventId", "text"],
      [TASKS.properties]: ["id", "expectedRevision", "assigneeId", "priority", "dueDate", "aiResearch", "aiResearchReason"],
      [TASKS.members]: ["id", "name", "expectedRevision", "identity"],
      [TASKS.capabilities]: [],
      [TASKS.list]: [],
      [TASKS.read]: ["id"],
      [TASKS.create]: [
        "id",
        "title",
        "description",
        "status",
        "projectServerId",
        "projectId",
        "assigneeId", "priority", "dueDate", "kind", "acceptanceCriteria", "aiResearch", "aiResearchReason",
      ],
      [TASKS.update]: [
        "id",
        "expectedRevision",
        "title",
        "description",
        "projectServerId",
        "projectId",
        "assigneeId", "priority", "dueDate", "kind", "acceptanceCriteria", "aiResearch", "aiResearchReason",
      ],
      [TASKS.move]: ["id", "expectedRevision", "status", "beforeId"],
      [TASKS.remove]: ["id", "expectedRevision"],
      [TASKS.restore]: ["id", "expectedRevision"],
      [TASKS.attach]: ["id", "expectedRevision", "serverId", "threadId"],
      [TASKS.detach]: ["id", "expectedRevision", "serverId", "threadId"],
      [TASKS.forConversation]: ["serverId", "threadId"],
    };
    const allowed = fields[method];
    if (!allowed) throw new TasksFault(-32601, "Unsupported Tasks method");
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !allowed.includes(key))
    )
      throw new TasksFault(-32602, "Invalid Tasks request");
    const p = input as Record<string, unknown>;
    try {
      const store = (this.store ??= new TasksSqliteStore(this.path));
      if (method === TASKS.capabilities) return { version: 1, storage: "sqlite-rows", archive: true, aiResearch: true, properties: true, memberIdentity: true, planning: true, supportedKinds: TASK_KINDS, activity: true, progress: true, recycleBinRetentionMs: TASK_RECYCLE_RETENTION_MS };
      const task = () => ({
        id: id(p.id),
        expectedRevision: revision(p.expectedRevision),
      });
      const link = () => ({
        ...task(),
        serverId: id(p.serverId),
        threadId: id(p.threadId),
      });
      let result: unknown;
      switch (method) {
        case TASKS.archive:
        case TASKS.unarchive:
          result = store.archive(task(), method === TASKS.archive, context);
          break;
        case TASKS.archives: {
          let before: import("@opencraft/appserver-protocol").TaskArchiveCursor | undefined;
          if (p.before !== undefined) {
            if (!p.before || typeof p.before !== "object" || Array.isArray(p.before) || Object.keys(p.before).some(key => key !== "archivedAt" && key !== "id"))
              throw new TasksFault(-32602, "Invalid archive cursor");
            const cursor = p.before as Record<string, unknown>;
            if (!Number.isSafeInteger(cursor.archivedAt) || Number(cursor.archivedAt) < 0) throw new TasksFault(-32602, "Invalid archive cursor");
            before = { archivedAt: Number(cursor.archivedAt), id: id(cursor.id) };
          }
          return store.archives({ search: p.search === undefined ? "" : text(p.search, 200, true).trim(), limit: p.limit === undefined ? 50 : pageNumber(p.limit, 100), ...(before ? { before } : {}) });
        }
        case TASKS.events:
          return store.events({ taskId: id(p.taskId), ...(p.beforeSeq === undefined ? {} : { beforeSeq: pageNumber(p.beforeSeq, Number.MAX_SAFE_INTEGER) }), limit: p.limit === undefined ? 20 : pageNumber(p.limit, 100) });
        case TASKS.event:
          return store.event(id(p.taskId), id(p.eventId));
        case TASKS.progress:
          result = store.progress({ taskId: id(p.taskId), eventId: id(p.eventId), text: text(p.text, 4096) }, context);
          break;
        case TASKS.members:
          result = store.member({ id: id(p.id), name: text(p.name, 120), expectedRevision: p.expectedRevision === null ? null : revision(p.expectedRevision), ...("identity" in p ? { identity: memberIdentity(p.identity) } : {}) });
          break;
        case TASKS.properties: {
          const values = properties(p);
          if (!Object.keys(values).length) throw new TasksFault(-32602, "At least one Task property is required");
          result = store.properties({ ...task(), ...values }, context);
          break;
        }
        case TASKS.list:
          return store.list();
        case TASKS.read:
          return store.read(id(p.id));
        case TASKS.forConversation:
          return store.forConversation(id(p.serverId), id(p.threadId));
        case TASKS.create:
          result = store.create({
            ...content(p),
            id: id(p.id),
            status: status(p.status),
          }, context);
          break;
        case TASKS.update:
          result = store.update({ ...content(p), ...task() }, context);
          break;
        case TASKS.move:
          result = store.move({
            ...task(),
            status: status(p.status),
            beforeId: p.beforeId === null ? null : id(p.beforeId),
          }, context);
          break;
        case TASKS.restore:
          result = store.restore(task(), context);
          break;
        case TASKS.remove:
          result = store.remove(task(), context);
          break;
        case TASKS.attach:
          result = store.attach(link(), context);
          break;
        case TASKS.detach:
          result = store.detach(link(), context);
          break;
      }
      this.onChange();
      return result;
    } catch (error) {
      if (error instanceof TasksFault) throw error;
      throw new TasksFault(-32050, "Tasks storage unavailable");
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.store?.close();
    this.store = null;
  }
}
