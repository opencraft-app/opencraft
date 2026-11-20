import type { Thread } from "@opencraft/appserver-protocol/generated/v2";

export interface ThreadCreationEvidence {
  readonly thread: Thread;
  readonly accepted: boolean;
  readonly retired: boolean;
}
/** Creation facts, not delivery state. A durable provider supplies its existing
 * lifecycle store; adapters without one retain connection-scoped evidence. */
export interface ThreadCreationEvidenceStore {
  allocate(thread: Thread): void;
  read(threadId: string): ThreadCreationEvidence | undefined;
  accept(threadId: string, turnId: string): void;
  patch(threadId: string, patch: { name?: string; status?: Thread["status"] }): void;
  retire(threadId: string, removed?: boolean): void;
  committed(): readonly Thread[];
}
export class MemoryThreadCreationEvidence implements ThreadCreationEvidenceStore {
  private readonly entries = new Map<string, ThreadCreationEvidence>();
  private readonly retiredIds = new Set<string>();
  allocate(thread: Thread): void {
    // Duplicate notifications/receipts cannot regress a committed creation.
    if (!this.retiredIds.has(thread.id) && !this.entries.has(thread.id)) this.entries.set(thread.id, { thread, accepted: false, retired: false });
  }
  read(id: string) { return this.entries.get(id); }
  accept(id: string, _turnId: string): void {
    const old = this.entries.get(id);
    if (old && !old.retired && !old.accepted) this.entries.set(id, { ...old, accepted: true });
  }
  patch(id: string, patch: { name?: string; status?: Thread["status"] }): void {
    const old = this.entries.get(id);
    if (old && !old.retired) this.entries.set(id, { ...old, thread: { ...old.thread, ...patch } });
  }
  retire(id: string, removed = false): void {
    if (!removed && !this.entries.has(id)) return;
    // Keep only the identity fence until the connection resets. Evicting old
    // removals would let delayed metadata resurrect deleted conversations.
    this.retiredIds.add(id);
    this.entries.delete(id);
  }
  committed(): readonly Thread[] { return [...this.entries.values()].filter(row => row.accepted && !row.retired).map(row => row.thread); }
}
