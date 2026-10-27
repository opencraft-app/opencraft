import type { AppServerClient } from "@opencraft/appserver-client";
import type { DynamicToolCallParams } from "@opencraft/appserver-protocol/generated/v2";
import {
  MCP_APPS_METHOD,
  MCP_APPS_NAMESPACE,
} from "@opencraft/appserver-protocol/mcp-apps";
/** Tools execute through the same authenticated Host lease that owns the turn. */
export function installMcpAppsDynamicToolHandler(
  client: Pick<
    AppServerClient,
    "interceptServerRequest" | "subscribeNotification" | "requestRaw"
  >,
) {
  const calls = new Map<string, AbortController>();
  const stop = client.subscribeNotification((n) => {
    if (n.method === "serverRequest/resolved")
      calls
        .get(String((n.params as { requestId: unknown }).requestId))
        ?.abort();
  });
  const remove = client.interceptServerRequest(async (request, next) => {
    if (request.method !== "item/tool/call") return next();
    const p = request.params as DynamicToolCallParams;
    if (p.namespace !== MCP_APPS_NAMESPACE || p.tool !== "manage")
      return next();
    const abort = new AbortController();
    calls.set(String(request.id), abort);
    try {
      const input = p.arguments;
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Arguments must be an object");
      const result = await client.requestRaw(MCP_APPS_METHOD, input, {
        signal: abort.signal,
      });
      return {
        success: true,
        contentItems: [
          { type: "inputText" as const, text: JSON.stringify(result) },
        ],
      };
    } catch (error) {
      return {
        success: false,
        contentItems: [
          {
            type: "inputText" as const,
            text:
              error instanceof Error
                ? error.message
                : "App operation failed; read state before retrying",
          },
        ],
      };
    } finally {
      calls.delete(String(request.id));
    }
  });
  return () => {
    remove();
    stop();
    for (const c of calls.values()) c.abort();
    calls.clear();
  };
}
