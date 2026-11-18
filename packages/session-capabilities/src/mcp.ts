import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CapabilityBindings } from "./bindings.js";
import { SessionCapabilities, type CapabilitySession, type CapabilityTool } from "./index.js";
import { capabilityResultToMcp } from "./content.js";

export { capabilitySigningKey, sessionCapabilityToken } from "./credentials.js";
import { sessionCapabilityToken,executionCliSourceSession } from "./credentials.js";
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
  private readonly pending = new Map<string, { tools: readonly CapabilityTool[]; expiresAt: number }>();
  private readonly memoryBindings = new Map<string, CapabilitySession>();
  private readonly executionReservations = new Map<string, {
    bound: Promise<CapabilitySession>; resolve(session: CapabilitySession): void;
    session?: CapabilitySession; scope?: CapabilitySession; expiresAt: number; memoryOnly?: boolean;
  }>();
  constructor(readonly capabilities: SessionCapabilities, private readonly key: Buffer, private readonly bindings?: CapabilityBindings,
    private readonly options: { descriptorPath?: string; retainEndpoint?: boolean; authorizeInput?: (session: CapabilitySession, inputId: string) => boolean;
      authorizeExecution?: (session:CapabilitySession)=>Promise<void>;
      orchestration?: (session: CapabilitySession, request: Record<string, unknown>) => Promise<unknown>;
      threadCli?: (session: CapabilitySession, request: Record<string,unknown>) => Promise<unknown> } = {}) {
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
  private sign(claims: readonly string[]): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return payload + "." + this.signature(payload).toString("base64url");
  }
  token(session: CapabilitySession): string { return sessionCapabilityToken(this.key, session); }
  private bindingToken(id: string): string { return this.sign(["binding", id]); }
  private authenticate(request: IncomingMessage): { session: CapabilitySession | null; tools?: readonly CapabilityTool[]; reservationId?: string; executionReservation?: Promise<CapabilitySession>; nativeTool?: boolean } | null {
    const auth = request.headers.authorization;
    if (typeof auth !== "string" || auth.length > 4096 || !auth.startsWith("Bearer ")) return null;
    const parts = auth.slice(7).split(".");
    if (parts.length !== 2) return null;
    const signature = Buffer.from(parts[1]!, "base64url"), expected = this.signature(parts[0]!);
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
    try {
      const pair = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
      if (!Array.isArray(pair)) return null;
      const cliRoute=request.url==='/thread-cli'||request.url==='/execution-admission';
      if(pair[0]==='execution-cli')return cliRoute?{session:executionCliSourceSession(this.key,auth.slice(7))}:null;
      if(cliRoute)return null;
      if ((pair[0] === "execution" || pair[0] === 'native-tool') && pair.length === 4) {
        const [_, serverId, threadId, execution] = pair;
        if (![serverId, threadId].every(v => typeof v === "string" && v && v.length <= 512)
          || !execution || typeof execution !== "object" || Array.isArray(execution)
          || Object.keys(execution).some(k => !["executionId", "inputId", "turnId", "incarnation", "callId"].includes(k))
          || Object.values(execution).some(v => typeof v !== "string" || !v || v.length > 512)
          || !execution.inputId && !execution.turnId) return null;
        if (pair[0] === 'native-tool' && (request.url !== '/mcp' || !execution.callId)) return null;
        return { session: Object.freeze({ serverId, threadId, execution: Object.freeze(execution) }), nativeTool: pair[0] === 'native-tool' };
      }
      if (pair.some(v => typeof v !== "string" || !v || v.length > 512)) return null;
      if ((pair[0] === "execution-binding"||pair[0] === "execution-memory-binding") && pair.length === 2) {
        const reservation = pair[0] === "execution-memory-binding" ? this.executionReservations.get(pair[1]) : this.executionReservation(pair[1]);
        if (!reservation || (!reservation.scope && !reservation.session && reservation.expiresAt <= Date.now())) return null;
        return { session: reservation.session ?? null, executionReservation: reservation.bound };
      }
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
    let port = 0;
    if (this.options.retainEndpoint && this.options.descriptorPath) {
      try {
        const info = lstatSync(this.options.descriptorPath);
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 4096)
          throw new Error("Invalid capability endpoint descriptor");
        const endpoint = new URL(JSON.parse(readFileSync(this.options.descriptorPath, "utf8")).url);
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
    const tools = this.capabilities.tools(session);
    if (!this.url || !tools.length) return null;
    const id = session.execution ? undefined : this.bindings?.id(session) ?? [...this.memoryBindings].find(([, s]) => s.serverId === session.serverId && s.threadId === session.threadId)?.[0];
    return this.configuration(id && !session.execution ? this.bindingToken(id) : this.token(session), tools);
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
  /** Creation installs an opaque credential before a Thread ID exists. The Host
   * binds it once to the first attested execution before dispatching that input.
   * Native MCP startup may list tools before thread/start returns; only that
   * read waits for binding. No invocation can run with an unbound credential. */
  private executionReservation(id: string) {
    const existing = this.executionReservations.get(id);
    if (existing) return existing;
    const saved = this.bindings?.execution(id);
    if (!saved) return undefined;
    let resolve!: (session: CapabilitySession) => void;
    const bound = new Promise<CapabilitySession>(done => { resolve = done; });
    const reservation = { bound, resolve, memoryOnly:false, scope: saved.scope, session: saved.session ?? undefined, expiresAt: Infinity };
    if (saved.session) resolve(saved.session);
    this.executionReservations.set(id, reservation);
    return reservation;
  }
  private cancelCredential(token: string): void {
    const credential = this.signature(`Bearer ${token}`).toString('hex');
    for (const controller of this.credentialInvocations.get(credential) ?? []) controller.abort();
    for (const client of this.clients.values()) if (client.credential === credential)
      for (const key of client.requests.keys()) client.transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/cancelled',
        params: { requestId: JSON.parse(key), reason: 'Execution capability retired' } });
  }
  private executionHandle(id: string, reservation: NonNullable<ReturnType<SessionCapabilityMcp["executionReservation"]>>, tools:readonly CapabilityTool[] = []) {
    const token = this.sign([reservation.memoryOnly?"execution-memory-binding":"execution-binding", id]);
    return { configuration: this.configuration(token, tools),
      bindThread: (scope: CapabilitySession) => {
        if (this.executionReservations.get(id) !== reservation || reservation.scope
          || reservation.expiresAt <= Date.now()) throw new Error("Execution capability reservation is unavailable");
        if(!reservation.memoryOnly)this.bindings?.prepareExecution(id, scope);
        reservation.scope = { serverId: scope.serverId, threadId: scope.threadId };
      },
      bind: (session: CapabilitySession) => {
        if (this.executionReservations.get(id) !== reservation || (!reservation.scope && reservation.expiresAt <= Date.now())
          || !session.execution?.inputId || !session.execution.executionId
          || reservation.scope && (reservation.scope.serverId !== session.serverId || reservation.scope.threadId !== session.threadId))
          throw new Error("Execution capability reservation is unavailable");
        if (reservation.session) {
          if (JSON.stringify(reservation.session) !== JSON.stringify(session)) throw new Error("Execution capability reservation is already bound");
          return;
        }
        if (reservation.scope&&!reservation.memoryOnly) this.bindings?.bindExecution(id, session);
        reservation.session = structuredClone(session); reservation.resolve(reservation.session);
      },
      resetBeforeStart: () => {
        if(!reservation.memoryOnly)throw new Error('Only an unstarted bridge binding can reset');
        reservation.session=undefined;
        reservation.bound=new Promise<CapabilitySession>(resolve=>{reservation.resolve=resolve;});
      },
      cancel: () => {
        try { if(!reservation.memoryOnly)this.bindings?.removeExecution(id); }
        finally { this.executionReservations.delete(id); this.cancelCredential(token); }
      },
    };
  }
  prepareExecution(options:{memoryOnly?:boolean;scope?:CapabilitySession}={}) {
    for (const [id, value] of this.executionReservations)
      if (!value.scope && !value.session && value.expiresAt <= Date.now()) this.executionReservations.delete(id);
    // Installed bridge scopes belong to live native sessions, not the pending
    // preparation budget. Idle sessions must not exhaust all future creations.
    if ([...this.executionReservations.values()].filter(v=>!v.memoryOnly||!v.scope).length >= 256) throw new Error("Too many pending execution capability reservations");
    const id = randomUUID();
    let resolve!: (session: CapabilitySession) => void;
    const bound = new Promise<CapabilitySession>(done => { resolve = done; });
    const reservation = { bound, resolve, memoryOnly:options.memoryOnly===true, expiresAt: Date.now() + 60_000, session: undefined as CapabilitySession | undefined,
      scope: undefined as CapabilitySession | undefined };
    this.executionReservations.set(id, reservation);
    return this.executionHandle(id, reservation, options.scope ? this.capabilities.tools(options.scope) : []);
  }
  restoreExecution(scope: CapabilitySession) {
    const id = this.bindings?.executionId(scope);
    const reservation = id ? this.executionReservation(id) : undefined;
    return id && reservation ? this.executionHandle(id, reservation) : null;
  }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("cache-control", "no-store");
    // This dedicated loopback listener uses session bearer auth, never ambient
    // browser cookies or an untrusted callerSessionId in tool arguments.
    if (!["/mcp", "/execution-admission", "/admission", "/orchestration", "/thread-cli"].includes(request.url ?? "")) { response.writeHead(404); response.end(); return; }
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
      const authenticated = currentAuthentication;
      if (record) record.active++;
      try {
      let session = authenticated.session;
      if (!session && authenticated.executionReservation) {
        session = await new Promise<CapabilitySession>((resolve, reject) => {
          const abort = () => reject(new Error("Capability declaration wait was cancelled"));
          if (extra.signal.aborted) { abort(); return; }
          extra.signal.addEventListener("abort", abort, { once: true });
          void authenticated.executionReservation!.then(value => {
            extra.signal.removeEventListener("abort", abort); resolve(value);
          });
        });
      }
      if (session) await this.capabilities.refresh(session);
      const tools = session ? this.capabilities.tools(session) : authenticated.tools ?? [];
      const staged = authenticated.reservationId ? this.pending.get(authenticated.reservationId) : undefined;
      if (tools.length && authenticated.reservationId) this.pending.delete(authenticated.reservationId);
      const visible = tools.length ? tools : staged && staged.expiresAt > Date.now() ? staged.tools : [];
      return { tools: visible.map(({ approval: _approval, ...tool }) => tool) };
      } finally { await finishInvocation(extra.signal, extra.requestId); }
    });
    mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const authenticated = currentAuthentication;
      if (record) record.active++;
      const controller = new AbortController();
      const signal = AbortSignal.any([extra.signal, controller.signal]);
      let active = this.credentialInvocations.get(credential);
      if (!active) this.credentialInvocations.set(credential, active = new Set());
      active.add(controller);
      let stage = 'authentication';
      try {
        const current = authenticateInvocation();
        if (!current || JSON.stringify(current.session) !== JSON.stringify(authenticated.session)) throw new Error("Session capability retired or changed");
        stage = 'binding';
        if (!authenticated.session) throw new Error("Session is not bound");
        const session = authenticated.session;
        // JSON-RPC IDs are local to a client, including clients sharing this
        // execution credential. General MCP invocations get distinct identities;
        // the separate signed native-tool audience already binds one native call.
        // Request IDs and model arguments cannot select that audience.
        const invocation = session.execution && !authenticated.nativeTool ? { ...session, execution: { ...session.execution,
          callId: JSON.stringify([session.execution.callId ?? null, randomUUID()]) } } : session;
        stage = 'dispatch';
        const result = await this.capabilities.call(invocation, request.params.name, request.params.arguments ?? {}, signal);
        stage = 'result';
        return capabilityResultToMcp(result);
      } catch {
        const diagnosticId = this.diagnoseFailure(stage);
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
    this.executionReservations.clear();
    this.clients.clear();
    await Promise.allSettled([...this.calls].map(server => server.close()));
    await new Promise<void>(resolve => { this.server.close(() => resolve()); this.server.closeAllConnections(); });
  }
}
