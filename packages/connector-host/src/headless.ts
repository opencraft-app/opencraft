import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ActorAccess } from "@opencraft/access-control/actor-access";
import type { ActorContext } from "@opencraft/identity-core/actors";
import type { CapabilitySession, SessionCapabilities } from "@opencraft/session-capabilities";
import { ConnectorRuntime, ConnectorCapabilityRuntime, ConnectorApprovalQueue, ConnectorError, objectInput, CONNECTOR_SESSION_TOOLS, callConnectorTool } from "@opencraft/connector-runtime";
import { ManagedConnectorService } from "./service";
import { ConnectorHostError } from "./store";

interface Grant { context: ActorContext; hostId: string; threadId: string; ids: string[]; connectionIds: string[]; authorized(): boolean }
interface Owner {
  physical: ManagedConnectorService;
  runtime: ConnectorRuntime;
  catalog: ConnectorCapabilityRuntime;
  approvals: ConnectorApprovalQueue;
  registrations: Map<string, () => Promise<void>>;
}
const sessionKey = (serverId: string, threadId: string) => JSON.stringify([serverId, threadId]);
const text = (value: unknown) => { if (typeof value !== "string" || !value || value.length > 256) throw new ConnectorError("invalid-input"); return value; };
const MANAGEMENT = new Set(["list", "save", "delete", "setEnabled", "probe", "oauth/start", "oauth/status", "oauth/cancel"]);

/** Headless owns logical execution; the existing physical service alone owns credentials and OAuth.
 * Configuration is durable. Current human/session consent and pending write approvals are not.
 */
export class HeadlessConnectors {
  private readonly owners = new Map<string, Owner>();
  private readonly grants = new Map<string, Grant>();
  private readonly operations = new Map<string, symbol>();
  private readonly unregister: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private readonly directory: string, private readonly access: ActorAccess,
    private readonly hosts: Readonly<Record<string, string>>, capabilities: SessionCapabilities,
    private readonly admitted: (actorId: string) => boolean = () => true,
    private readonly createPhysical = (path: string) => new ManagedConnectorService(path),
    private readonly resolveServer?: (hostId: string, threadId: string) => string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.unregister = capabilities.register({ id: "opencraft.connectors", formatResult: value => ({ success: !(value && typeof value === "object" && "isError" in value && value.isError === true), contentItems: [{ type: "inputText", text: JSON.stringify(value) ?? "null" }] }), tools: session => {
      return this.grant(session) ? CONNECTOR_SESSION_TOOLS : [];
    }, call: async (session, name, args, signal) => {
      const grant = this.grant(session);
      if (!grant) throw new ConnectorError("authorization-required");
      const owner = this.owners.get(grant.context.actorId)!;
      const value = await callConnectorTool(owner.runtime, owner.catalog, grant, name, args, signal);
      if (this.grant(session) !== grant) throw new ConnectorError("authorization-required");
      return value;
    } });
    this.timer = setInterval(() => { for (const [key, grant] of this.grants) if (!this.valid(grant)) this.release(key, grant); }, 500);
    this.timer.unref();
  }
  private current(context: ActorContext) {
    try { return !this.closed && this.access.store.isCurrent(context) && this.access.store.get(context.actorId)?.kind === "human" && this.admitted(context.actorId); }
    catch { return false; }
  }
  private valid(grant: Grant) { try { return this.current(grant.context) && grant.authorized(); } catch { return false; } }
  private grant(session: CapabilitySession) {
    const key = sessionKey(session.serverId, session.threadId), grant = this.grants.get(key);
    if (!grant) return null;
    if (!this.valid(grant)) { this.release(key, grant); return null; }
    return this.selectedIds(grant).length ? grant : null;
  }
  private selectedIds(grant: Grant) {
    return this.owners.get(grant.context.actorId)?.runtime.getSnapshot().connections
      .filter(c => c.hostId === grant.hostId && ["ready", "partial"].includes(c.phase) && grant.connectionIds.includes(c.connectionId) && grant.ids.includes(c.connectorId))
      .map(c => c.connectorId) ?? [];
  }
  private release(key: string, grant: Grant) {
    this.grants.delete(key);
    const owner = this.owners.get(grant.context.actorId);
    owner?.catalog.releaseScope(grant); owner?.runtime.releaseScope(grant);
  }
  private owner(context: ActorContext) {
    if (!this.current(context)) throw new ConnectorError("authorization-required");
    let owner = this.owners.get(context.actorId);
    if (!owner) {
      if (this.owners.size >= 128) throw new ConnectorError("unavailable");
      const physical = this.createPhysical(join(this.directory, createHash("sha256").update(context.actorId).digest("hex") + ".sqlite"));
      const approvals = new ConnectorApprovalQueue();
      const runtime = new ConnectorRuntime({ getSession: () => null, subscribe: () => () => {} }, 30000, { approvals, invocationTimeoutMs: 120000 });
      owner = { physical, runtime, approvals, catalog: new ConnectorCapabilityRuntime(runtime), registrations: new Map() };
      this.owners.set(context.actorId, owner);
    }
    return owner;
  }
  private host(hostId: string) { if (!Object.hasOwn(this.hosts, hostId)) throw new ConnectorError("unavailable"); return this.hosts[hostId]!; }
  private server(hostId: string, threadId: string) { this.host(hostId); return this.resolveServer?.(hostId, threadId) ?? this.host(hostId); }
  private state(context: ActorContext, hostId: string) {
    const owner = this.owner(context); this.host(hostId);
    return { ...owner.physical.list(), connections: owner.runtime.getSnapshot().connections.filter(c => c.hostId === hostId),
      selections: [...this.grants.entries()].filter(([key, g]) => g.context.actorId === context.actorId && g.hostId === hostId && this.grant({ serverId: this.server(hostId, g.threadId), threadId: g.threadId }) && this.grants.has(key)).map(([, g]) => ({ threadId: g.threadId, connectorIds: this.selectedIds(g) })),
      approvals: owner.approvals.getSnapshot().filter(a => a.hostId === hostId) };
  }
  async dispatch(context: ActorContext, hostId: string, method: string, raw: unknown, authorized: () => boolean = () => this.current(context)) {
    if (!authorized()) throw new ConnectorError("authorization-required");
    this.host(hostId); const owner = this.owner(context), input = objectInput(raw);
    if (method === "state") return this.state(context, hostId);
    if (method.startsWith("connectors/managed/")) {
      if (!MANAGEMENT.has(method.slice("connectors/managed/".length))) throw new ConnectorError("unavailable");
      const value = await owner.physical.handle(method, input);
      if (!this.current(context)) throw new ConnectorError("authorization-required");
      return value;
    }
    if (method === "connect") {
      const id = text(input.id), key = JSON.stringify([context.actorId, hostId, id]), operation = Symbol();
      this.operations.set(key, operation);
      const row = owner.physical.list().instances.find(row => row.id === id);
      if (!row) throw new ConnectorError("unavailable");
      if (!owner.registrations.has(id)) {
        const unregister = owner.runtime.register(id, { id, title: row.title, contributions: [{ id: "managed-tools", kind: "tools", prepare: async preparation => {
          const inventory = await owner.physical.tools(id, preparation.signal);
          preparation.signal.throwIfAborted();
          return { tools: inventory.tools,
            subscribeInvalidated: listener => owner.physical.subscribe(changed => { if (changed === id) listener(); }),
            checkAccess: async scope => {
              const grant = this.grants.get(sessionKey(this.server(scope.hostId, scope.threadId), scope.threadId));
              return !!grant && grant.context.actorId === context.actorId && this.valid(grant) && owner.physical.list().instances.some(row => row.id === id && row.revision === inventory.revision && row.enabled && row.authorization === "configured");
            },
            call: (tool, args, scope) => owner.physical.handle("connectors/managed/call", { id, revision: inventory.revision, digest: inventory.digest, tool, arguments: args }, scope.signal),
            dispose() {},
          };
        } }] });
        owner.registrations.set(id, unregister);
      }
      try {
        const connection = await owner.runtime.connect(id, hostId, crypto.randomUUID());
        if (!this.current(context) || !authorized() || this.operations.get(key) !== operation) {
          await owner.runtime.disconnect(connection.connectionId); throw new ConnectorError("cancelled");
        }
        return this.state(context, hostId);
      } finally { if (this.operations.get(key) === operation) this.operations.delete(key); }
    }
    if (method === "disconnect") {
      const id = text(input.id);
      this.operations.delete(JSON.stringify([context.actorId, hostId, id]));
      for (const c of owner.runtime.getSnapshot().connections) if (c.hostId === hostId && c.connectorId === id) await owner.runtime.disconnect(c.connectionId);
      return this.state(context, hostId);
    }
    if (method === "select") {
      const threadId = text(input.threadId), id = text(input.id);
      if (typeof input.enabled !== "boolean") throw new ConnectorError("invalid-input");
      const key = sessionKey(this.server(hostId, threadId), threadId), existing = this.grants.get(key);
      if (existing && !this.valid(existing)) this.release(key, existing);
      else if (existing && existing.context.actorId !== context.actorId) throw new ConnectorError("authorization-required");
      const previousGrant = this.grants.get(key);
      const previous = previousGrant ? this.selectedIds(previousGrant) : [];
      const ids = input.enabled ? [...new Set([...previous, id])] : previous.filter(v => v !== id);
      const connections = owner.runtime.getSnapshot().connections.filter(c => c.hostId === hostId && ids.includes(c.connectorId) && ["ready", "partial"].includes(c.phase));
      if (ids.some(id => !connections.some(c => c.connectorId === id))) throw new ConnectorError("unavailable");
      const grant = { context: Object.freeze({ ...context }), hostId, threadId, ids, connectionIds: connections.map(c => c.connectionId), authorized };
      if (ids.length) {
        if (!this.grants.has(key) && this.grants.size >= 4096) throw new ConnectorError("unavailable");
        owner.runtime.select(grant, connections.map(c => c.connectionId)); this.grants.set(key, grant);
      }
      else if (existing) this.release(key, existing);
      return this.state(context, hostId);
    }
    if (method === "approval") {
      const id = text(input.id), pending = owner.approvals.getSnapshot().find(a => a.id === id && a.hostId === hostId);
      if (!pending || typeof input.allow !== "boolean" || !this.grant({ serverId: this.server(hostId, pending.threadId), threadId: pending.threadId })) throw new ConnectorError("authorization-required");
      owner.approvals.respond(id, input.allow); return this.state(context, hostId);
    }
    throw new ConnectorError("invalid-input");
  }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = new URL(request.url ?? "/", "http://connectors.invalid").pathname;
    if (path !== "/__opencraft_connectors") return false;
    const send = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "private, no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(value)); };
    if (request.method === "GET") { send(200, { protocolVersion: 1, hosts: this.hosts }); return true; }
    const context = this.access.authenticate(request);
    if (!context || !this.current(context)) { send(401, { error: "human_authentication_required" }); return true; }
    const origin = request.headers.origin, trusted = this.access.options.trustedOrigin?.(request);
    if (request.method !== "POST" || request.headers["content-type"]?.split(";")[0] !== "application/json" || typeof origin !== "string" || (!(["http:", "https:"].some(s => origin === s + "//" + request.headers.host)) && origin !== trusted)) { send(403, { error: "same_origin_json_required" }); return true; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 65536) { send(413, { error: "too_large" }); return true; } chunks.push(bytes); }
      if (!this.access.authenticate(request) || !this.current(context)) throw new ConnectorError("authorization-required");
      const value = objectInput(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (Object.keys(value).some(k => !["hostId", "method", "params"].includes(k))) throw new ConnectorError("invalid-input");
      const lease = this.access.lease(request);
      if (!lease) throw new ConnectorError("authorization-required");
      const result = await this.dispatch(context, text(value.hostId), text(value.method), value.params ?? {}, lease.isCurrent);
      if (!this.access.authenticate(request)) throw new ConnectorError("authorization-required");
      send(200, result);
    } catch (error) {
      const code = error instanceof ConnectorError || error instanceof ConnectorHostError ? error.code : "failed";
      send(code === "authorization-required" ? 403 : 400, { error: code });
    }
    return true;
  }
  outcomes() { return [...this.owners.values()].map(o => ({ name: "headless-connectors", status: o.physical.database.outcome.status, appliedVersion: o.physical.database.outcome.appliedVersion, movedAside: o.physical.database.outcome.movedAsidePaths.length > 0 })); }
  async close() {
    this.closed = true; clearInterval(this.timer); this.unregister(); this.operations.clear();
    for (const [key, grant] of this.grants) this.release(key, grant);
    for (const owner of this.owners.values()) { owner.approvals.dispose(); owner.catalog.dispose(); await owner.runtime.dispose(); owner.physical.close(); }
    this.owners.clear();
  }
}
