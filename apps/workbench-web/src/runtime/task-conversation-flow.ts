import { TASKS, type TaskDetail, type TasksMethod, type TasksMethodMap } from "@opencraft/appserver-protocol";
import type { SubmissionReceipt, SubmitIntent } from "@opencraft/composer-core";

interface Handoff {
  draftId: string;
  taskId: string;
  receipt: { serverId: string; threadId: string } | null;
}
export interface PendingTaskConversation {
  readonly taskId: string;
  readonly serverId: string;
  readonly threadId: string;
}

/** Client-owned draft placement and confirmed receipts; task data stays in SQLite. */
export class TaskConversationFlow {
  private records: Handoff[] = [];
  private listeners = new Set<() => void>();
  private operations = new Map<string, Promise<void>>();
  private generation = 0;
  private closed = false;
  constructor(private readonly ports: {
    storage: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
    storageKey(): string;
    request<M extends TasksMethod>(method: M, params: TasksMethodMap[M]["params"]): Promise<TasksMethodMap[M]["result"]>;
    serverId(hostId: string): string;
  }) { this.restore(); }

  private restore() {
    try {
      const records: Handoff[] = [];
      for (let index = 0; index < this.ports.storage.length && records.length < 64; index++) {
        const key = this.ports.storage.key(index);
        if (!key?.startsWith(`${this.ports.storageKey()}.`)) continue;
        let record: unknown;
        try { record = JSON.parse(this.ports.storage.getItem(key) ?? "null"); } catch { continue; }
        if (!record || typeof record !== "object") continue;
        const r = record as Handoff;
        const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 256;
        if (text(r.draftId) && key === this.key(r.draftId) && text(r.taskId) && (r.receipt === null ||
          !!r.receipt && text(r.receipt.serverId) && text(r.receipt.threadId))) records.push(r);
      }
      this.records = records;
    } catch { /* A corrupt placement record cannot authorize execution. */ }
  }
  private key(draftId: string) { return `${this.ports.storageKey()}.${encodeURIComponent(draftId)}`; }
  private persist(record: Handoff) { this.ports.storage.setItem(this.key(record.draftId), JSON.stringify(record)); }
  private complete(record: Handoff) {
    this.records = this.records.filter(r => r !== record);
    try { this.ports.storage.removeItem(this.key(record.draftId)); } catch {}
    this.publish();
  }
  private publish() { for (const listener of this.listeners) listener(); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  pending = (): readonly PendingTaskConversation[] => this.records.flatMap(r => r.receipt ? [{ taskId: r.taskId, ...r.receipt }] : []);

  register(draftId: string, taskId: string) {
    if (this.closed) throw new Error("Task conversation flow disposed");
    if (this.records.length >= 64) throw new Error("Too many retained task drafts");
    const record = { draftId, taskId, receipt: null };
    this.records.push(record);
    try { this.persist(record); } catch (error) { this.records.pop(); throw error; }
  }
  cancel(draftId: string) {
    this.records = this.records.filter(r => r.draftId !== draftId);
    this.ports.storage.removeItem(this.key(draftId));
  }
  /** Called immediately after thread/start, including when the first Turn later fails. */
  async created(intent: SubmitIntent, receipt: SubmissionReceipt) {
    if (intent.target.type !== "new-thread") return;
    const draftId = intent.target.draftId;
    const record = this.records.find(r => r.draftId === draftId);
    if (!record) return;
    record.receipt = { serverId: this.ports.serverId(receipt.hostId), threadId: receipt.threadId };
    // A confirmed thread is never retried by this owner. Keep the in-memory
    // receipt even if the browser's durable storage has become unavailable.
    try { this.persist(record); } catch {}
    this.publish();
    await this.link(record);
  }
  async retry(taskId?: string) {
    await Promise.all(this.records.filter(r => r.receipt && (!taskId || r.taskId === taskId)).map(r => this.link(r)));
  }
  private link(record: Handoff): Promise<void> {
    const existing = this.operations.get(record.draftId);
    if (existing) return existing;
    const generation = this.generation;
    const current = () => generation === this.generation && this.records.includes(record);
    const operation = (async () => {
      try {
        const receipt = record.receipt;
        if (!receipt) return;
        for (let attempt = 0; attempt < 3 && current(); attempt++) {
          const task: TaskDetail = await this.ports.request(TASKS.read, { id: record.taskId });
          if (!current()) return;
          if (task.conversations.some(link => link.serverId === receipt.serverId && link.threadId === receipt.threadId)) {
            this.complete(record);
            return;
          }
          try {
            await this.ports.request(TASKS.attach, { id: task.id, expectedRevision: task.revision, ...receipt });
          } catch { /* Re-read the authority for conflicts and lost acknowledgements. */ }
        }
        if (!current()) return;
        const task = await this.ports.request(TASKS.read, { id: record.taskId });
        if (current() && task.conversations.some(link => link.serverId === receipt.serverId && link.threadId === receipt.threadId)) {
          this.complete(record);
        }
      } catch { /* Expose the retained receipt through the Tasks recovery UI. */ }
    })().finally(() => { if (this.operations.get(record.draftId) === operation) this.operations.delete(record.draftId); });
    this.operations.set(record.draftId, operation);
    return operation;
  }
  revoke() {
    this.generation++;
    this.records = [];
    this.operations.clear();
    try {
      for (let index = this.ports.storage.length - 1; index >= 0; index--) {
        const key = this.ports.storage.key(index);
        if (key?.startsWith(`${this.ports.storageKey()}.`)) this.ports.storage.removeItem(key);
      }
    } catch {}
    this.publish();
  }
  dispose() { this.closed = true; this.generation++; this.records = []; this.operations.clear(); this.listeners.clear(); }
}

/** Bounded, reviewable native draft context. This function never starts a Turn. */
export function taskConversationContext(task: TaskDetail, progress: readonly { text: string; createdAt: number }[] = task.latestProgress ? [task.latestProgress] : []): string {
  const clip = (value: string, limit: number) => value.length <= limit ? value : `${value.slice(0, limit)}\n…`;
  return [
    clip(task.title, 200),
    `Task ID: ${task.id} · revision ${task.revision}\nType: ${task.kind ?? "unclassified"}\nStatus: ${task.status}`,
    task.description ? `Description:\n${clip(task.description, 4000)}` : "",
    task.acceptanceCriteria ? `Acceptance criteria:\n${clip(task.acceptanceCriteria, 3000)}` : "",
    progress.length ? `Recent progress:\n${progress.slice(0, 3).map(event => `${new Date(event.createdAt).toISOString()}: ${clip(event.text, 800)}`).join("\n\n")}` : "",
  ].filter(Boolean).join("\n\n");
}
