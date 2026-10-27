import type { ConnectorRuntime } from "./runtime";
import { ConnectorCapabilityRuntime, type ConnectorCapabilitySearchRequest } from "./capability-runtime";
import { ConnectorError, objectInput } from "./lifetime";
import type { ConnectorScope } from "./contract";

export const CONNECTOR_SESSION_TOOLS = [
  { name: "connectors_search_tools", description: "Search integrations explicitly selected for this conversation. Returns compact summaries and opaque references. Load exact schemas with the schema lookup tool.", inputSchema: { type: "object", properties: { query: { type: "string" }, connectorId: { type: "string" }, cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, additionalProperties: false } },
  { name: "connectors_get_tool", description: "Load exact schemas and temporary invocation handles for one to four references returned by tool search.", inputSchema: { type: "object", properties: { toolRefs: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } } }, required: ["toolRefs"], additionalProperties: false } },
  { name: "connectors_call_tool", description: "Invoke a selected integration with an exact handle. Writes and unknown effects require one-shot human approval. An uncertain external effect must never be automatically retried.", inputSchema: { type: "object", properties: { handle: { type: "string" }, arguments: { type: "object", additionalProperties: true } }, required: ["handle", "arguments"], additionalProperties: false } },
];

export async function callConnectorTool(runtime: ConnectorRuntime, catalog: ConnectorCapabilityRuntime, scope: ConnectorScope, name: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
  const input = objectInput(raw);
  if (name === "connectors_search_tools") {
    if (Object.keys(input).some(k => !["query", "connectorId", "cursor", "limit"].includes(k))
      || ["query", "connectorId", "cursor"].some(k => input[k] !== undefined && typeof input[k] !== "string")
      || (input.limit !== undefined && typeof input.limit !== "number")) throw new ConnectorError("invalid-input");
    return catalog.search(scope, input as ConnectorCapabilitySearchRequest, signal);
  }
  if (name === "connectors_get_tool") {
    if (Object.keys(input).some(k => k !== "toolRefs") || !Array.isArray(input.toolRefs)) throw new ConnectorError("invalid-input");
    return catalog.detail(scope, input.toolRefs, signal);
  }
  if (name === "connectors_call_tool") {
    if (typeof input.handle !== "string" || Object.keys(input).some(k => k !== "handle" && k !== "arguments")) throw new ConnectorError("invalid-input");
    const value = await runtime.invoke(scope, input.handle, input.arguments, signal);
    if (new TextEncoder().encode(JSON.stringify(value) ?? "null").byteLength > 262144) throw new ConnectorError("tool-output-too-large");
    return value;
  }
  throw new ConnectorError("unavailable");
}
