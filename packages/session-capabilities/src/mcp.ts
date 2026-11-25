import { createHmac, randomUUID } from "node:crypto";
import { lstat, readFile, writeFile, rename, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CapabilityBindingStore } from "./bindings.js";
import { SessionCapabilities, type CapabilitySession, type CapabilityTool } from "./index.js";
import { capabilityResultToMcp } from "./content.js";

export { capabilitySigningKey, sessionCapabilityToken } from "./credentials.js";
import { sessionCapabilityToken, signCapabilityClaims, verifyCapabilityToken } from "./credentials.js";
import { CapabilityInvocationFault, CapabilitySessionAuthority, type CapabilityAuthentication, type CapabilityRequestAudience } from "./session-authority.js";

const AUDIENCES = new Map<string, CapabilityRequestAudience>([
  ["/mcp", "mcp"], ["/admission", "session"], ["/orchestration", "session"], ["/thread-cli", "execution-cli"],
  ["/execution-admission", "execution-cli"], ["/host-git", "host-git"], ["/host-environment", "host-environment"],
]);
interface McpClientSession {
  credential: string; server: Server; transport: StreamableHTTPServerTransport;
  authenticate(request: IncomingMessage): void; touched: number; active: number;
  requests: Map<string, { closed: boolean; settled: boolean }>;
}
export class SessionCapabilityMcp {
  private url: string | undefined;
  private failureWindow = { at: 0, count: 0 };
  private diagnoseFailure(stage: string) {
    const now = Date.now();
    if (now - this.failureWindow.at >= 60_000) this.failureWindow = { at: now, count: 0 };
    if (this.failureWindow.count++ >= 100) return null;
    const diagnosticId = randomUUID();
    // No tool arguments, credentials, private identity or exception text.
    console.warn('[session-capability]', JSON.stringify({ event: 'call-failed', diagnosticId, stage }));
    return diagnosticId;
  }
  private readonly server;
  private readonly calls = new Set<Server>();
  private readonly clients = new Map<string, McpClientSession>();
  private readonly credentialInvocations = new Map<string, Set<AbortController>>();
  private readonly authority: CapabilitySessionAuthority;
  constructor(readonly capabilities: SessionCapabilities, private readonly key: Buffer, bindings?: CapabilityBindingStore,
    private readonly options: { descriptorPath?: string; retainEndpoint?: boolean; authorizeInput?: (session: CapabilitySession, inputId: string) => boolean;
      authorizeExecution?: (session:CapabilitySession)=>Promise<void>;
      orchestration?: (session: CapabilitySession, request: Record<string, unknown>) => Promise<unknown>;
      threadCli?: (session: CapabilitySession, request: Record<string,unknown>) => Promise<unknown>;
      hostGit?: (session: CapabilitySession) => Promise<unknown>;
      /** Opaque ENV capsule for the authenticated attachment's receiver key. */
      hostEnvironment?: (session: CapabilitySession, recipient: string) => Promise<unknown> } = {}) {
    this.authority = new CapabilitySessionAuthority(capabilities, bindings);
    this.server = createServer((request, response) => { void this.handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500); response.end();
    }); });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
  }
  get cliEndpoint():string {
    if(!this.url)throw Error('Capability listener unavailable');
    return new URL('/thread-cli',this.url).href;
  }
  private signature(payload: string) { return createHmac("sha256", this.key).update(payload).digest(); }
  private sign(claims: readonly unknown[]): string {
    return signCapabilityClaims(this.key, claims);
  }
  token(session: CapabilitySession): string { return sessionCapabilityToken(this.key, session); }
  private authenticate(request: IncomingMessage): CapabilityAuthentication | null {
    const auth = request.headers.authorization;
    const audience = AUDIENCES.get(request.url ?? "");
    if (!audience || typeof auth !== "string" || auth.length > 4096 || !auth.startsWith("Bearer ")) return null;
    try {
      return this.authority.authenticate(audience, verifyCapabilityToken(this.key, auth.slice(7)));
    } catch { return null; }
  }
  async listen(): Promise<void> {
    let port = 0;
    if (this.options.retainEndpoint && this.options.descriptorPath) {
      try {
        const info = await lstat(this.options.descriptorPath);
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 4096)
          throw new Error("Invalid capability endpoint descriptor");
        const endpoint = new URL(JSON.parse(await readFile(this.options.descriptorPath, "utf8")).url);
        if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/mcp" || !endpoint.port)
          throw new Error("Invalid capability endpoint descriptor");
        port = Number(endpoint.port);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(port, "127.0.0.1", () => { this.server.off("error", reject); resolve(); }); });
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
    const declaration = this.authority.declaration(session);
    return this.url && declaration ? this.configuration(this.sign(declaration.claims), declaration.tools) : null;
  }
  prepare(tools: readonly CapabilityTool[]) {
    const { claims, tools: declared, ...reservation } = this.authority.prepare(tools);
    return { configuration: this.configuration(this.sign(claims), declared), ...reservation };
  }
  private cancelCredential(token: string): void {
    const credential = this.signature(`Bearer ${token}`).toString('hex');
    for (const controller of this.credentialInvocations.get(credential) ?? []) controller.abort();
    for (const client of this.clients.values()) if (client.credential === credential)
      for (const key of client.requests.keys()) client.transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/cancelled',
        params: { requestId: JSON.parse(key), reason: 'Execution capability retired' } });
  }
  private executionHandle({ claims, tools, cancel, ...reservation }: ReturnType<CapabilitySessionAuthority["prepareExecution"]>) {
    const token = this.sign(claims);
    return { configuration: this.configuration(token, tools), ...reservation,
      cancel: () => { try { cancel(); } finally { this.cancelCredential(token); } },
    };
  }
  prepareExecution(options: { memoryOnly?: boolean; scope?: CapabilitySession } = {}) {
    return this.executionHandle(this.authority.prepareExecution(options));
  }
  restoreExecution(scope: CapabilitySession) {
    const reservation = this.authority.restoreExecution(scope);
    return reservation ? this.executionHandle(reservation) : null;
  }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("cache-control", "no-store");
    // This dedicated loopback listener uses session bearer auth, never ambient
    // browser cookies or an untrusted callerSessionId in tool arguments.
    if (!AUDIENCES.has(request.url ?? "")) { response.writeHead(404); response.end(); return; }
    if (request.headers.origin !== undefined) { response.writeHead(403); response.end(); return; }
    let authenticated = this.authenticate(request);
    if (!authenticated) { response.writeHead(401); response.end(); return; }
    const clientId = request.url === '/mcp' ? request.headers['mcp-session-id'] : undefined;
    const clientSession = typeof clientId === 'string' ? this.clients.get(clientId) : undefined;
    if (clientId !== undefined) {
      if (!clientSession) { response.writeHead(404); response.end(); return; }
      if (clientSession.credential !== this.signature(request.headers.authorization!).toString('hex')) { response.writeHead(403); response.end(); return; }
      clientSession.authenticate(request); clientSession.touched = Date.now();
      if (request.method !== 'POST') { await clientSession.transport.handleRequest(request, response); return; }
    }
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
    const current = this.authenticate(request);
    const incoming = (Array.isArray(body) ? body : [body]) as ({ method?: unknown } | null)[];
    const invokes = request.url !== '/mcp' || incoming.some(frame => frame?.method === 'tools/call');
    if (!current || invokes && JSON.stringify(current.session) !== JSON.stringify(authenticated.session)) {
      response.writeHead(401); response.end(); return;
    }
    authenticated = current;
    if (clientSession) clientSession.authenticate(request);
    if(request.url==='/host-git') {
      if(!authenticated.session||!this.options.hostGit){response.writeHead(403);response.end();return;}
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length){response.writeHead(400);response.end();return;}
      try {
        const result=await this.options.hostGit(authenticated.session);
        response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(result));
      }catch{response.writeHead(403);response.end();}
      return;
    }
    if(request.url==='/host-environment') {
      if(!authenticated.session||!this.options.hostEnvironment){response.writeHead(403);response.end();return;}
      const recipient=(body as {recipient?:unknown}|null)?.recipient;
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||typeof recipient!=='string'
        ||!recipient||recipient.length>256||!/^[A-Za-z0-9_-]+$/u.test(recipient)){response.writeHead(400);response.end();return;}
      try {
        const result=await this.options.hostEnvironment(authenticated.session,recipient);
        response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(result));
      }catch{response.writeHead(403);response.end();}
      return;
    }
    if (request.url === "/orchestration" || request.url === "/thread-cli") {
      const callback=request.url==='/thread-cli'?this.options.threadCli:this.options.orchestration;
      if (!authenticated.session || !callback || request.url==='/thread-cli'&&!authenticated.session.execution) { response.writeHead(403); response.end(); return; }
      if (!body || typeof body !== "object" || Array.isArray(body)) { response.writeHead(400); response.end(); return; }
      try {
        const result = await callback(authenticated.session, body as Record<string, unknown>);
        response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ result }));
      } catch (cause) {
        const error = cause as { status?: number; code?: string };
        const status=error.status && error.status>=400 && error.status<=599?error.status:503;
        console.error('[thread-orchestration]',JSON.stringify({event:'capability-request-failed',path:request.url,
          threadId:authenticated.session.threadId,status,outcome:error.status===undefined?'unknown':'rejected'}));
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: typeof error.code === "string" ? error.code : error.status===undefined ? "orchestration_outcome_unknown" : "orchestration_rejected" }));
      }
      return;
    }
    if(request.url==='/execution-admission') {
      if(!authenticated.session?.execution || !this.options.authorizeExecution){response.writeHead(403);response.end();return;}
      try {await this.options.authorizeExecution(authenticated.session);response.writeHead(200);response.end('{}');}
      catch {response.writeHead(403);response.end();}return;
    }
    if (request.url === "/admission") {
      const inputId = (body as { inputId?: unknown } | null)?.inputId;
      if (!authenticated.session || typeof inputId !== "string" || inputId.length > 512 || !inputId.startsWith("actor-input:")
        || !body || typeof body !== "object" || Object.keys(body).some(key => key !== "inputId")) { response.writeHead(400); response.end(); return; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ allowed: this.options.authorizeInput?.(authenticated.session, inputId) === true })); return;
    }
    if (clientSession) {
      const frames = (Array.isArray(body) ? body : [body]) as ({ method?: unknown; id?: unknown } | null)[];
      const admitted = new Set<string>();
      // Admit the entire batch before dispatching any member. IDs of completed
      // members remain reserved until their shared HTTP response has settled.
      for (const frame of frames) if (typeof frame?.method === 'string' && (typeof frame.id === 'string' || typeof frame.id === 'number')) {
        const key = JSON.stringify(frame.id);
        if (admitted.has(key) || clientSession.requests.has(key)) { response.writeHead(409); response.end(); return; }
        admitted.add(key);
      }
      if (clientSession.requests.size + admitted.size > 256) { response.writeHead(429); response.end(); return; }
      const lifetimes: { requestId: string | number; key: string; lifetime: { closed: boolean; settled: boolean } }[] = [];
      for (const frame of frames) if (typeof frame?.method === 'string' && (typeof frame.id === 'string' || typeof frame.id === 'number')) {
        const requestId = frame.id, key = JSON.stringify(requestId), lifetime = { closed: false, settled: false };
        clientSession.requests.set(key, lifetime);
        lifetimes.push({ requestId, key, lifetime });
      }
      response.once('close', () => {
        for (const { requestId, key, lifetime } of lifetimes) {
          if (clientSession.requests.get(key) !== lifetime) continue;
          lifetime.closed = true;
          if (!response.writableEnded) clientSession.transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason: 'Caller disconnected' } });
          if (response.writableEnded || lifetime.settled) clientSession.requests.delete(key);
        }
      });
      await clientSession.transport.handleRequest(request, response, body); return;
    }
    const initializes = !!body && typeof body === 'object' && !Array.isArray(body) && (body as { method?: unknown }).method === 'initialize';
    if (initializes) {
      for (const [id, client] of this.clients) if (!client.active && Date.now() - client.touched > 15 * 60_000) {
        this.clients.delete(id); await client.server.close();
      }
      if (this.calls.size >= 256) { response.writeHead(503); response.end(); return; }
    } else if ((body as { method?: unknown } | null)?.method === 'notifications/cancelled') {
      // JSON-RPC IDs are client-local, including clients sharing credentials.
      response.writeHead(400); response.end(); return;
    }
    let currentAuthentication = authenticated, record: McpClientSession | undefined;
    const finishInvocation = async (signal: AbortSignal, requestId: string | number) => {
      // The SDK suppresses ordinary replies after cancellation. Its JSON HTTP
      // transport still needs a terminal envelope to release that request's
      // response promise/correlations; wait for the provider to settle first.
      if (record && signal.aborted) await record.transport.send({ jsonrpc: '2.0', id: requestId,
        error: { code: -32800, message: 'Capability call cancelled; inspect any uncertain external effect before retrying.' } }).catch(() => {});
      if (record) { record.active--; record.touched = Date.now(); }
      const key = JSON.stringify(requestId), lifetime = record?.requests.get(key);
      if (lifetime) { lifetime.settled = true; if (lifetime.closed) record!.requests.delete(key); }
    };
    const credential = this.signature(request.headers.authorization!).toString('hex');
    const authenticateInvocation = () => this.authenticate(request);
    const mcp = new Server({ name: "opencraft-session", version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
      if (record) record.active++;
      try { return await this.authority.list(currentAuthentication, extra.signal); }
      finally { await finishInvocation(extra.signal, extra.requestId); }
    });
    mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const authenticated = currentAuthentication;
      if (record) record.active++;
      const controller = new AbortController();
      const signal = AbortSignal.any([extra.signal, controller.signal]);
      let active = this.credentialInvocations.get(credential);
      if (!active) this.credentialInvocations.set(credential, active = new Set());
      active.add(controller);
      try {
        const result = await this.authority.call(authenticated, authenticateInvocation,
          request.params.name, request.params.arguments ?? {}, signal);
        return capabilityResultToMcp(result);
      } catch (error) {
        const diagnosticId = this.diagnoseFailure(error instanceof CapabilityInvocationFault ? error.stage : 'result');
        return { content: [{ type: "text", text: "Capability denied or failed; do not retry an uncertain external effect."
          + (diagnosticId ? ` Diagnostic: ${diagnosticId}` : '') }], isError: true };
      }
      finally {
        active.delete(controller);
        if (!active.size) this.credentialInvocations.delete(credential);
        await finishInvocation(signal, extra.requestId);
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: initializes ? randomUUID : undefined, enableJsonResponse: true,
      onsessioninitialized: id => { this.clients.set(id, record!); },
    });
    if (initializes) {
      record = { credential: this.signature(request.headers.authorization!).toString('hex'), server: mcp, transport,
        authenticate: request => { currentAuthentication = this.authenticate(request)!; }, touched: Date.now(), active: 0, requests: new Map() };
      mcp.onclose = () => { if (transport.sessionId) this.clients.delete(transport.sessionId); this.calls.delete(mcp); };
    }
    this.calls.add(mcp);
    response.once("close", () => {
      if (!initializes || !transport.sessionId) { this.calls.delete(mcp); void mcp.close(); }
    });
    await mcp.connect(transport);
    await transport.handleRequest(request, response, body);
  }
  async close(): Promise<void> {
    if (this.options.descriptorPath && !this.options.retainEndpoint) {
      try { const value = JSON.parse(await readFile(this.options.descriptorPath, "utf8")); if (value.url === this.url) await rm(this.options.descriptorPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.url = undefined;
    this.authority.close();
    this.clients.clear();
    await Promise.allSettled([...this.calls].map(server => server.close()));
    await new Promise<void>(resolve => { this.server.close(() => resolve()); this.server.closeAllConnections(); });
  }
}
