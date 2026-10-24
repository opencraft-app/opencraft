import { createConversationKey, type ConversationKey } from "@opencraft/chat-core";
import type { ConversationOutboxEntry, ConversationOutboxStorage } from "@opencraft/chat-runtime";
import { parseConversationDraftDocument } from "@opencraft/workbench-runtime";
import type { ComposerSelections, SubmitIntent } from "@opencraft/composer-core";

const PREFIX = "opencraft.outbox.v1:";
const MAX_BYTES = 512 * 1024;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function decode(raw: string | null, key: ConversationKey): readonly ConversationOutboxEntry[] {
  if (raw === null) return [];
  if (raw.length > MAX_BYTES) throw new Error("The saved local message queue is too large");
  const value: unknown = JSON.parse(raw);
  if (!record(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 50)
    throw new Error("The saved local message queue could not be read");
  return value.entries.map((entry: unknown): ConversationOutboxEntry => {
    if (!record(entry) || !["waiting", "sending", "unknown", "failed"].includes(String(entry.state)) || !record(entry.intent))
      throw new Error("Invalid local message entry");
    const source = entry.intent;
    const target = source.target;
    const document = parseConversationDraftDocument(JSON.stringify({ version: 1, document: source.document }));
    if (!record(target) || !["existing-thread", "enqueue-follow-up", "steer-active-turn"].includes(String(target.type))
      || !record(target.key) || target.key.hostId !== key.hostId || target.key.threadId !== key.threadId
      || typeof source.commandId !== "string" || !source.commandId || typeof source.clientMessageId !== "string" || !source.clientMessageId
      || typeof source.createdAt !== "number" || !Number.isFinite(source.createdAt) || !document
      || !Array.isArray(source.attachments) || source.attachments.length || !Array.isArray(source.context) || source.context.length
      || !record(source.selections) || !record(source.options) || typeof source.options.autoContext !== "boolean")
      throw new Error("Invalid local message payload");
    const selections: Record<string, string | null> = {};
    for (const [field, fieldValue] of Object.entries(source.selections)) {
      if (!["agentId", "model", "mode", "effort", "permissionProfile", "cwd", "serviceTier", "personality"].includes(field)
        || (typeof fieldValue !== "string" && !((field === "permissionProfile" || field === "serviceTier") && fieldValue === null)))
        throw new Error("Invalid local message selections");
      selections[field] = fieldValue;
    }
    const intent: SubmitIntent = {
      commandId: source.commandId, clientMessageId: source.clientMessageId,
      // Disconnected steering is deliberately a next-turn message after recovery.
      target: { type: "enqueue-follow-up", key: createConversationKey(key.hostId, key.threadId) },
      document, attachments: [], context: [], selections: selections as ComposerSelections,
      options: { autoContext: source.options.autoContext,
        ...(typeof source.options.developerInstructions === "string" ? { developerInstructions: source.options.developerInstructions } : {}),
        ...(record(source.options.outputSchema) ? { outputSchema: source.options.outputSchema } : {}),
      }, createdAt: source.createdAt,
    };
    return { intent, state: entry.state as ConversationOutboxEntry["state"],
      ...(typeof entry.error === "string" ? { error: entry.error } : {}),
      ...(record(entry.sender) && entry.sender.kind === "employee" && typeof entry.sender.loginName === "string"
        ? { sender: { kind: "employee", loginName: entry.sender.loginName } } : {}),
    };
  });
}

/** A tab owns unsent input; server/profile/account namespaces never share queues. */
export function createBrowserConversationOutbox(input: {
  storage: Storage;
  scope(): string | null;
}) {
  const listeners = new Set<() => void>();
  let scope = input.scope();
  const prefix = (owner: string) => `${PREFIX}${encodeURIComponent(owner)}:`;
  const storageKey = (key: ConversationKey, profile: number) => {
    if (scope === null) throw new Error("Confirm your account identity before queueing a message");
    return `${prefix(scope)}${encodeURIComponent(JSON.stringify([key.hostId, profile, key.threadId]))}`;
  };
  return {
    forProfile(profile: number): ConversationOutboxStorage {
      return {
        read(key) { return scope === null ? [] : decode(input.storage.getItem(storageKey(key, profile)), key); },
        write(key, entries) {
          const target = storageKey(key, profile);
          if (!entries.length) { input.storage.removeItem(target); return; }
          for (const entry of entries) {
            if (!parseConversationDraftDocument(JSON.stringify({ version: 1, document: entry.intent.document })))
              throw new Error("This message cannot be saved in the local queue. Your draft has been kept.");
          }
          const value = JSON.stringify({ version: 1, entries });
          if (value.length > MAX_BYTES) throw new Error("The local message queue is full. Your draft has been kept.");
          input.storage.setItem(target, value);
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      };
    },
    refreshScope() {
      const next = input.scope();
      if (next === scope) return;
      const previous = scope;
      scope = next;
      // Revoke old readers before notifying them; a late ACK cannot write into
      // another account's namespace. Explicit identity changes clear old input.
      if (previous !== null) {
        try {
          for (let index = input.storage.length - 1; index >= 0; index--) {
            const key = input.storage.key(index);
            if (key?.startsWith(prefix(previous))) input.storage.removeItem(key);
          }
        } catch { /* Scope revocation remains effective when storage is denied. */ }
      }
      for (const listener of listeners) listener();
    },
  };
}
