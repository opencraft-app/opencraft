import type { AppServerConnection, JsonRpcRequest } from "../types/appserver.ts";

export function abortUnroutedTurnStart(
  message: JsonRpcRequest,
  connection: AppServerConnection,
  reason = "requestUnrouted",
): unknown | null {
  const threadId = message.params?.["threadId"];
  if (message.method !== "turn/start" || typeof threadId !== "string") return null;
  const execution = connection.threadExecution?.abortRequest(
    threadId,
    connection,
    message.id,
    reason,
  ) ?? null;
  connection.threadWriteLease?.release(threadId, connection);
  return execution;
}
