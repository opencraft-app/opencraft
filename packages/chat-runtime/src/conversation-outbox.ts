import type { ConversationKey } from "@opencraft/chat-core";
import { composerDocumentToPlainText, type SubmissionReceipt, type SubmitIntent } from "@opencraft/composer-core";
import type { MessageSender } from "@opencraft/appserver-protocol";
import type { QueuedSubmission } from "./models";
import { SubmissionNotDispatchedError, SubmissionOutcomeUnknownError } from "./ports";

export interface ConversationOutboxEntry {
  readonly intent: SubmitIntent;
  readonly state: "waiting" | "sending" | "unknown" | "failed";
  readonly sender?: MessageSender | null;
  readonly error?: string;
}

/** Platform-owned deployment/account storage. Writes must throw when custody is unavailable. */
export interface ConversationOutboxStorage {
  read(key: ConversationKey): readonly ConversationOutboxEntry[] | Promise<readonly ConversationOutboxEntry[]>;
  write(key: ConversationKey, entries: readonly ConversationOutboxEntry[]): void | Promise<void>;
  subscribe(listener: () => void): () => void;
}

export interface ConversationOutboxDispatch {
  ready(): boolean;
  blocked(): boolean;
  send(intent: SubmitIntent, options: { readonly canDispatch: () => boolean }): Promise<SubmissionReceipt>;
  retire(ids: readonly string[]): void;
  sender?(): MessageSender | null;
  publish(): void;
}
export type ConversationOutbox = ReturnType<typeof createConversationOutbox>;

/** One local owner survives whether a remote Thread binding is present or absent. */
export function createConversationOutbox(config: ConversationOutboxDispatch & {
  key: ConversationKey;
  storage: ConversationOutboxStorage;
}) {
  let dispatch: ConversationOutboxDispatch | null = config;
  let revision = 0;
  const listeners = new Set<() => void>();
  let entries: readonly ConversationOutboxEntry[] = [];
  let storageError: Error | null = null;
  let generation = 0;
  let disposed = false;
  let draining = false;
  let hydrated = false;
  const read = (): Promise<void> => {
    const owner = generation;
    hydrated = false;
    const apply = (rows: readonly ConversationOutboxEntry[]) => {
      if (disposed || owner !== generation) return;
      entries = rows.map(entry => entry.state === "sending" ? { ...entry, state: "unknown" as const } : entry);
      storageError = null; hydrated = true;
    };
    const failed = (error: unknown) => {
      if (!disposed && owner === generation) { storageError = error instanceof Error ? error : new Error(String(error)); hydrated = true; }
    };
    try {
      const result = config.storage.read(config.key);
      if (result instanceof Promise) return result.then(apply, failed).then(() => { if (!disposed && owner === generation) { notify(); wake(); } });
      apply(result);
    } catch (error) { failed(error); }
    return Promise.resolve();
  };
  let hydration = read();
  let mutations: Promise<unknown> = Promise.resolve();
  const commit = (update: () => readonly ConversationOutboxEntry[]) => {
    const owner = generation;
    const result = mutations.then(async () => {
      await hydration;
      if (disposed || owner !== generation) throw new Error("Conversation outbox scope changed");
      const next = update();
      await config.storage.write(config.key, next);
      if (disposed || owner !== generation) throw new Error("Conversation outbox scope changed");
      entries = next; storageError = null;
    });
    mutations = result.catch(() => undefined);
    return result;
  };
  const notify = () => { if (!disposed) { revision++; dispatch?.publish(); for (const listener of listeners) listener(); } };
  const drain = async () => {
    if (disposed || draining || !dispatch?.ready() || (dispatch?.blocked() ?? true)) return;
    draining = true;
    const owner = generation;
    try {
      await hydration;
      if (storageError) return;
      while (!disposed && owner === generation && dispatch?.ready() && !(dispatch?.blocked() ?? true)) {
        const head = entries[0];
        if (!head || head.state !== "waiting") break;
        // Persist the attempt before crossing the transport boundary. A reload
        // here loses automatic retry, never duplicates an uncertain execution.
        await commit(() => entries.map(entry => entry.intent.commandId === head.intent.commandId ? { ...entry, state: "sending" as const } : entry));
        if (!entries.some(entry => entry.intent.commandId === head.intent.commandId && entry.state === "sending")) continue;
        notify();
        if (disposed || owner !== generation) break;
        if (!dispatch?.ready() || (dispatch?.blocked() ?? true)) {
          // Publishing custody can synchronously revoke dispatch readiness.
          // No transport call has happened, so keep this input retryable.
          await commit(() => entries.map(entry => entry.intent.commandId === head.intent.commandId
            ? { ...entry, state: "waiting" as const } : entry));
          notify();
          break;
        }
        try {
          await dispatch!.send({ ...head.intent, target: { type: "enqueue-follow-up", key: config.key } },
            { canDispatch: () => !disposed && owner === generation && dispatch?.ready() === true });
          if (disposed || owner !== generation) break;
          await commit(() => entries.filter(entry => entry.intent.commandId !== head.intent.commandId));
          notify();
        } catch (error) {
          if (disposed || owner !== generation) break;
          await mutations;
          if (disposed || owner !== generation) break;
          // A live server event can confirm and retire this entry before its
          // RPC settles. Its lost ACK must not strand the next waiting input.
          if (!entries.some(entry => entry.intent.commandId === head.intent.commandId)) continue;
          const state = error instanceof SubmissionNotDispatchedError ? "waiting"
            : error instanceof SubmissionOutcomeUnknownError ? "unknown" : "failed";
          await commit(() => entries.map(entry => entry.intent.commandId === head.intent.commandId
            ? { ...entry, state, error: state === "waiting" ? undefined : error instanceof Error ? error.message : String(error) } : entry));
          notify();
          break;
        }
      }
    } catch (error) {
      if (disposed || owner !== generation) return;
      // A failed retirement must retain the attempted row. Do not let a later
      // wake resend it or hide a quota error behind a successful network ACK.
      storageError = error instanceof Error ? error : new Error(String(error));
      entries = entries.map(entry => entry.state === "sending" ? { ...entry, state: "unknown", error: storageError!.message } : entry);
      notify();
    } finally {
      draining = false;
      if (owner !== generation) wake();
    }
  };
  const wake = () => { void drain(); };
  const stop = config.storage.subscribe(() => {
    generation++;
    dispatch?.retire(entries.map(entry => entry.intent.commandId));
    // Account replacement retires every old asynchronous result.
    entries = [];
    hydration = read();
    notify();
    wake();
  });
  return {
    getRevision: () => revision,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    attach(next: ConversationOutboxDispatch): () => void {
      if (disposed) throw new Error("Conversation outbox is disposed");
      generation++; dispatch = next;
      hydration = read(); notify(); wake();
      return () => {
        if (dispatch !== next) return;
        generation++; dispatch = null;
        entries = entries.map(entry => entry.state === "sending" ? { ...entry, state: "unknown" as const } : entry);
        notify();
      };
    },
    get hydrated() { return hydrated; },
    hasPending: () => entries.length > 0,
    ready: () => hydration,
    wake,
    get error() { return storageError; },
    project(): readonly QueuedSubmission[] {
      return entries.map(entry => ({
        local: true,
        commandId: entry.intent.commandId,
        clientMessageId: entry.intent.clientMessageId,
        serverSubmissionId: null,
        sender: entry.sender,
        input: [],
        preview: composerDocumentToPlainText(entry.intent.document),
        state: entry.state === "waiting" ? "queued" : entry.state === "sending" ? "submitting" : entry.state,
        operation: "idle",
        createdAt: entry.intent.createdAt,
        pausedReason: entry.state === "unknown" ? "outbox-unconfirmed"
          : entry.state === "failed" ? "outbox-failed" : "outbox-waiting",
        error: entry.error ? new Error(entry.error) : storageError,
      }));
    },
    async admit(intent: SubmitIntent): Promise<SubmissionReceipt> {
      const owner = generation;
      await hydration;
      if (owner !== generation) throw new Error("Conversation outbox scope changed");
      if (disposed) throw new Error("Conversation outbox is disposed");
      if (storageError) throw storageError;
      if (intent.target.type !== "existing-thread" && intent.target.type !== "enqueue-follow-up"
        && intent.target.type !== "steer-active-turn") throw new Error("This action requires a connection");
      if (intent.target.key.hostId !== config.key.hostId || intent.target.key.threadId !== config.key.threadId)
        throw new Error("Outbox target does not match this conversation");
      // Attachment/context handles may point at a transient resolver or local
      // Blob. Keep the original Composer draft rather than promise lost bytes.
      if (intent.attachments.length || intent.context.length)
        throw new Error("Reconnect before sending attachments or attached context. Your draft has been kept.");
      await commit(() => {
        const duplicate = entries.find(entry => entry.intent.commandId === intent.commandId || entry.intent.clientMessageId === intent.clientMessageId);
        if (duplicate && JSON.stringify(duplicate.intent) !== JSON.stringify(intent)) throw new Error("The queued message identity already belongs to another input");
        if (!duplicate && entries.length >= 50) throw new Error("The local message queue is full. Reconnect or remove a waiting message.");
        return duplicate ? entries : [...entries, { intent, state: "waiting", sender: dispatch?.sender?.() }];
      });
      notify();
      wake();
      return { commandId: intent.commandId, clientMessageId: intent.clientMessageId,
        hostId: config.key.hostId, threadId: config.key.threadId, turnId: null,
        acceptedAt: Date.now(), replayed: false, disposition: "local-queue" };
    },
    async remove(id: string): Promise<boolean> {
      const owner = generation;
      await hydration;
      if (disposed || owner !== generation) throw new Error("Conversation outbox scope changed");
      const entry = entries.find(item => item.intent.commandId === id);
      if (!entry) return false;
      if (entry.state === "sending") throw new Error("Wait for this message's delivery result before removing it");
      await commit(() => {
        const current = entries.find(item => item.intent.commandId === id);
        if (current?.state === "sending") throw new Error("Wait for this message's delivery result before removing it");
        return entries.filter(item => item.intent.commandId !== id);
      });
      dispatch?.retire([id]);
      notify(); wake();
      return true;
    },
    async reconcile(clientIds: ReadonlySet<string>) {
      const owner = generation;
      const next = entries.filter(entry => entry.state === "waiting" || !clientIds.has(entry.intent.clientMessageId));
      if (next.length === entries.length) return;
      let retired: string[] = [];
      try {
        await commit(() => {
          const next = entries.filter(entry => entry.state === "waiting" || !clientIds.has(entry.intent.clientMessageId));
          retired = entries.filter(entry => !next.includes(entry)).map(entry => entry.intent.commandId);
          return next;
        });
        dispatch?.retire(retired);
        // Reconciliation may run inside snapshot derivation. Publish and drain
        // after the new authoritative snapshot has replaced the previous one.
        queueMicrotask(() => {
          if (disposed || owner !== generation) return;
          notify(); wake();
        });
      } catch (error) { if (!disposed && owner === generation) storageError = error instanceof Error ? error : new Error(String(error)); }
    },
    dispose() { disposed = true; generation++; dispatch = null; stop(); listeners.clear(); },
  };
}
