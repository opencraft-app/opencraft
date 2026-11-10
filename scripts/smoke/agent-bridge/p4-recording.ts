/** Allowlisted public ACP proof. Never persist native error text, content or config. */
import { createHash } from "node:crypto";
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function opaque(value: unknown): string | undefined {
  return typeof value === "string" ? `id:${createHash("sha256").update(value).digest("hex").slice(0, 20)}` : undefined;
}
export function publicP4Frame(value: unknown): Record<string, unknown> {
  const frame = record(value);
  const id = typeof frame.id === "number" ? frame.id : opaque(frame.id);
  const base = { jsonrpc: "2.0", ...(id === undefined ? {} : { id }) };
  const params = record(frame.params);
  if (frame.method === "initialize") return { ...base, method: "initialize", params: { protocolVersion: 1 } };
  if (frame.method === "session/steer") {
    return { ...base, method: "session/steer", params: typeof params.sessionId !== "string" ? {} : {
      sessionId: opaque(params.sessionId), expectedRequestId: opaque(params.expectedRequestId),
      clientUserMessageId: opaque(params.clientUserMessageId),
    } };
  }
  if (frame.method === "session/update") {
    const update = record(params.update);
    const meta = record(update._meta);
    const kind = ["user_message_chunk", "tool_call", "tool_call_update"].includes(String(update.sessionUpdate))
      ? update.sessionUpdate : "other";
    const status = ["pending", "in_progress", "completed", "failed"].includes(String(update.status)) ? update.status : undefined;
    return { ...base, method: "session/update", params: { sessionId: opaque(params.sessionId), update: {
      sessionUpdate: kind, messageId: opaque(update.messageId ?? meta["codebuddy.ai/messageId"]),
      toolCallId: opaque(update.toolCallId), status,
      _meta: { "codebuddy.ai/conversationRequestId": opaque(meta["codebuddy.ai/conversationRequestId"]) },
    } } };
  }
  if (frame.error !== undefined) {
    const error = record(frame.error);
    const code = typeof error.code === "number" ? error.code : -32603;
    const probe = code === -32602 && [error.message, error.data].some((v) =>
      typeof v === "string" && v.includes('Steer operation requires "sessionId"'));
    const details = record(error.data).details;
    const http500 = typeof details === "string" && /status code 500/i.test(details);
    return { ...base, error: { code, category: probe ? "codebuddy-steer-session-required" : http500 ? "native-http-500" : "native-rpc-error" } };
  }
  const result = record(frame.result);
  return { ...base, result: { steered: result.steered === true, ownerRequestId: opaque(result.ownerRequestId) } };
}
