import { projectCodexMessageResult, projectCodexMessageNotification } from "./codex-message-projection.js";
import type { AttachmentRef } from "@opencraft/appserver-protocol";

type Value = Record<string, unknown>;
function object(value: unknown): Value { return value && typeof value === "object" && !Array.isArray(value) ? value as Value : {}; }

function string(value: unknown): string { return typeof value === "string" ? value : ""; }

export interface MessageAttachmentReader {
  list(threadId: string, clientMessageId: string): readonly AttachmentRef[];
}

function displayAttachments(refs: readonly AttachmentRef[]): Value[] {
  return refs.map(ref => ({
    id: ref.id,
    name: ref.name,
    mimeType: ref.mimeType,
    size: ref.size,
    ...(ref.location.kind === "host-file" ? { path: ref.location.path } : { url: ref.location.url }),
  }));
}

function withAttachments(value: Value, refs: readonly AttachmentRef[]): Value {
  if (refs.length === 0) return value;
  const existing = Array.isArray(value.attachments) ? value.attachments : [];
  const identities = new Set(existing.map(entry => string(object(entry).id)));
  return {
    ...value,
    attachments: [...existing, ...displayAttachments(refs).filter(entry => !identities.has(string(entry.id)))],
  };
}

export function projectCodexAttachmentResult(reader: MessageAttachmentReader, method: string, params: Value, result: unknown): unknown {
  return projectCodexMessageResult((threadId, clientId, value) => withAttachments(value, reader.list(threadId, clientId)), method, params, result);
}
export function projectCodexAttachmentNotification(reader: MessageAttachmentReader, message: Value): Value {
  return projectCodexMessageNotification((threadId, clientId, value) => withAttachments(value, reader.list(threadId, clientId)), message);
}
