import { isAbsolute } from "node:path";
import {
  TASKS,
  type TaskContent,
  TASK_STATUSES,
  type TaskStatus,
} from "@opencraft/appserver-protocol";
import { TasksFault, TasksSqliteStore } from "./sqlite";
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
function status(input: unknown): TaskStatus {
  if (
    typeof input !== "string" ||
    !TASK_STATUSES.some((value) => value === input)
  )
    throw new TasksFault(-32602, "Invalid Task status");
  return input as TaskStatus;
}
function content(p: Record<string, unknown>): TaskContent {
  const projectServerId =
      p.projectServerId === null ? null : id(p.projectServerId),
    projectId = p.projectId === null ? null : id(p.projectId);
  if ((projectServerId === null) !== (projectId === null))
    throw new TasksFault(-32602, "Invalid project reference");
  return {
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
  ) {}
  handle(method: string, input: unknown): unknown {
    if (this.closed) throw new TasksFault(-32050, "Tasks storage unavailable");
    if (!this.path || !isAbsolute(this.path))
      throw new TasksFault(-32601, "Tasks storage is not configured");
    const fields: Record<string, readonly string[]> = {
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
      ],
      [TASKS.update]: [
        "id",
        "expectedRevision",
        "title",
        "description",
        "projectServerId",
        "projectId",
      ],
      [TASKS.move]: ["id", "expectedRevision", "status", "beforeId"],
      [TASKS.remove]: ["id", "expectedRevision"],
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
    if (method === TASKS.capabilities)
      return { version: 1, storage: "sqlite-rows" };
    try {
      const store = (this.store ??= new TasksSqliteStore(this.path));
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
          });
          break;
        case TASKS.update:
          result = store.update({ ...content(p), ...task() });
          break;
        case TASKS.move:
          result = store.move({
            ...task(),
            status: status(p.status),
            beforeId: p.beforeId === null ? null : id(p.beforeId),
          });
          break;
        case TASKS.remove:
          result = store.remove(task());
          break;
        case TASKS.attach:
          result = store.attach(link());
          break;
        case TASKS.detach:
          result = store.detach(link());
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
