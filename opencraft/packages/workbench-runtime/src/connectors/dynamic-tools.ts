import type { AppServerClient } from "@opencraft/appserver-client";
import type { DynamicToolCallParams, DynamicToolCallResponse, DynamicToolSpec } from "@opencraft/appserver-protocol/generated/v2";
import type { ConnectorRuntime } from "./runtime";
import { ConnectorError, objectInput } from "./lifetime";
import { ConnectorCapabilityRuntime, type ConnectorCapabilitySearchRequest } from "./capability-runtime";

export const CONNECTOR_DYNAMIC_TOOL_NAMESPACE = "connectors";
const SEARCH_TOOLS = "search_tools";
const GET_TOOL = "get_tool";
const CALL_TOOL = "call_tool";

export const OPENCRAFT_CONNECTOR_DYNAMIC_TOOLS: readonly DynamicToolSpec[] = Object.freeze([
  {
    type: "namespace",
    name: CONNECTOR_DYNAMIC_TOOL_NAMESPACE,
    description: "Discover and invoke external integrations explicitly selected for this conversation.",
    tools: [
      { type: "function", name: SEARCH_TOOLS, description: "Search the bounded capability catalog selected for this conversation. Returns compact summaries and opaque tool references, never every JSON schema. Continue with nextCursor or load exact schemas with get_tool.", inputSchema: { type: "object", properties: { query: { type: "string" }, connectorId: { type: "string" }, cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, additionalProperties: false }, deferLoading: true },
      { type: "function", name: GET_TOOL, description: "Load exact schemas and temporary invocation handles for one to four tool references returned by search_tools.", inputSchema: { type: "object", properties: { toolRefs: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } } }, required: ["toolRefs"], additionalProperties: false }, deferLoading: true },
      { type: "function", name: CALL_TOOL, description: "Call a selected integration tool using an exact handle from get_tool. Cannot authorize, select accounts or bypass revoked access.", inputSchema: { type: "object", properties: { handle: { type: "string" }, arguments: { type: "object", additionalProperties: true } }, required: ["handle", "arguments"], additionalProperties: false }, deferLoading: true },
    ],
  },
]);

const CONNECTOR_TOOLS = new Set([SEARCH_TOOLS, GET_TOOL, CALL_TOOL]);

function searchInput(value: Record<string, unknown>): ConnectorCapabilitySearchRequest {
  if (Object.keys(value).some(key => !["query", "connectorId", "cursor", "limit"].includes(key))) throw new ConnectorError("invalid-input");
  if (value.query !== undefined && typeof value.query !== "string") throw new ConnectorError("invalid-input");
  if (value.connectorId !== undefined && typeof value.connectorId !== "string") throw new ConnectorError("invalid-input");
  if (value.cursor !== undefined && typeof value.cursor !== "string") throw new ConnectorError("invalid-input");
  if (value.limit !== undefined && typeof value.limit !== "number") throw new ConnectorError("invalid-input");
  return value as ConnectorCapabilitySearchRequest;
}

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
      let value: unknown;
      if (params.tool === SEARCH_TOOLS) {
        value = await capabilities.search(scope, searchInput(input), abort.signal);
      } else if (params.tool === GET_TOOL) {
        if (Object.keys(input).some(key => key !== "toolRefs") || !Array.isArray(input.toolRefs)) throw new ConnectorError("invalid-input");
        value = await capabilities.detail(scope, input.toolRefs, abort.signal);
      } else {
        if (typeof input.handle !== "string" || Object.keys(input).some(k => k !== "handle" && k !== "arguments")) throw new ConnectorError("invalid-input");
        value = await runtime.invoke(scope, input.handle, input.arguments, abort.signal);
      }
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
