import {
  APP_HOST_PROTOCOL_VERSION,
  stampLogicalClientFrame,
  routeLogicalClientFrame,
  LOGICAL_CLIENT_FIELD,
  type AppHostErrorPayload,
  type AppHostToRendererMessage,
  type RendererToAppHostMessage,
} from "@opencraft/app-host-protocol";
import { combineAbortSignals, type DuplexTransport, type TransportStatus, type TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Trusted server composition port, not a renderer-supplied identity or public extension ABI. */
export interface WorkbenchRequestIdentity {
  admissionStatus(request: IncomingMessage): 204 | 401 | 403;
  /** Null rejects a connection whose required proof is missing or retired. */
  connectionContext(request: IncomingMessage): TransportSubmissionContext | null;
  /** Owns provider-specific routes after core admission; false leaves the route to the gateway. */
  handle(request: IncomingMessage, response: ServerResponse): boolean | Promise<boolean>;
}

export interface AppHostServerPort {
  postMessage(message: AppHostToRendererMessage): void;
  subscribe(listener: (message: unknown) => void): () => void;
  start(): void;
  close(): void;
}

export interface AppHostServerOptions {
  /** Bounds callers waiting on a physical barrier; never releases that barrier. */
  readonly lifecycleTimeoutMs?: number;
  readonly lifecycleClock?: { setTimeout(callback: () => void, delay: number): unknown; clearTimeout(handle: unknown): void };
  readonly logicalClientRouting?: boolean;
  /** A process-owned Host outlives every Renderer claim and closes with this server. */
  readonly physicalHostLifetime?: "last-claim" | "server";
  readonly createTransport: (
    hostId: string,
    signal?: AbortSignal,
  ) => DuplexTransport | Promise<DuplexTransport>;
}

interface HostRecord {
  readonly transport: DuplexTransport;
  readonly generation: number;
  forwarding: AbortController;
  readonly unsubscribeMessage: () => void;
  readonly unsubscribeStatus: () => void;
}

interface HostClaim {
  readonly connection: AppHostServerConnection;
  readonly leaseId: string;
  generation: number | null;
  readonly forwarding: AbortController;
}

/** One lifecycle authority for one physical Host. Claims exist before startup. */
interface HostSlot {
  readonly hostId: string;
  readonly claims: Map<string, HostClaim>;
  phase: "idle" | "starting" | "open" | "closing";
  record: HostRecord | null;
  startOperation: Promise<HostRecord> | null;
  closeOperation: Promise<void> | null;
  startAbort: AbortController | null;
  resetOperation: Promise<void> | null;
  serviceAdmissions: number;
  lastState: TransportStatus["state"];
}

function normalizeError(cause: unknown): AppHostErrorPayload {
  const candidate = cause as { code?: unknown; retryable?: unknown } | null;
  return {
    code: typeof candidate?.code === "string" ? candidate.code : "APP_HOST_FAILURE",
    message: cause instanceof Error ? cause.message : String(cause),
    retryable: candidate?.retryable === true,
  };
}

function lostHostConnection(status: TransportStatus): Error {
  return Object.assign(new Error(status.reason ?? "Host disconnected during activation"), {
    code: status.failure?.code ?? "APP_HOST_DISCONNECTED",
    retryable: status.failure?.recovery !== "manual",
  });
}

/** Process-scoped physical Host owner shared by every Renderer connection. */
export class AppHostServer {
  private readonly slots = new Map<string, HostSlot>();
  private readonly connections = new Set<AppHostServerConnection>();
  private readonly forwardingAdmissions = new WeakMap<object, () => void>();
  private generationSequence = 0;
  private connectionSequence = 0;
  private closed = false;
  private closeOperation: Promise<void> | null = null;

  constructor(private readonly options: AppHostServerOptions) {
    if (!Number.isFinite(options.lifecycleTimeoutMs ?? 20_000) || (options.lifecycleTimeoutMs ?? 20_000) <= 0)
      throw new RangeError("Host lifecycle timeout must be positive and finite");
  }

  private waitForLifecycle<T>(operation: Promise<T>, stage: "START" | "CLEANUP" | "RESET"): Promise<T> {
    const clock = this.options.lifecycleClock ?? { setTimeout, clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
    return new Promise((resolve, reject) => {
      const timer = clock.setTimeout(() => reject(Object.assign(new Error("The server did not finish connecting. Retry after it recovers."), {
        code: `APP_HOST_${stage}_TIMEOUT`, retryable: false,
      })), this.options.lifecycleTimeoutMs ?? 20_000);
      // Timing out this observer cannot authorize a second physical generation.
      void operation.then(resolve, reject).finally(() => clock.clearTimeout(timer));
    });
  }

  accept(port: AppHostServerPort, connectionId: string, submissionContext: TransportSubmissionContext = { sender: null }): AppHostServerConnection {
    if (this.closed) throw new Error("App Host Server is closed");
    const connection = new AppHostServerConnection(
      this,
      port,
      connectionId,
      `connection:${++this.connectionSequence}`,
      Object.freeze({ ...submissionContext, ...(submissionContext.executionPrincipal ? { executionPrincipal: Object.freeze({ ...submissionContext.executionPrincipal }) } : {}), sender: submissionContext.sender ? Object.freeze({ ...submissionContext.sender }) : null }),
      (connection, message) => this.admitForwarding(connection, message),
    );
    this.connections.add(connection);
    return connection;
  }

  /** Trusted deployment control plane only; not an RPC method or remote kill. */
  async resetHost(hostId: string): Promise<void> {
    const slot = this.slots.get(hostId);
    if (!slot) return;
    if (slot.resetOperation) return slot.resetOperation;
    // Install the barrier before notifying renderers. Reconnects wait before
    // acquiring their new claim; old activation/send operations lose ownership.
    const operation = Promise.resolve().then(async () => {
      slot.lastState = "closed";
      slot.startAbort?.abort();
      if (slot.record) this.publish(hostId, slot.record.generation, {
        type: "host/status", hostId, generation: slot.record.generation,
        status: { state: "closed", reason: "Connection settings changed" },
      });
      slot.claims.clear();
      await this.stopSlot(slot, true);
    }).finally(() => { if (slot.resetOperation === operation) slot.resetOperation = null; });
    slot.resetOperation = operation;
    return operation;
  }

  hostState(hostId: string): string {
    const slot = this.slots.get(hostId);
    return slot?.resetOperation || slot?.phase === "closing" ? "closing" : slot?.phase === "starting" ? "connecting" : slot?.record?.transport.status.state ?? slot?.lastState ?? "idle";
  }

  /** Trusted explicit connection intent; never grants a Client lease or starts remote work. */
  async ensureHostConnected(hostId: string, assertAdmission?: () => void): Promise<void> {
    if (this.options.physicalHostLifetime !== "server") throw new Error("Service connection requires a server-owned Host lifetime");
    if (this.closed) throw new Error("App Host Server is closed");
    const slot = this.slotFor(hostId);
    while (slot.resetOperation) await this.waitForLifecycle(slot.resetOperation, "RESET");
    if (this.closed) throw new Error("App Host Server is closed");
    slot.serviceAdmissions++;
    try { await this.ensureSlotOpen(slot, assertAdmission); }
    finally { slot.serviceAdmissions--; }
  }

  close(): Promise<void> {
    if (this.closeOperation !== null) return this.closeOperation;
    this.closed = true;
    const operation = (async () => {
      const connections = [...this.connections];
      this.connections.clear();
      for (const connection of connections) connection.detach();
      const slots = [...this.slots.values()];
      for (const slot of slots) {
        slot.claims.clear();
        slot.startAbort?.abort();
      }
      await Promise.allSettled(slots.map((slot) => this.stopSlot(slot, true)));
      this.slots.clear();
    })();
    this.closeOperation = operation;
    return operation;
  }

  removeConnection(connection: AppHostServerConnection): void {
    if (!this.connections.delete(connection)) return;
    connection.takeLeases();
    // Claims may already be gone when an explicit host/disconnect failed to
    // notify the transport. Retain their logical client identities across that
    // failure so closing this WebSocket can still release native Thread state.
    const clients = connection.takeLogicalClients();
    const released = new Set<HostSlot>();
    for (const slot of this.slots.values()) {
      let removed = false;
      for (const [key, claim] of slot.claims) {
        if (claim.connection !== connection) continue;
        slot.claims.delete(key);
        claim.forwarding.abort(lostHostConnection({ state: "closed", reason: "Host claim released" }));
        removed = true;
      }
      if (removed) released.add(slot);
    }
    for (const [clientId, hostId] of clients) {
      if ([...this.connections].some(other => other.hasLogicalClient(clientId))) continue;
      const record = this.slots.get(hostId)?.record;
      if (!record || !this.options.logicalClientRouting) continue;
      void record.transport.send(stampLogicalClientFrame(
        JSON.stringify({ jsonrpc: "2.0", method: "runtime/client/disconnect" }), clientId)).catch(() => undefined);
    }
    for (const slot of released) if (slot.claims.size === 0) void this.stopSlot(slot, false);
  }

  async handle(connection: AppHostServerConnection, message: RendererToAppHostMessage): Promise<unknown> {
    if (this.closed || connection.isClosed) throw new Error("App Host connection is closed");
    if (message.type === "host/connect") {
      const record = await this.connectHost(connection, message.hostId, message.leaseId);
      try {
        this.requireWritableClaim(connection, message.hostId, message.leaseId, record.generation);
      } catch (cause) {
        await this.disconnectClaim(connection, message.hostId, message.leaseId, record.generation);
        throw cause;
      }
      return { hostId: message.hostId, generation: record.generation };
    }
    if (message.type === "host/send") {
      this.forwardingAdmissions.get(message)?.();
      const record = this.requireWritableClaim(
        connection,
        message.hostId,
        message.leaseId,
        message.generation,
      );
      const frame = this.options.logicalClientRouting
        ? stampLogicalClientFrame(message.frame, this.claimKey(connection, message.leaseId)) : message.frame;
      const claim = this.slots.get(message.hostId)!.claims.get(this.claimKey(connection, message.leaseId))!;
      await this.forward(record, frame, connection.submissionContext, claim.forwarding.signal);
      return undefined;
    }
    if (message.type === "host/disconnect") {
      await this.disconnectClaim(connection, message.hostId, message.leaseId, message.generation);
      return undefined;
    }
    throw new Error(`Unsupported App Host message ${String((message as { type?: unknown }).type)}`);
  }

  private claimKey(connection: AppHostServerConnection, leaseId: string): string {
    return `${connection.internalId}\0${leaseId}`;
  }

  private admitForwarding(connection: AppHostServerConnection, message: RendererToAppHostMessage): void {
    if (message.type !== "host/send") return;
    let check: () => void;
    try {
      const { hostId, leaseId, generation } = message;
      const record = this.requireWritableClaim(connection, hostId, leaseId, generation);
      const slot = this.slots.get(hostId)!;
      const key = this.claimKey(connection, leaseId), claim = slot.claims.get(key);
      const native = record.forwarding;
      check = () => {
        if (slot.record !== record || slot.claims.get(key) !== claim
          || record.forwarding !== native || native.signal.aborted) {
          throw lostHostConnection({ state: "closed", reason: "Host forwarding admission retired" });
        }
      };
    } catch (error) { check = () => { throw error; }; }
    // Receipt owns admission. Dequeue-time labels cannot authorize old work
    // across a same-record native close/open or a same-key claim replacement.
    this.forwardingAdmissions.set(message, check);
  }

  /** End the Server's local queue wait when its captured native epoch retires.
   * The provider operation may already be admitted and need never return. Its
   * late result belongs only to this waiter and cannot release a newer epoch. */
  private forward(record: HostRecord, frame: string, context: TransportSubmissionContext, claimSignal: AbortSignal): Promise<void> {
    const signals = combineAbortSignals([record.forwarding.signal, claimSignal]);
    const signal = signals.signal;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (failed: boolean, error?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        signals.dispose();
        if (failed) reject(error); else resolve();
      };
      const abort = () => finish(true, signal.reason instanceof Error ? signal.reason
        : lostHostConnection({ state: "closed" }));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      try {
        const operation = record.transport.sendWithContext
          ? record.transport.sendWithContext(frame, context, signal)
          : record.transport.send(frame, signal);
        void operation.then(() => finish(false), (error) => finish(true, error));
      } catch (error) { finish(true, error); }
    });
  }

  private slotFor(hostId: string): HostSlot {
    let slot = this.slots.get(hostId);
    if (slot !== undefined) return slot;
    slot = {
      hostId,
      claims: new Map(),
      phase: "idle",
      record: null,
      startOperation: null,
      closeOperation: null,
      startAbort: null,
      resetOperation: null,
      serviceAdmissions: 0,
      lastState: "idle",
    };
    this.slots.set(hostId, slot);
    return slot;
  }

  private async connectHost(
    connection: AppHostServerConnection,
    hostId: string,
    leaseId: string,
  ): Promise<HostRecord> {
    if (this.closed || connection.isClosed) throw new Error("App Host connection is closed");
    const slot = this.slotFor(hostId);
    while (slot.resetOperation) await this.waitForLifecycle(slot.resetOperation, "RESET");
    if (this.closed || connection.isClosed) throw new Error("App Host connection is closed");
    const key = this.claimKey(connection, leaseId);
    let claim = slot.claims.get(key);
    if (claim === undefined) {
      claim = { connection, leaseId, generation: null, forwarding: new AbortController() };
      slot.claims.set(key, claim);
    }
    try {
      const record = await this.ensureSlotOpen(slot);
      if (
        this.closed
        || connection.isClosed
        || slot.claims.get(key) !== claim
        || slot.record !== record
      ) {
        throw new Error("App Host connection closed during Host activation");
      }
      if (record.transport.status.state !== "open") throw lostHostConnection(record.transport.status);
      claim.generation = record.generation;
      connection.rememberLease(hostId, leaseId, record.generation);
      connection.rememberLogicalClient(key, hostId);
      return record;
    } catch (cause) {
      if (slot.claims.get(key) === claim) {
        slot.claims.delete(key);
        claim.forwarding.abort(lostHostConnection({ state: "closed", reason: "Host claim activation failed" }));
      }
      if (slot.claims.size === 0) void this.stopSlot(slot, false);
      throw cause;
    }
  }

  private async ensureSlotOpen(slot: HostSlot, assertAdmission?: () => void): Promise<HostRecord> {
    for (;;) {
      if (this.closed) throw new Error("App Host Server is closed");
      // A trusted control request may have waited for a close barrier. Check
      // its current authority immediately before joining/starting a transport.
      assertAdmission?.();
      if (slot.phase === "open" && slot.record?.transport.status.state === "open") {
        return slot.record;
      }
      if (slot.phase === "closing") {
        await this.waitForLifecycle(slot.closeOperation!, "CLEANUP");
        continue;
      }
      if (slot.phase === "starting") return this.waitForLifecycle(slot.startOperation!, "START");
      if (slot.phase === "open") {
        await this.waitForLifecycle(this.stopSlot(slot, true), "CLEANUP");
        continue;
      }
      return this.waitForLifecycle(this.startSlot(slot), "START");
    }
  }

  private startSlot(slot: HostSlot): Promise<HostRecord> {
    if (slot.phase !== "idle") throw new Error(`Cannot start Host ${slot.hostId} from ${slot.phase}`);
    slot.phase = "starting";
    slot.lastState = "connecting";
    const abort = new AbortController();
    slot.startAbort = abort;
    let operation!: Promise<HostRecord>;
    operation = (async () => {
      let transport: DuplexTransport | null = null;
      let record: HostRecord | null = null;
      try {
        transport = await this.options.createTransport(slot.hostId, abort.signal);
        if (this.closed || abort.signal.aborted || (slot.claims.size === 0 && slot.serviceAdmissions === 0)) {
          await transport.close();
          transport = null;
          throw new Error(`Host ${slot.hostId} activation no longer has an owner`);
        }
        const generation = ++this.generationSequence;
        const ownsRecord = () => !this.closed && record !== null && slot.record === record;
        const publishStatus = (status: TransportStatus) => {
          if (!ownsRecord() || record === null) return;
          if (status.state !== "open") record.forwarding.abort(lostHostConnection(status));
          else if (record.forwarding.signal.aborted) record.forwarding = new AbortController();
          slot.lastState = status.state;
          this.publish(slot.hostId, generation, {
            type: "host/status",
            hostId: slot.hostId,
            generation,
            status,
          });
        };
        record = {
          transport,
          generation,
          forwarding: new AbortController(),
          unsubscribeMessage: transport.subscribeMessage((frame) => {
            if (!ownsRecord()) return;
            this.publish(slot.hostId, generation, {
              type: "host/frame",
              hostId: slot.hostId,
              generation,
              frame,
            });
          }),
          unsubscribeStatus: transport.subscribeStatus(publishStatus),
        };
        slot.record = record;
        publishStatus({ state: "connecting" });
        await transport.connect(abort.signal);
        if (this.closed || abort.signal.aborted || (slot.claims.size === 0 && slot.serviceAdmissions === 0)) {
          throw new Error(`Host ${slot.hostId} activation no longer has an owner`);
        }
        if (transport.status.state !== "open") throw lostHostConnection(transport.status);
        slot.phase = "open";
        publishStatus({ state: "open" });
        return record;
      } catch (cause) {
        slot.lastState = abort.signal.aborted ? "closed" : "failed";
        if (record !== null) {
          record.forwarding.abort(cause);
          if (!this.closed) {
            this.publish(slot.hostId, record.generation, {
              type: "host/status",
              hostId: slot.hostId,
              generation: record.generation,
              status: { state: "failed", reason: cause instanceof Error ? cause.message : String(cause),
                ...(record.transport.status.failure ? { failure: record.transport.status.failure } : {}),
              },
            });
          }
          record.unsubscribeMessage();
          record.unsubscribeStatus();
          if (slot.record === record) slot.record = null;
          await record.transport.close().catch(() => undefined);
        } else if (transport !== null) {
          await transport.close().catch(() => undefined);
        }
        if (slot.phase === "starting") slot.phase = "idle";
        throw cause;
      } finally {
        if (slot.startOperation === operation) slot.startOperation = null;
        if (slot.startAbort === abort) slot.startAbort = null;
      }
    })();
    slot.startOperation = operation;
    return operation;
  }

  private requireWritableClaim(
    connection: AppHostServerConnection,
    hostId: string,
    leaseId: string,
    generation: number,
  ): HostRecord {
    const slot = this.slots.get(hostId);
    const record = slot?.record;
    if (slot === undefined || slot.resetOperation || slot.phase !== "open" || record == null) {
      throw new Error(`Host ${hostId} is not connected`);
    }
    if (record.generation !== generation) {
      throw new Error(`Stale Host generation ${generation} for ${hostId}; current is ${record.generation}`);
    }
    const claim = slot.claims.get(this.claimKey(connection, leaseId));
    if (claim?.generation !== generation) throw new Error(`Host lease ${leaseId} does not own ${hostId}`);
    if (record.transport.status.state !== "open") throw lostHostConnection(record.transport.status);
    return record;
  }

  private async disconnectClaim(
    connection: AppHostServerConnection,
    hostId: string,
    leaseId: string,
    generation: number,
  ): Promise<void> {
    const slot = this.slots.get(hostId);
    const key = this.claimKey(connection, leaseId);
    const claim = slot?.claims.get(key);
    if (slot === undefined || claim === undefined || claim.generation !== generation) {
      throw new Error(`Host lease ${leaseId} does not own ${hostId}`);
    }
    const record = slot.record;
    slot.claims.delete(key);
    claim.forwarding.abort(lostHostConnection({ state: "closed", reason: "Host claim released" }));
    connection.forgetLease(hostId, leaseId, generation);
    try {
      if (this.options.logicalClientRouting && record) {
        await record.transport.send(stampLogicalClientFrame(JSON.stringify({ jsonrpc: "2.0", method: "runtime/client/disconnect" }), key));
        connection.forgetLogicalClient(key);
      }
    } finally {
      // A late notification cannot remove a successor claim. stopSlot rechecks
      // all remaining claims and preserves service-owned physical lifetimes.
      if (slot.claims.size === 0) await this.stopSlot(slot, false);
    }
  }

  private publish(hostId: string, generation: number, message: AppHostToRendererMessage): void {
    for (const connection of this.connections) {
      if (!connection.ownsHost(hostId, generation)) continue;
      if (this.options.logicalClientRouting && message.type === "host/frame") {
        const slot = this.slots.get(hostId);
        const claims = [...slot?.claims ?? []].filter(([, claim]) => claim.connection === connection && claim.generation === generation);
        const ids = claims.map(([id]) => id);
        const frame = routeLogicalClientFrame(message.frame, ids);
        const payload = JSON.parse(message.frame) as Record<string, unknown>;
        const target = payload[LOGICAL_CLIENT_FIELD];
        // Requests and responses require an owner. Only untargeted
        // notifications may fan out across admitted leases.
        if (target === undefined && payload.id !== undefined && payload.id !== null) continue;
        const leaseId = target === undefined ? undefined : claims.find(([id]) => id === target)?.[1].leaseId;
        if (frame !== null) connection.post({ ...message, frame, ...(leaseId === undefined ? {} : { leaseId }) });
      } else connection.post(message);
    }
  }

  private async stopSlot(slot: HostSlot, force: boolean): Promise<void> {
    if (!force && this.options.physicalHostLifetime === "server") return;
    if (!force && slot.claims.size > 0) return;
    if (slot.phase === "closing") {
      await slot.closeOperation;
      return;
    }
    if (slot.phase === "starting") {
      if (force) slot.startAbort?.abort();
      await slot.startOperation?.catch(() => undefined);
      if (!force && slot.claims.size > 0) return;
      await this.stopSlot(slot, force);
      return;
    }
    if (slot.phase !== "open" || slot.record === null) return;
    const record = slot.record;
    slot.phase = "closing";
    slot.record = null;
    record.forwarding.abort(lostHostConnection({ state: "closed", reason: "Host generation retired" }));
    record.unsubscribeMessage();
    record.unsubscribeStatus();
    for (const connection of this.connections) connection.forgetHost(slot.hostId, record.generation);
    let operation!: Promise<void>;
    operation = record.transport.close().finally(() => {
      if (slot.closeOperation === operation) slot.closeOperation = null;
      if (slot.phase === "closing") slot.phase = "idle";
    });
    slot.closeOperation = operation;
    await operation;
  }
}

interface OwnedLease {
  readonly hostId: string;
  readonly leaseId: string;
  readonly generation: number;
}

export class AppHostServerConnection {
  private readonly leases = new Map<string, OwnedLease>();
  private readonly logicalClients = new Map<string, string>();
  private readonly unsubscribePort: () => void;
  private readonly receiveOperations = new Map<string, Promise<void>>();
  private ready = false;
  private closed = false;

  constructor(
    private readonly server: AppHostServer,
    private readonly port: AppHostServerPort,
    readonly connectionId: string,
    readonly internalId: string,
    readonly submissionContext: TransportSubmissionContext = { sender: null },
    private readonly admitForwarding: (connection: AppHostServerConnection, message: RendererToAppHostMessage) => void = () => {},
  ) {
    this.unsubscribePort = port.subscribe((value) => {
      const message = typeof value === "object" && value !== null && "type" in value && value.type === "host/send"
        ? { ...value } : value;
      // A reachability probe must never queue behind Host activation or sends.
      if (this.ready && !this.closed && typeof message === "object" && message !== null
        && "type" in message && message.type === "connection/probe"
        && "requestId" in message && typeof message.requestId === "string"
        && message.requestId.length > 0 && message.requestId.length <= 4096) {
        this.post({ type: "response", requestId: message.requestId, ok: true, result: null });
        return;
      }
      // Claim control is owned by the slot, not by the previous RPC's I/O queue.
      // Otherwise a hung close/send can prevent even the admission deadline
      // from starting. Writable frame ordering remains on the per-host queue.
      if (this.ready && !this.closed && typeof message === "object" && message !== null
        && "type" in message && (message.type === "host/connect" || message.type === "host/disconnect")) {
        void this.receive(message);
        return;
      }
      // hello establishes connection authority synchronously. Thereafter only
      // messages for the same Host require ordering; a slow Host must not
      // block another Host sharing this socket.
      if (typeof message === "object" && message !== null && "type" in message && message.type === "hello") {
        void this.receive(message);
        return;
      }
      if (!this.ready) return;
      const hostId = typeof message === "object" && message !== null && "hostId" in message && typeof message.hostId === "string"
        ? message.hostId : "";
      if (typeof message === "object" && message !== null && "type" in message && message.type === "host/send") {
        this.admitForwarding(this, message as RendererToAppHostMessage);
      }
      const operation = (this.receiveOperations.get(hostId) ?? Promise.resolve()).then(
        () => this.receive(message),
        () => this.receive(message),
      );
      this.receiveOperations.set(hostId, operation);
      const clear = () => { if (this.receiveOperations.get(hostId) === operation) this.receiveOperations.delete(hostId); };
      void operation.then(clear, clear);
    });
    port.start();
  }

  get isClosed(): boolean { return this.closed; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribePort();
    this.port.close();
    this.server.removeConnection(this);
  }

  detach(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribePort();
    this.port.close();
    this.leases.clear();
    this.logicalClients.clear();
  }

  post(message: AppHostToRendererMessage): void {
    if (!this.closed) this.port.postMessage(message);
  }

  rememberLease(hostId: string, leaseId: string, generation: number): void {
    this.leases.set(`${hostId}\0${leaseId}`, { hostId, leaseId, generation });
  }

  forgetLease(hostId: string, leaseId: string, generation: number): void {
    const key = `${hostId}\0${leaseId}`;
    if (this.leases.get(key)?.generation === generation) this.leases.delete(key);
  }

  rememberLogicalClient(clientId: string, hostId: string): void {
    this.logicalClients.set(clientId, hostId);
  }

  forgetLogicalClient(clientId: string): void {
    this.logicalClients.delete(clientId);
  }

  hasLogicalClient(clientId: string): boolean {
    return this.logicalClients.has(clientId);
  }

  takeLogicalClients(): Map<string, string> {
    const result = new Map(this.logicalClients);
    this.logicalClients.clear();
    return result;
  }

  forgetHost(hostId: string, generation: number): void {
    for (const [key, lease] of this.leases) {
      if (lease.hostId === hostId && lease.generation === generation) this.leases.delete(key);
    }
  }

  ownsHost(hostId: string, generation: number): boolean {
    for (const lease of this.leases.values()) {
      if (lease.hostId === hostId && lease.generation === generation) return true;
    }
    return false;
  }

  takeLeases(): OwnedLease[] {
    const result = [...this.leases.values()];
    this.leases.clear();
    return result;
  }

  private async receive(value: unknown): Promise<void> {
    if (this.closed || typeof value !== "object" || value === null) return;
    const message = value as RendererToAppHostMessage;
    if (message.type === "hello") {
      if (this.ready) return;
      if (message.protocolVersion !== APP_HOST_PROTOCOL_VERSION || message.rendererId !== this.connectionId) {
        this.close();
        return;
      }
      this.ready = true;
      this.post({
        type: "ready",
        protocolVersion: APP_HOST_PROTOCOL_VERSION,
        connectionId: this.connectionId,
        services: ["appserver"],
        capabilities: { connectionProbe: true },
      });
      return;
    }
    if (!this.ready || !("requestId" in message)) return;
    try {
      const result = await this.server.handle(this, message);
      this.post({ type: "response", requestId: message.requestId, ok: true, result });
    } catch (cause) {
      this.post({
        type: "response",
        requestId: message.requestId,
        ok: false,
        error: normalizeError(cause),
      });
    }
  }
}
