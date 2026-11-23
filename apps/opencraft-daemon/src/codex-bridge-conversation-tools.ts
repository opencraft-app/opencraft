import { CONVERSATION_TOOLS, THREAD_ORCHESTRATION_TOOLS } from "@opencraft/appserver-protocol/collaboration";

type ToolContext = { threadId: string; turnId: string; callId: string };
type ToolName = { namespace: string | null; name: string };
type NativeTool = (context: ToolContext, tool: ToolName, args: unknown, signal: AbortSignal) => Promise<unknown> | null;

const text = (success: boolean, value: unknown) => ({
  success,
  contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
});
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The conversation tools a bridge Thread is created with, as the local Host declares them. */
export function codexBridgeCreationTools(): Record<string, unknown>[] {
  return CONVERSATION_TOOLS.map((tool) => ({ type: "function", ...tool }));
}

/**
 * Host dispatcher for a bridge Thread's dynamic tools: conversation tools are
 * answered by the collaboration owner with the local Host's result shape;
 * orchestration tools (declared by Threads created on the legacy path) point
 * the model to the execution CLI, which is how bridge turns orchestrate,
 * instead of reaching a client that cannot run them; anything else goes to
 * `next` (browser tools) and then to the clients.
 */
export function codexBridgeConversationTools(
  collaboration: { tool(threadId: string, turnId: string, name: string, args: Record<string, unknown>): unknown },
  next?: NativeTool,
): NativeTool {
  return (context, tool, args, signal) => {
    if (!tool.namespace && CONVERSATION_TOOLS.some((candidate) => candidate.name === tool.name))
      return Promise.resolve()
        .then(() => collaboration.tool(context.threadId, context.turnId, tool.name, record(args)))
        .then(
          (value) => text(true, value),
          (error: unknown) => {
            const status = typeof record(error).status === "number" ? record(error).status : 503;
            if (record(error).code === "HISTORY_RESPONSE_TOO_LARGE")
              return text(false, {
                error: "A history item exceeds the bounded read size limit.",
                status: 413,
                code: "HISTORY_RESPONSE_TOO_LARGE",
                retryable: false,
              });
            return text(false, {
              error:
                "Conversation operation unavailable or unauthorized. Inspect the original receipt before retrying.",
              status,
            });
          },
        );
    if (!tool.namespace && THREAD_ORCHESTRATION_TOOLS.some((candidate) => candidate.name === tool.name))
      return Promise.resolve(
        text(false, {
          error:
            "Thread orchestration tools are unavailable in this conversation; use the execution-scoped `opencraft thread` CLI from this turn's shell (see `opencraft thread --help`).",
          status: 503,
        }),
      );
    return next ? next(context, tool, args, signal) : null;
  };
}
