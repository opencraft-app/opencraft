import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createHash } from "node:crypto";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ConnectorNativeTool } from "@opencraft/connector-core";
import { ConnectorDatabase, ConnectorHostError, record, type StoredConnection } from "./store";
import { mcpEndpoint } from "./mcp-endpoints";
import { connectorFetch } from "./network";
import type { ConnectorOAuth } from "./oauth";

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalJson(entry)]),
  );
  return value;
}

const compareTool = (left: ConnectorNativeTool, right: ConnectorNativeTool) =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

export const toolsDigest = (tools: readonly ConnectorNativeTool[]) => createHash("sha256")
  .update(JSON.stringify(canonicalJson([...tools].sort(compareTool))))
  .digest("hex");

export class ConnectorMcp {
  constructor(private readonly db: ConnectorDatabase, private readonly oauth: ConnectorOAuth,
    private readonly endpoint = mcpEndpoint, private readonly fetchOverride?: typeof fetch) {}
  private async use<T>(id: string, work: (client: Client, row: StoredConnection) => Promise<T>): Promise<T> {
    const before = this.db.get(id); if (!before.enabled) throw new ConnectorHostError("unavailable");
    await this.oauth.refresh(id);
    const row = this.db.get(id); if (row.revision !== before.revision) throw new ConnectorHostError("conflict");
    const endpoint = this.endpoint(row), headers = { ...endpoint.headers };
    const tokens = row.oauth.tokens ? record(row.oauth.tokens) : null;
    if (tokens?.access_token) headers.Authorization = `Bearer ${String(tokens.access_token)}`;
    const options = { requestInit: { headers }, fetch: this.fetchOverride ?? connectorFetch([new URL(endpoint.url).origin], endpoint.private) };
    const transport = endpoint.sse ? new SSEClientTransport(new URL(endpoint.url), options) : new StreamableHTTPClientTransport(new URL(endpoint.url), options);
    const client = new Client({ name: "opencraft", version: "0.1.0" });
    try { await client.connect(transport); return await work(client, row); }
    finally { await client.close().catch(() => undefined); }
  }
  private async inventory(client: Client): Promise<ConnectorNativeTool[]> {
    let cursor: string | undefined; const tools: ConnectorNativeTool[] = [], seen = new Set<string>();
    do {
      const page = await client.listTools({ cursor });
      tools.push(...page.tools.map(tool => ({ name: tool.name, description: tool.description ?? tool.name, readOnly: tool.annotations?.readOnlyHint === true, inputSchema: tool.inputSchema })));
      cursor = page.nextCursor;
      if (tools.length > 256 || (cursor && seen.has(cursor))) throw new ConnectorHostError("unavailable");
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new ConnectorHostError("unavailable");
    return tools.sort(compareTool);
  }
  list(id: string) { return this.use(id, client => this.inventory(client)); }
  call(id: string, revision: number, digest: string, tool: string, input: Record<string, unknown>) {
    return this.use(id, async (client, row) => {
      if (row.revision !== revision) throw new ConnectorHostError("conflict");
      const tools = await this.inventory(client);
      if (toolsDigest(tools) !== digest || !tools.some(item => item.name === tool)) throw new ConnectorHostError("conflict");
      if (this.db.get(id).revision !== revision) throw new ConnectorHostError("conflict");
      return client.callTool({ name: tool, arguments: input }, undefined, { timeout: 90000 });
    });
  }
}
