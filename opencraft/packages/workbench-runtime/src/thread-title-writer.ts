export interface ThreadIdentity { readonly hostId: string; readonly threadId: string }
export interface ThreadTitlePort {
  read(key: ThreadIdentity): string;
  write(key: ThreadIdentity, value: string): void;
  persist(key: ThreadIdentity, value: string): Promise<void>;
}
/** Application-scoped acknowledgement queue; the backend remains the durable authority. */
export class ThreadTitleWriter {
  private readonly writes = new Map<string, { confirmed: string; desired: string; latest: number; promise: Promise<void>; pending: number }>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  getSnapshot = () => this.revision;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() { this.revision++; for (const listener of this.listeners) listener(); }
  pendingTitle(key: ThreadIdentity): string | null { return this.writes.get(JSON.stringify([key.hostId, key.threadId]))?.desired ?? null; }
  constructor(private readonly port: ThreadTitlePort) {}
  rename(key: ThreadIdentity, rawTitle: string): Promise<void> {
    const title = rawTitle.trim();
    if (!title) return Promise.reject(new Error("Thread title cannot be empty"));
    const id = JSON.stringify([key.hostId, key.threadId]);
    const state = this.writes.get(id) ?? { confirmed: this.port.read(key), desired: title, latest: 0, promise: Promise.resolve(), pending: 0 };
    this.writes.set(id, state);
    const version = ++state.latest; state.pending++; state.desired = title; this.port.write(key, title); this.publish();
    const operation = state.promise.catch(() => undefined).then(async () => {
      try {
        await this.port.persist(key, title); state.confirmed = title;
      } catch (error) {
        if (version === state.latest && this.port.read(key) === title) this.port.write(key, state.confirmed);
        throw error;
      } finally {
        state.pending--; if (state.pending === 0 && this.writes.get(id) === state) this.writes.delete(id); this.publish();
      }
    });
    state.promise = operation; return operation;
  }
}
