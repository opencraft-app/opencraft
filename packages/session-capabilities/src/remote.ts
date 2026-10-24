import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sessionCapabilityToken } from "./mcp.js";
import type { CapabilityResult, CapabilityTool, SessionCapabilityPort } from "./index.js";

/** Same-uid independent Host attachment. The descriptor is rediscovered for each
 * operation; gateway restarts never create a second capability authority. */
export class RemoteSessionCapabilities implements SessionCapabilityPort {
  private readonly catalog = new Map<string, readonly CapabilityTool[]>();
  constructor(private readonly directory: string, private readonly serverId: string) {}
  private async privateFile(path: string) {
    const info = await stat(path);
    if (!info.isFile() || !process.getuid || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error("Session capability attachment requires owned private files");
    return readFile(path);
  }
  private async connection(threadId: string) {
    const descriptor = JSON.parse((await this.privateFile(join(this.directory, "session-capabilities.json"))).toString());
    const url = new URL(descriptor.url);
    if (descriptor.schemaVersion !== 1 || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/mcp"
      || url.search || url.hash || url.username || url.password) throw new Error("Invalid session capability descriptor");
    const key = await this.privateFile(join(this.directory, "session-capabilities.key"));
    if (key.length !== 32) throw new Error("Invalid session capability key");
    return { url, headers: { Authorization: "Bearer " + sessionCapabilityToken(key, { serverId: this.serverId, threadId }) } };
  }
  private async client<T>(threadId: string, run: (client: Client) => Promise<T>): Promise<T> {
    const { url, headers } = await this.connection(threadId);
    const client = new Client({ name: "opencraft-host", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers, signal: AbortSignal.timeout(30_000) } }));
      return await run(client);
    } finally { await client.close(); }
  }
  tools(threadId: string) { return this.catalog.get(threadId) ?? []; }
  async refresh(threadId: string): Promise<void> {
    this.catalog.delete(threadId);
    if (this.catalog.size >= 256) this.catalog.delete(this.catalog.keys().next().value!);
    // Gateway absence must not break ordinary DSH input without Host tools.
    try { const { tools } = await this.client(threadId, client => client.listTools()); this.catalog.set(threadId, tools.map(tool => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }))); }
    catch { /* Calls and trusted IM admission still fail closed. */ }
  }
  async call(threadId: string, name: string, args: unknown, signal: AbortSignal): Promise<CapabilityResult> {
    signal.throwIfAborted();
    const result = await this.client(threadId, client => client.callTool({ name, arguments: args as Record<string, unknown> }, undefined, { signal }));
    if (!Array.isArray(result.content)) throw new Error("Invalid capability result");
    return { success: result.isError !== true, contentItems: result.content.map(item => {
      if (item.type !== "text" || typeof item.text !== "string") throw new Error("Unsupported capability result");
      return { type: "inputText" as const, text: item.text };
    }) };
  }
  async authorizeInput(threadId: string, inputId: string): Promise<boolean> {
    try {
      const { url, headers } = await this.connection(threadId);
      const response = await fetch(new URL("/admission", url), { method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ inputId }), signal: AbortSignal.timeout(5_000) });
      return response.ok && (await response.json()).allowed === true;
    } catch { return false; }
  }
}
