import type { DatabaseSync } from "node:sqlite";
import type { MessageSender } from "@opencraft/appserver-protocol";
import type { ThreadMetadataContext, ThreadMetadataExtension, TransportSubmissionContext } from "@opencraft/appserver-client";
import { OpenCraftMessageSenders } from "./opencraft-message-senders.js";
import { projectThreadMessageResult, projectThreadMessageNotification } from "./thread-message-projection.js";

export type IdentityRecord = Record<string, unknown>;
export const identityRecord = (value: unknown): IdentityRecord => value && typeof value === "object" && !Array.isArray(value) ? value as IdentityRecord : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
export type ThreadMetadataFactory = (database: DatabaseSync, context: ThreadMetadataContext) => ThreadMetadataExtension;

export function assertSubmissionIdentity(context: TransportSubmissionContext): void {
  if (context.sender && (!Number.isFinite(context.validUntil) || Date.now() >= context.validUntil!)) {
    throw new Error("Employee identity expired; reconnect before sending");
  }
  if (context.sender && (context.sender.kind !== "employee" || !/^[A-Za-z0-9._-]{1,128}$/u.test(context.sender.loginName))) {
    throw new Error("Invalid verified sender");
  }
}

/** Host-owned verified sender metadata never enters model input. */
export class ThreadIdentity {
  readonly senders: OpenCraftMessageSenders;
  readonly metadata: ThreadMetadataExtension | null;
  constructor(database: DatabaseSync, port: {
    createMetadata?: ThreadMetadataFactory;
    readMessageIds: ThreadMetadataContext["readMessageIds"];
    notify: ThreadMetadataContext["notify"];
  }) {
    this.senders = new OpenCraftMessageSenders(database);
    this.metadata = port.createMetadata?.(database, {
      getSender: (threadId, messageId) => this.senders.get(threadId, messageId),
      hasSenders: threadId => this.senders.hasEmployees(threadId),
      isInheritedMessage: (threadId, messageId) => this.senders.isInherited(threadId, messageId),
      readMessageIds: port.readMessageIds, notify: port.notify,
    }) ?? null;
  }
  recordSubmission(params: IdentityRecord, context: TransportSubmissionContext): void {
    assertSubmissionIdentity(context);
    const threadId = string(params.threadId), messageId = string(params.clientUserMessageId);
    if (!messageId && !context.sender) return;
    this.senders.record(threadId, messageId, context.sender);
  }
  observeResult(method: string, params: IdentityRecord, result: unknown, sender?: MessageSender | null): void {
    if (method === "thread/fork" && params.excludeTurns !== true) {
      this.senders.cloneThread(string(params.threadId), string(identityRecord(identityRecord(result).thread).id));
    }
    this.metadata?.observeResult(method, params, result, sender);
    if (method === "thread/list") {
      const data = identityRecord(result).data;
      if (Array.isArray(data)) this.metadata?.observeCatalog?.(data.map(row => string(identityRecord(row).id)).filter(Boolean));
    }
  }
  observeNotification(message: IdentityRecord): void { this.metadata?.observeNotification(message); }
  private project = (threadId: string, messageId: string, value: IdentityRecord): IdentityRecord => {
    const { sender: _untrusted, ...rest } = value;
    return { ...rest, sender: this.senders.get(threadId, messageId) };
  };
  projectResult(method: string, params: IdentityRecord, result: unknown): unknown {
    return projectThreadMessageResult(this.project, method, params, result);
  }
  projectNotification(message: IdentityRecord): IdentityRecord { return projectThreadMessageNotification(this.project, message); }
  close(): void { this.metadata?.close(); }
}

/** One bounded history reader for both engines; only native-observed IDs establish participation. */
export async function readThreadMessageIds(request: (method: string, params: IdentityRecord, signal?: AbortSignal) => Promise<unknown>,
  threadId: string, turnId?: string, signal?: AbortSignal): Promise<readonly string[]> {
  const ids: string[] = [], cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 1000; page++) {
    if (signal?.aborted) throw new Error("Participant history read cancelled");
    const value = identityRecord(await request("thread/items/list", {
      threadId, ...(turnId ? { turnId } : {}), ...(cursor ? { cursor } : {}), limit: 1000, sortDirection: "asc",
    }, signal));
    if (!Array.isArray(value.data)) throw new Error("Invalid metadata history page");
    for (const entry of value.data) {
      const item = identityRecord(identityRecord(entry).item);
      if (["userMessage", "UserMessage", "steeringUserMessage"].includes(string(item.type))) {
        const id = string(item.clientId) || string(item.client_id) || string(item.clientUserMessageId);
        if (id) ids.push(id);
      }
    }
    if (value.nextCursor == null) return ids;
    if (typeof value.nextCursor !== "string" || !value.nextCursor || cursors.has(value.nextCursor)) throw new Error("Invalid metadata history cursor");
    cursor = value.nextCursor; cursors.add(cursor);
  }
  throw new Error("Metadata history exceeds reconciliation limit");
}
