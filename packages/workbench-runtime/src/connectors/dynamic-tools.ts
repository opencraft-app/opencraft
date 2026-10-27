import type { AppServerClient } from "@opencraft/appserver-client";
import type { DynamicToolCallParams, DynamicToolCallResponse, DynamicToolSpec } from "@opencraft/appserver-protocol/generated/v2";
import type { ConnectorRuntime } from "./runtime";
import { ConnectorError, objectInput } from "./lifetime";
import { ConnectorCapabilityRuntime } from "./capability-runtime";
import { CONNECTOR_SESSION_TOOLS, callConnectorTool } from "@opencraft/connector-runtime";

export const CONNECTOR_DYNAMIC_TOOL_NAMESPACE = "connectors";
const SEARCH_TOOLS = "search_tools";
const GET_TOOL = "get_tool";
const CALL_TOOL = "call_tool";

export const OPENCRAFT_CONNECTOR_DYNAMIC_TOOLS: readonly DynamicToolSpec[] = Object.freeze([
  {
    type: "namespace",
    name: CONNECTOR_DYNAMIC_TOOL_NAMESPACE,
    description: "Discover and invoke external integrations explicitly selected for this conversation.",
    tools: CONNECTOR_SESSION_TOOLS.map(tool => ({ type: "function" as const, ...tool, name: tool.name.slice("connectors_".length), deferLoading: true })),
  },
]);

const CONNECTOR_TOOLS = new Set([SEARCH_TOOLS, GET_TOOL, CALL_TOOL]);

export function installConnectorDynamicToolHandler(
  client: Pick<AppServerClient, "interceptServerRequest" | "subscribeNotification">,
  runtime: ConnectorRuntime,
  options: { readonly hostId: string },
): () => void {
  const calls = new Map<string, AbortController>();
  const capabilities = new ConnectorCapabilityRuntime(runtime);
  const reply = (text: string, success: boolean): DynamicToolCallResponse => ({ success, contentItems: [{ type: "inputText", text }] });
  const removeNotifications = client.subscribeNotification(event => {
    if (event.method === "serverRequest/resolved") {
      const params = event.params as { requestId: string | number };
      calls.get(String(params.requestId))?.abort();
    }
    if (event.method === "thread/closed") {
      const params = event.params as { threadId: string };
      const scope = { hostId: options.hostId, threadId: params.threadId };
      capabilities.releaseScope(scope);
      runtime.releaseScope(scope);
    }
  });
  const removeHandler = client.interceptServerRequest(async (request, next) => {
    if (request.method !== "item/tool/call") return next();
    const params = request.params as DynamicToolCallParams;
    if (params.namespace !== CONNECTOR_DYNAMIC_TOOL_NAMESPACE || !CONNECTOR_TOOLS.has(params.tool)) return next();
    const abort = new AbortController(), id = String(request.id);
    calls.set(id, abort);
    try {
      if (typeof params.threadId !== "string" || !params.threadId) throw new ConnectorError("invalid-input");
      const input = objectInput(params.arguments), scope = { hostId: options.hostId, threadId: params.threadId };
      const value = await callConnectorTool(runtime, capabilities, scope, `connectors_${params.tool}`, input, abort.signal);
      const text = JSON.stringify(value) ?? "null";
      if (new TextEncoder().encode(text).byteLength > 262144) throw new ConnectorError("tool-output-too-large");
      return reply(text, true);
    } catch (error) {
      // Provider errors can contain credentials or callback URLs. Only stable
      // platform error codes reach the model or transcript.
      const code = error instanceof ConnectorError ? error.code : "failed";
      return reply(JSON.stringify({ error: { code } }), false);
    } finally { calls.delete(id); }
  });
  return () => { removeHandler(); removeNotifications(); capabilities.dispose(); for (const abort of calls.values()) abort.abort(); calls.clear(); };
}
