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

/** Platform-owned tab/account storage. Writes must throw when custody is unavailable. */
export interface ConversationOutboxStorage {
  read(key: ConversationKey): readonly ConversationOutboxEntry[];
  write(key: ConversationKey, entries: readonly ConversationOutboxEntry[]): void;
  subscribe(listener: () => void): () => void;
}

/** Never-attempted local input is distinct from the Host's admitted execution queue. */
export function createConversationOutbox(config: {
  key: ConversationKey;
  storage: ConversationOutboxStorage;
  ready(): boolean;
  blocked(): boolean;
  send(intent: SubmitIntent, options: { readonly canDispatch: () => boolean }): Promise<SubmissionReceipt>;
  retire(ids: readonly string[]): void;
  sender?(): MessageSender | null;
  publish(): void;
}) {
  let entries: readonly ConversationOutboxEntry[] = [];
  let storageError: Error | null = null;
  let generation = 0;
  let disposed = false;
  let draining = false;
  const read = () => {
    try {
      entries = config.storage.read(config.key).map(entry => entry.state === "sending"
        ? { ...entry, state: "unknown" as const } : entry);
      storageError = null;
    } catch (error) {
      storageError = error instanceof Error ? error : new Error(String(error));
    }
  };
  read();
  const commit = (next: readonly ConversationOutboxEntry[]) => {
    config.storage.write(config.key, next);
    entries = next;
    storageError = null;
  };
  const notify = () => { if (!disposed) config.publish(); };
  const drain = async () => {
    if (disposed || draining || !config.ready() || config.blocked()) return;
    draining = true;
    const owner = generation;
    try {
      while (!disposed && owner === generation && config.ready() && !config.blocked()) {
        const head = entries[0];
        if (!head || head.state !== "waiting") break;
        // Persist the attempt before crossing the transport boundary. A reload
        // here loses automatic retry, never duplicates an uncertain execution.
        commit([{ ...head, state: "sending" }, ...entries.slice(1)]);
        notify();
        if (disposed || owner !== generation) break;
        if (!config.ready() || config.blocked()) {
          // Publishing custody can synchronously revoke dispatch readiness.
          // No transport call has happened, so keep this input retryable.
          commit(entries.map(entry => entry.intent.commandId === head.intent.commandId
            ? { ...entry, state: "waiting" as const } : entry));
          notify();
          break;
        }
        try {
          await config.send({ ...head.intent, target: { type: "enqueue-follow-up", key: config.key } },
            { canDispatch: () => !disposed && owner === generation && config.ready() });
          if (disposed || owner !== generation) break;
          commit(entries.filter(entry => entry.intent.commandId !== head.intent.commandId));
          notify();
        } catch (error) {
          if (disposed || owner !== generation) break;
          // A live server event can confirm and retire this entry before its
          // RPC settles. Its lost ACK must not strand the next waiting input.
          if (!entries.some(entry => entry.intent.commandId === head.intent.commandId)) continue;
          const state = error instanceof SubmissionNotDispatchedError ? "waiting"
            : error instanceof SubmissionOutcomeUnknownError ? "unknown" : "failed";
          commit(entries.map(entry => entry.intent.commandId === head.intent.commandId
            ? { ...entry, state, error: state === "waiting" ? undefined : error instanceof Error ? error.message : String(error) } : entry));
          notify();
          break;
        }
      }
    } catch (error) {
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
    config.retire(entries.map(entry => entry.intent.commandId));
    // Account replacement retires every old asynchronous result.
    entries = [];
    read();
    notify();
    wake();
  });
  return {
    hasPending: () => entries.length > 0,
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
    admit(intent: SubmitIntent): SubmissionReceipt {
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
      const duplicate = entries.find(entry => entry.intent.commandId === intent.commandId || entry.intent.clientMessageId === intent.clientMessageId);
      if (duplicate && JSON.stringify(duplicate.intent) !== JSON.stringify(intent)) throw new Error("The queued message identity already belongs to another input");
      if (!duplicate && entries.length >= 50) throw new Error("The local message queue is full. Reconnect or remove a waiting message.");
      if (!duplicate) commit([...entries, { intent, state: "waiting", sender: config.sender?.() }]);
      notify();
      wake();
      return { commandId: intent.commandId, clientMessageId: intent.clientMessageId,
        hostId: config.key.hostId, threadId: config.key.threadId, turnId: null,
        acceptedAt: Date.now(), replayed: false, disposition: "local-queue" };
    },
    remove(id: string): boolean {
      const entry = entries.find(item => item.intent.commandId === id);
      if (!entry) return false;
      if (entry.state === "sending") throw new Error("Wait for this message's delivery result before removing it");
      commit(entries.filter(item => item !== entry));
      config.retire([id]);
      notify(); wake();
      return true;
    },
    reconcile(clientIds: ReadonlySet<string>) {
      const next = entries.filter(entry => entry.state === "waiting" || !clientIds.has(entry.intent.clientMessageId));
      if (next.length === entries.length) return;
      const retired = entries.filter(entry => !next.includes(entry)).map(entry => entry.intent.commandId);
      try {
        commit(next);
        config.retire(retired);
        // Reconciliation may run inside snapshot derivation. Publish and drain
        // after the new authoritative snapshot has replaced the previous one.
        const owner = generation;
        queueMicrotask(() => {
          if (disposed || owner !== generation) return;
          notify(); wake();
        });
      } catch (error) { storageError = error instanceof Error ? error : new Error(String(error)); }
    },
    dispose() { disposed = true; generation++; stop(); },
  };
}
