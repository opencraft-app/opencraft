import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, openSync, readFileSync, closeSync, writeFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CapabilityBindings } from "./bindings.js";
import { SessionCapabilities, type CapabilitySession, type CapabilityTool } from "./index.js";

/** A stable signing key, never a model-visible global credential. Tokens bind a
 * single server/thread. Domain providers reauthorize independently on each call.
 */
export function capabilitySigningKey(path: string): Buffer {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number | undefined;
  try { fd = openSync(path, "wx", 0o600); writeFileSync(fd, randomBytes(32)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
  const key = readFileSync(path), info = statSync(path);
  if (!info.isFile() || (info.mode & 0o077) || key.length !== 32) throw new Error("Invalid capability signing key");
  return key;
}
export function sessionCapabilityToken(key: Buffer, session: CapabilitySession): string {
  const payload = Buffer.from(JSON.stringify(["session", session.serverId, session.threadId])).toString("base64url");
  return payload + "." + createHmac("sha256", key).update(payload).digest("base64url");
}
export class SessionCapabilityMcp {
  private url: string | undefined;
  private readonly server;
  private readonly calls = new Set<Server>();
  private readonly pending = new Map<string, { tools: readonly CapabilityTool[]; expiresAt: number }>();
  private readonly memoryBindings = new Map<string, CapabilitySession>();
  constructor(readonly capabilities: SessionCapabilities, private readonly key: Buffer, private readonly bindings?: CapabilityBindings,
    private readonly options: { descriptorPath?: string; authorizeInput?: (session: CapabilitySession, inputId: string) => boolean } = {}) {
    this.server = createServer((request, response) => { void this.handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500); response.end();
    }); });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
  }
  private signature(payload: string) { return createHmac("sha256", this.key).update(payload).digest(); }
  private sign(claims: readonly string[]): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return payload + "." + this.signature(payload).toString("base64url");
  }
  token(session: CapabilitySession): string { return sessionCapabilityToken(this.key, session); }
  private bindingToken(id: string): string { return this.sign(["binding", id]); }
  private authenticate(request: IncomingMessage): { session: CapabilitySession | null; tools?: readonly CapabilityTool[]; reservationId?: string } | null {
    const auth = request.headers.authorization;
    if (typeof auth !== "string" || auth.length > 4096 || !auth.startsWith("Bearer ")) return null;
    const parts = auth.slice(7).split(".");
    if (parts.length !== 2) return null;
    const signature = Buffer.from(parts[1]!, "base64url"), expected = this.signature(parts[0]!);
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
    try {
      const pair = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
      if (!Array.isArray(pair) || pair.some(v => typeof v !== "string" || !v || v.length > 512)) return null;
      if (pair[0] === "binding" && pair.length === 2) {
        const session = this.bindings?.get(pair[1]) ?? this.memoryBindings.get(pair[1]);
        if (session) return { session, reservationId: pair[1] };
        const pending = this.pending.get(pair[1]);
        return pending && pending.expiresAt > Date.now() ? { session: null, tools: pending.tools } : null;
      }
      return pair[0] === "session" && pair.length === 3 ? { session: Object.freeze({ serverId: pair[1], threadId: pair[2] }) } : null;
    } catch { return null; }
  }
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", () => { this.server.off("error", reject); resolve(); }); });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Capability listener unavailable");
    this.url = `http://127.0.0.1:${address.port}/mcp`;
    if (this.options.descriptorPath) {
      const temporary = `${this.options.descriptorPath}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify({ schemaVersion: 1, url: this.url }), { mode: 0o600 }); await rename(temporary, this.options.descriptorPath); }
      finally { await rm(temporary, { force: true }); }
    }
  }
  private configuration(token: string, tools: readonly CapabilityTool[]): Record<string, unknown> {
    if (!this.url) throw new Error("Capability listener unavailable");
    const approved = tools.filter(tool => tool.approval === "preauthorized");
    return { url: this.url, http_headers: { Authorization: "Bearer " + token },
      ...(approved.length ? { tools: Object.fromEntries(approved.map(tool => [tool.name, { approval_mode: "approve" }])) } : {}) };
  }
  config(session: CapabilitySession): Record<string, unknown> | null {
    const tools = this.capabilities.tools(session);
    if (!this.url || !tools.length) return null;
    const id = this.bindings?.id(session) ?? [...this.memoryBindings].find(([, s]) => s.serverId === session.serverId && s.threadId === session.threadId)?.[0];
    return this.configuration(id ? this.bindingToken(id) : this.token(session), tools);
  }
  /** Host-only creation reservation. Listing a declaration never authorizes a
   * call; the real native identity must be bound and domain admission committed. */
  prepare(tools: readonly CapabilityTool[]) {
    for (const [id, entry] of this.pending) if (entry.expiresAt <= Date.now()) this.pending.delete(id);
    if (this.pending.size >= 128) throw new Error("Too many pending capability reservations");
    const id = randomUUID();
    this.pending.set(id, { tools: structuredClone(tools), expiresAt: Date.now() + 60_000 });
    return { configuration: this.configuration(this.bindingToken(id), tools),
      bind: (session: CapabilitySession) => {
        const pending = this.pending.get(id);
        if (!pending || pending.expiresAt <= Date.now() || this.bindings?.get(id) || this.memoryBindings.has(id)) throw new Error("Capability reservation expired or already bound");
        if (this.bindings) this.bindings.bind(id, session); else this.memoryBindings.set(id, Object.freeze({ ...session }));
        // Keep declaration-only staging until domain admission is visible.
        // MCP initialization can race the Host's post-create admission commit.
      },
      cancel: () => { this.pending.delete(id); },
    };
  }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("cache-control", "no-store");
    // This dedicated loopback listener uses session bearer auth, never ambient
    // browser cookies or an untrusted callerSessionId in tool arguments.
    if (request.url !== "/mcp" && request.url !== "/admission") { response.writeHead(404); response.end(); return; }
    if (request.headers.origin !== undefined) { response.writeHead(403); response.end(); return; }
    const authenticated = this.authenticate(request);
    if (!authenticated) { response.writeHead(401); response.end(); return; }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    const length = Number(request.headers["content-length"] ?? 0);
    if (!Number.isFinite(length) || length > 64 * 1024) { response.writeHead(413); response.end(); return; }
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { response.writeHead(413); response.end(); return; }
      chunks.push(Buffer.from(chunk));
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { response.writeHead(400); response.end(); return; }
    if (request.url === "/admission") {
      const inputId = (body as { inputId?: unknown } | null)?.inputId;
      if (!authenticated.session || typeof inputId !== "string" || inputId.length > 512 || !inputId.startsWith("actor-input:")
        || !body || typeof body !== "object" || Object.keys(body).some(key => key !== "inputId")) { response.writeHead(400); response.end(); return; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ allowed: this.options.authorizeInput?.(authenticated.session, inputId) === true })); return;
    }
    const mcp = new Server({ name: "opencraft-session", version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = authenticated.session ? this.capabilities.tools(authenticated.session) : authenticated.tools ?? [];
      const staged = authenticated.reservationId ? this.pending.get(authenticated.reservationId) : undefined;
      if (tools.length && authenticated.reservationId) this.pending.delete(authenticated.reservationId);
      const visible = tools.length ? tools : staged && staged.expiresAt > Date.now() ? staged.tools : [];
      return { tools: visible.map(({ approval: _approval, ...tool }) => tool) };
    });
    mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      try {
        if (!authenticated.session) throw new Error("Session is not bound");
        const result = await this.capabilities.call(authenticated.session, request.params.name, request.params.arguments ?? {}, extra.signal);
        return { content: result.contentItems.map(item => ({ type: "text" as const, text: item.text })), isError: !result.success };
      } catch { return { content: [{ type: "text", text: "Capability denied or failed; do not retry an uncertain external effect." }], isError: true }; }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    this.calls.add(mcp);
    response.once("close", () => { this.calls.delete(mcp); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(request, response, body);
  }
  async close(): Promise<void> {
    if (this.options.descriptorPath) {
      try { const value = JSON.parse(await readFile(this.options.descriptorPath, "utf8")); if (value.url === this.url) await rm(this.options.descriptorPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.url = undefined;
    await Promise.allSettled([...this.calls].map(server => server.close()));
    await new Promise<void>(resolve => { this.server.close(() => resolve()); this.server.closeAllConnections(); });
  }
}
