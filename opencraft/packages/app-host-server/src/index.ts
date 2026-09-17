import {
  APP_HOST_PROTOCOL_VERSION,
  stampLogicalClientFrame,
  routeLogicalClientFrame,
  type AppHostErrorPayload,
  type AppHostToRendererMessage,
  type RendererToAppHostMessage,
} from "@opencraft/app-host-protocol";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";

export interface AppHostServerPort {
  postMessage(message: AppHostToRendererMessage): void;
  subscribe(listener: (message: unknown) => void): () => void;
  start(): void;
  close(): void;
}

export interface AppHostServerOptions {
  readonly logicalClientRouting?: boolean;
  readonly createTransport: (
    hostId: string,
    signal?: AbortSignal,
  ) => DuplexTransport | Promise<DuplexTransport>;
}

interface HostRecord {
  readonly transport: DuplexTransport;
  readonly generation: number;
  readonly unsubscribeMessage: () => void;
  readonly unsubscribeStatus: () => void;
}

interface HostClaim {
  readonly connection: AppHostServerConnection;
  readonly leaseId: string;
  generation: number | null;
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
}

function normalizeError(cause: unknown): AppHostErrorPayload {
  const candidate = cause as { code?: unknown; retryable?: unknown } | null;
  return {
    code: typeof candidate?.code === "string" ? candidate.code : "APP_HOST_FAILURE",
    message: cause instanceof Error ? cause.message : String(cause),
    retryable: candidate?.retryable === true,
  };
}

/** Process-scoped physical Host owner shared by every Renderer connection. */
export class AppHostServer {
  private readonly slots = new Map<string, HostSlot>();
  private readonly connections = new Set<AppHostServerConnection>();
  private generationSequence = 0;
  private connectionSequence = 0;
  private closed = false;
  private closeOperation: Promise<void> | null = null;

  constructor(private readonly options: AppHostServerOptions) {}

  accept(port: AppHostServerPort, connectionId: string): AppHostServerConnection {
    if (this.closed) throw new Error("App Host Server is closed");
    const connection = new AppHostServerConnection(
      this,
      port,
      connectionId,
      `connection:${++this.connectionSequence}`,
    );
    this.connections.add(connection);
    return connection;
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
    for (const slot of this.slots.values()) {
      let removed = false;
      for (const [key, claim] of slot.claims) {
        if (claim.connection !== connection) continue;
        if (this.options.logicalClientRouting && slot.record) {
          void slot.record.transport.send(stampLogicalClientFrame(JSON.stringify({ jsonrpc: "2.0", method: "runtime/client/disconnect" }), key)).catch(() => undefined);
        }
        slot.claims.delete(key);
        removed = true;
      }
      if (removed && slot.claims.size === 0) void this.stopSlot(slot, false);
    }
  }

  async handle(connection: AppHostServerConnection, message: RendererToAppHostMessage): Promise<unknown> {
    if (this.closed || connection.isClosed) throw new Error("App Host connection is closed");
    if (message.type === "host/connect") {
      const record = await this.connectHost(connection, message.hostId, message.leaseId);
      return { hostId: message.hostId, generation: record.generation };
    }
    if (message.type === "host/send") {
      const record = this.requireWritableClaim(
        connection,
        message.hostId,
        message.leaseId,
        message.generation,
      );
      await record.transport.send(this.options.logicalClientRouting
        ? stampLogicalClientFrame(message.frame, this.claimKey(connection, message.leaseId)) : message.frame);
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
    const key = this.claimKey(connection, leaseId);
    let claim = slot.claims.get(key);
    if (claim === undefined) {
      claim = { connection, leaseId, generation: null };
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
      claim.generation = record.generation;
      connection.rememberLease(hostId, leaseId, record.generation);
      return record;
    } catch (cause) {
      if (slot.claims.get(key) === claim) slot.claims.delete(key);
      if (slot.claims.size === 0) void this.stopSlot(slot, false);
      throw cause;
    }
  }

  private async ensureSlotOpen(slot: HostSlot): Promise<HostRecord> {
    for (;;) {
      if (this.closed) throw new Error("App Host Server is closed");
      if (slot.phase === "open" && slot.record?.transport.status.state === "open") {
        return slot.record;
      }
      if (slot.phase === "closing") {
        await slot.closeOperation;
        continue;
      }
      if (slot.phase === "starting") return slot.startOperation!;
      if (slot.phase === "open") {
        await this.stopSlot(slot, true);
        continue;
      }
      return this.startSlot(slot);
    }
  }

  private startSlot(slot: HostSlot): Promise<HostRecord> {
    if (slot.phase !== "idle") throw new Error(`Cannot start Host ${slot.hostId} from ${slot.phase}`);
    slot.phase = "starting";
    const abort = new AbortController();
    slot.startAbort = abort;
    let operation!: Promise<HostRecord>;
    operation = (async () => {
      let transport: DuplexTransport | null = null;
      let record: HostRecord | null = null;
      try {
        transport = await this.options.createTransport(slot.hostId, abort.signal);
        if (this.closed || abort.signal.aborted || slot.claims.size === 0) {
          await transport.close();
          transport = null;
          throw new Error(`Host ${slot.hostId} activation no longer has an owner`);
        }
        const generation = ++this.generationSequence;
        const ownsRecord = () => !this.closed && slot.record === record;
        const publishStatus = (status: TransportStatus) => {
          if (!ownsRecord()) return;
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
        if (this.closed || abort.signal.aborted || slot.claims.size === 0) {
          throw new Error(`Host ${slot.hostId} activation no longer has an owner`);
        }
        slot.phase = "open";
        publishStatus({ state: "open" });
        return record;
      } catch (cause) {
        if (record !== null) {
          if (!this.closed) {
            this.publish(slot.hostId, record.generation, {
              type: "host/status",
              hostId: slot.hostId,
              generation: record.generation,
              status: { state: "failed", reason: cause instanceof Error ? cause.message : String(cause) },
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
    if (slot === undefined || slot.phase !== "open" || record == null) {
      throw new Error(`Host ${hostId} is not connected`);
    }
    if (record.generation !== generation) {
      throw new Error(`Stale Host generation ${generation} for ${hostId}; current is ${record.generation}`);
    }
    const claim = slot.claims.get(this.claimKey(connection, leaseId));
    if (claim?.generation !== generation) throw new Error(`Host lease ${leaseId} does not own ${hostId}`);
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
    if (this.options.logicalClientRouting && slot.record) {
      await slot.record.transport.send(stampLogicalClientFrame(JSON.stringify({ jsonrpc: "2.0", method: "runtime/client/disconnect" }), key));
    }
    slot.claims.delete(key);
    connection.forgetLease(hostId, leaseId, generation);
    if (slot.claims.size === 0) await this.stopSlot(slot, false);
  }

  private publish(hostId: string, generation: number, message: AppHostToRendererMessage): void {
    for (const connection of this.connections) {
      if (!connection.ownsHost(hostId, generation)) continue;
      if (this.options.logicalClientRouting && message.type === "host/frame") {
        const slot = this.slots.get(hostId);
        const ids = [...slot?.claims ?? []].filter(([, claim]) => claim.connection === connection && claim.generation === generation).map(([id]) => id);
        const frame = routeLogicalClientFrame(message.frame, ids);
        if (frame !== null) connection.post({ ...message, frame });
      } else connection.post(message);
    }
  }

  private async stopSlot(slot: HostSlot, force: boolean): Promise<void> {
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
  private readonly unsubscribePort: () => void;
  private receiveOperation = Promise.resolve();
  private ready = false;
  private closed = false;

  constructor(
    private readonly server: AppHostServer,
    private readonly port: AppHostServerPort,
    readonly connectionId: string,
    readonly internalId: string,
  ) {
    this.unsubscribePort = port.subscribe((message) => {
      this.receiveOperation = this.receiveOperation.then(
        () => this.receive(message),
        () => this.receive(message),
      );
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
