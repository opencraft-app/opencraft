import type { QueryClient } from "@tanstack/react-query";
import type { ThreadIdentity } from "@opencraft/workbench-runtime";

type Catalog = { data?: Array<{ id: string; pinned?: boolean }>; pages?: Catalog[] };

/** Transient acknowledgement overlay. Native metadata remains the durable owner. */
export class ThreadPinWriter {
  private readonly writes = new Map<string, {
    desired: boolean; confirmed: boolean; current: () => boolean;
    tail: Promise<void>; latest: number;
  }>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  getSnapshot = () => this.revision;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() { this.revision++; for (const listener of this.listeners) listener(); }
  private id(key: ThreadIdentity) { return JSON.stringify([key.hostId, key.threadId]); }
  constructor(private readonly query: QueryClient, private readonly port: {
    capture(key: ThreadIdentity): () => boolean;
    persist(key: ThreadIdentity, pinned: boolean): Promise<void>;
  }) {}
  project<T extends { pinned?: boolean }>(key: ThreadIdentity, thread: T): T {
    const state = this.writes.get(this.id(key));
    return state?.current() && thread.pinned !== state.desired ? { ...thread, pinned: state.desired } : thread;
  }
  set(key: ThreadIdentity, pinned: boolean): Promise<void> {
    const id = this.id(key);
    const previous = this.writes.get(id);
    const state = previous?.current() ? previous : {
      desired: pinned, confirmed: this.read(key), current: this.port.capture(key),
      tail: Promise.resolve(), latest: 0,
    };
    if (!state.current()) return Promise.reject(new Error("Conversation connection changed"));
    this.writes.set(id, state);
    const version = ++state.latest;
    state.desired = pinned;
    this.publish();
    const operation = state.tail.catch(() => undefined).then(async () => {
      try {
        if (!state.current()) throw new Error("Conversation connection changed");
        await this.port.persist(key, pinned);
        if (!state.current()) throw new Error("Conversation connection changed");
        state.confirmed = pinned;
      } catch (error) {
        if (version === state.latest) { state.desired = state.confirmed; this.publish(); }
        throw error;
      } finally {
        // Keep the overlay through the directory refresh: neither an old read nor
        // another Thread's refresh may undo the user's outstanding intent.
        if (state.current()) {
          this.write(key, state.confirmed);
          await this.query.invalidateQueries({ queryKey: ["appserver", key.hostId, "threads"] }).catch(() => undefined);
        }
        if (this.writes.get(id) === state && version === state.latest) {
          this.writes.delete(id);
          this.publish();
        }
      }
    });
    state.tail = operation;
    return operation;
  }
  private read(key: ThreadIdentity): boolean {
    for (const [, data] of this.query.getQueriesData<Catalog>({ queryKey: ["appserver", key.hostId, "threads"] })) {
      for (const page of data?.pages ?? [data]) {
        const thread = page?.data?.find(thread => thread.id === key.threadId);
        if (thread) return thread.pinned === true;
      }
    }
    return false;
  }
  private write(key: ThreadIdentity, pinned: boolean) {
    const patch = (data: Catalog | undefined): Catalog | undefined => data && {
      ...data, ...(data.pages ? { pages: data.pages.map(page => patch(page)!) } : {}),
      ...(data.data ? { data: data.data.map(thread => thread.id === key.threadId ? { ...thread, pinned } : thread) } : {}),
    };
    this.query.setQueriesData<Catalog>({ queryKey: ["appserver", key.hostId, "threads"] }, patch);
  }
}
