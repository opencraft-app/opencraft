import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sessionCapabilityToken } from "./mcp.js";
import { nativeToolCapabilityToken, hostGitToken, type HostGitSource } from './credentials.js';
import type { CapabilityExecution, CapabilityResult, CapabilityTool, SessionCapabilityPort } from "./index.js";
import { capabilityResultFromMcp } from "./content.js";

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
  private async connection(threadId: string, execution?: CapabilityExecution, nativeTool = false) {
    const descriptor = JSON.parse((await this.privateFile(join(this.directory, "session-capabilities.json"))).toString());
    const url = new URL(descriptor.url);
    if (descriptor.schemaVersion !== 1 || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/mcp"
      || url.search || url.hash || url.username || url.password) throw new Error("Invalid session capability descriptor");
    const key = await this.privateFile(join(this.directory, "session-capabilities.key"));
    if (key.length !== 32) throw new Error("Invalid session capability key");
    return { url, headers: { Authorization: "Bearer " + (nativeTool ? nativeToolCapabilityToken : sessionCapabilityToken)(key, { serverId: this.serverId, threadId, execution }) } };
  }
  private async client<T>(threadId: string, run: (client: Client, transport: StreamableHTTPClientTransport) => Promise<T>, execution?: CapabilityExecution, nativeTool = false, signal?: AbortSignal): Promise<T> {
    const { url, headers } = await this.connection(threadId, execution, nativeTool);
    const client = new Client({ name: "opencraft-host", version: "1" });
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers, signal: AbortSignal.timeout(30_000) } });
    try {
      signal?.throwIfAborted(); await client.connect(transport, { signal }); signal?.throwIfAborted();
      return await run(client, transport);
    } finally {
      const cleanup = setTimeout(() => { void client.close().catch(() => {}); }, 2000); cleanup.unref();
      try { await transport.terminateSession().catch(() => {}); }
      finally { clearTimeout(cleanup); await client.close(); }
    }
  }
  tools(threadId: string) { return this.catalog.get(threadId) ?? []; }
  /** Recheck the original signed input source at the current owned gateway,
   * without converting a general MCP credential into execution authority. */
  async authorizeExecution(threadId: string, credential: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const { url } = await this.connection(threadId);
    const response = await fetch(new URL('/execution-admission', url), { method: 'POST', redirect: 'error',
      headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' }, body: '{}',
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    await response.body?.cancel(); if (!response.ok) throw Error('Execution admission refused');
    signal.throwIfAborted();
  }
  /** Compiled native owner only: no retries, no account selector, no clear Git secrets. */
  async hostGit(threadId:string,source:HostGitSource,signal?:AbortSignal):Promise<unknown> {
    const {url}=await this.connection(threadId);
    const key=await this.privateFile(join(this.directory,'session-capabilities.key'));
    const token=hostGitToken(key,{serverId:this.serverId,threadId,source});
    const response=await fetch(new URL('/host-git',url),{method:'POST',redirect:'error',
      headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)});
    if(!response.ok){await response.body?.cancel();throw Error('git_execution_unavailable');}
    // The native Server owns this bounded reply; reject malformed/oversized data.
    let size=0;const chunks:Uint8Array[]=[];
    for await(const chunk of response.body!){size+=chunk.length;if(size>16384)throw Error('git_execution_unavailable');chunks.push(chunk);}
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  async refresh(threadId: string, execution?: CapabilityExecution, signal?: AbortSignal): Promise<void> {
    this.catalog.delete(threadId);
    if (this.catalog.size >= 256) this.catalog.delete(this.catalog.keys().next().value!);
    // Gateway absence must not break ordinary DSH input without Host tools.
    try { const { tools } = await this.client(threadId, client => client.listTools(undefined, { signal }), execution, false, signal); signal?.throwIfAborted(); this.catalog.set(threadId, tools.map(tool => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }))); }
    catch { /* Calls and trusted IM admission still fail closed. */ }
  }
  async call(threadId: string, name: string, args: unknown, signal: AbortSignal, execution?: CapabilityExecution): Promise<CapabilityResult> {
    signal.throwIfAborted();
    const result = await this.client(threadId, async (client, transport) => {
      // SDK cancellation rejects the logical request before the provider has
      // settled. Keep the original JSON HTTP send alive until its terminal
      // reply, before terminating this short-lived client session. The gateway
      // sends a cancellation envelope only after physical provider settlement.
      const send = transport.send.bind(transport);
      let physicalReply: Promise<void> | undefined;
      transport.send = async (message, options) => {
        if (!Array.isArray(message) && 'method' in message && message.method === 'tools/call') {
          signal.throwIfAborted(); physicalReply = send(message, options); return physicalReply;
        }
        return send(message, options);
      };
      try { return await client.callTool({ name, arguments: args as Record<string, unknown> }, undefined, { signal }); }
      finally { await physicalReply?.catch(() => {}); }
    }, execution, !!execution?.callId, signal);
    signal.throwIfAborted();
    return capabilityResultFromMcp(result);
  }
  async authorizeInput(threadId: string, inputId: string): Promise<boolean> {
    try {
      const { url, headers } = await this.connection(threadId);
      const response = await fetch(new URL("/admission", url), { method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ inputId }), signal: AbortSignal.timeout(5_000) });
      return response.ok && (await response.json() as { allowed?: unknown }).allowed === true;
    } catch { return false; }
  }
  /** The Host retains the native tool call while a replacement gateway starts.
   * Rediscover the private endpoint and replay the same immutable call identity. */
  async orchestration(threadId: string, request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const deadline = Date.now() + 15_000;
    let backoff = 50;
    while (true) {
      signal.throwIfAborted();
      try {
        const { url, headers } = await this.connection(threadId);
        const response = await fetch(new URL("/orchestration", url), { method: "POST", headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(request), signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(5_000, deadline - Date.now())))]) });
        const body = await response.json() as { result?: unknown; error?: string };
        if (response.ok) return body.result;
        if (response.status < 500) throw Object.assign(new Error(body.error ?? "Orchestration denied"), { terminal: true });
      } catch (error) {
        if ((error as { terminal?: boolean }).terminal || signal.aborted) throw error;
      }
      if (Date.now() >= deadline) throw new Error("Orchestration gateway reconnect window exhausted; inspect the original operation before retrying");
      await delay(Math.min(backoff, deadline - Date.now()), undefined, { signal }); backoff = Math.min(1_000, backoff * 2);
    }
  }
}
