type PreparationReason = "missing-thread-id" | "thread-read-failed" | "missing-workspace" | "invalid-workspace" | "projectless-workspace-create-failed";

export class ExecutionPreparationError extends Error {
  constructor(readonly reason: PreparationReason) {
    super(reason);
  }
}

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_:-]{1,160}$/.test(value) ? value : undefined;
}

/** Emit only bounded correlation fields. Native errors may include paths or payload. */
export function reportExecutionPreparationFailure(
  method: unknown,
  params: Record<string, unknown>,
  incarnation: string,
  reason: PreparationReason | "policy-failed" | "connection-replaced",
  elapsedMs: number,
) {
  console.warn("[opencraft-execution-preparation]", JSON.stringify({
    method: method === "thread/start" || method === "turn/start" ? method : undefined,
    threadId: safeId(params.threadId),
    clientMessageId: safeId(params.clientUserMessageId),
    incarnation,
    reason,
    elapsedMs: Math.round(elapsedMs),
    forwarded: false,
  }));
}
