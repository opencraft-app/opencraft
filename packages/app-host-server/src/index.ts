import {
  APP_HOST_PROTOCOL_VERSION,
  APP_HOST_SEND_NOT_ADMITTED,
  stampLogicalClientFrame,
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

interface HostPhysical {
  readonly transport: DuplexTransport;
  readonly disposers: (() => void)[];
  readonly logicalClients: Set<HostLogicalClient>;
  readonly logicalFailures: Set<HostLogicalClient>;
  operation: Promise<void> | null;
  failure: Error | null;
}

interface HostLogicalClient {
  readonly key: string;
  readonly hostId: string;
  readonly connection: AppHostServerConnection;
  record: HostRecord | null;
  operation: HostLogicalDisconnect | null;
}

interface HostLogicalDisconnect {
  native: "pending" | "success" | "failure";
  readonly promise: Promise<void>;
  retire(error?: unknown): void;
}

interface HostRecord {
  readonly physical: HostPhysical;
  readonly generation: number;
  forwarding: AbortController;
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
  phase: "idle" | "starting" | "open" | "closing" | "failed";
  record: HostRecord | null;
  startOperation: Promise<HostRecord> | null;
  physical: HostPhysical | null;
  startAbort: AbortController | null;
  resetOperation: Promise<void> | null;
  readonly serviceAdmissions: Set<() => void>;
  lastState: TransportStatus["state"];
}

class HostSendNotAdmittedError extends Error {
  readonly code = APP_HOST_SEND_NOT_ADMITTED;
  readonly retryable: boolean;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.retryable = (cause as { retryable?: unknown } | null)?.retryable !== false;
  }
}

function normalizeError(cause: unknown): AppHostErrorPayload {
  const candidate = cause as { code?: unknown; retryable?: unknown } | null;
  return {
    code: typeof candidate?.code === "string"
      && (candidate.code !== APP_HOST_SEND_NOT_ADMITTED || cause instanceof HostSendNotAdmittedError)
      ? candidate.code : "APP_HOST_FAILURE",
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

function failedPhysicalCleanup(cause: unknown): Error {
  return Object.assign(new Error("The server could not finish disconnecting. Retry after it recovers."), {
    code: "APP_HOST_CLEANUP_FAILED", retryable: false, cause,
  });
}

function failedLogicalCleanup(): Error {
  return Object.assign(new Error("The server could not finish releasing a client. Retry after it recovers."), {
    code: "APP_HOST_LOGICAL_CLEANUP_FAILED", retryable: false,
  });
}

/** Both values are opaque IDs. A separator cannot encode their boundaries. */
function hostScopedKey(hostId: string, identity: string): string {
  return JSON.stringify([hostId, identity]);
}

/** Process-scoped physical Host owner shared by every Renderer connection. */
export class AppHostServer {
  private readonly slots = new Map<string, HostSlot>();
  private readonly connections = new Set<AppHostServerConnection>();
  private readonly connectionCleanup = new Set<AppHostServerConnection>();
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
    connection.start();
    return connection;
  }

  /** Trusted deployment control plane only; not an RPC method or remote kill. */
  async resetHost(hostId: string): Promise<void> {
    const slot = this.slots.get(hostId);
    if (!slot) return;
    if (slot.resetOperation) return slot.resetOperation;
    // Install the barrier before notifying renderers. Reconnects wait before
    // acquiring their new claim; old activation/send operations lose ownership.
    const retryFailedCleanup = slot.phase === "failed";
    const operation = Promise.resolve().then(async () => {
      slot.lastState = "closed";
      slot.startAbort?.abort();
      if (slot.record) this.publish(hostId, slot.record.generation, {
        type: "host/status", hostId, generation: slot.record.generation,
        status: { state: "closed", reason: "Connection settings changed" },
      });
      slot.claims.clear();
      await this.stopSlot(slot, true, retryFailedCleanup);
    }).finally(() => { if (slot.resetOperation === operation) slot.resetOperation = null; });
    slot.resetOperation = operation;
    return operation;
  }

  hostState(hostId: string): string {
    const slot = this.slots.get(hostId);
    if (slot?.phase === "failed") return "failed";
    return slot?.resetOperation || slot?.phase === "closing" ? "closing" : slot?.phase === "starting" ? "connecting" : slot?.record?.physical.transport.status.state ?? slot?.lastState ?? "idle";
  }

  /** Trusted explicit connection intent; never grants a Client lease or starts remote work. */
  async ensureHostConnected(hostId: string, assertAdmission?: () => void): Promise<void> {
    if (this.options.physicalHostLifetime !== "server") throw new Error("Service connection requires a server-owned Host lifetime");
    if (this.closed) throw new Error("App Host Server is closed");
    const slot = this.slotFor(hostId);
    while (slot.resetOperation) await this.waitForLifecycle(slot.resetOperation, "RESET");
    if (this.closed) throw new Error("App Host Server is closed");
    const admission = () => { assertAdmission?.(); };
    slot.serviceAdmissions.add(admission);
    try {
      await this.ensureSlotOpen(slot, admission);
      admission();
    } finally { slot.serviceAdmissions.delete(admission); }
  }

  close(): Promise<void> {
    if (this.closeOperation !== null) return this.closeOperation;
    this.closed = true;
    const slots = [...this.slots.values()];
    const retries = new Set(slots.filter(slot => slot.phase === "failed"));
    const operation = Promise.resolve().then(async () => {
      const connections = new Set([...this.connections, ...this.connectionCleanup]);
      this.connections.clear();
      const errors: unknown[] = [];
      for (const connection of connections) {
        try { connection.detach(); } catch (cause) { errors.push(cause); }
      }
      for (const slot of slots) {
        slot.claims.clear();
        slot.startAbort?.abort();
      }
      const results = await Promise.allSettled(slots.map(slot => this.stopSlot(slot, true, retries.has(slot))));
      for (const result of results) if (result.status === "rejected") errors.push(result.reason);
      if (errors.length) throw failedPhysicalCleanup(new AggregateError(errors));
      this.slots.clear();
    });
    // A later explicit shutdown call may retry retained failed handles, while
    // concurrent callers still share this exact cleanup operation.
    this.closeOperation = operation;
    void operation.catch(() => { if (this.closeOperation === operation) this.closeOperation = null; });
    return operation;
  }

  /** Retired Port handles have no admission authority; shutdown can retry them. */
  trackConnectionCleanup(connection: AppHostServerConnection, pending: boolean): void {
    if (pending) this.connectionCleanup.add(connection);
    else this.connectionCleanup.delete(connection);
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
    for (const client of clients.values()) {
      if ([...this.connections].some(other => other.hasLogicalClient(client.key, client.hostId))) {
        if (client.operation === null) this.forgetLogicalClient(client);
        continue;
      }
      const record = client.record ?? this.slots.get(client.hostId)?.record;
      if (!record || !this.options.logicalClientRouting) continue;
      if (!client.record) { client.record = record; record.physical.logicalClients.add(client); }
      void this.disconnectLogicalClient(client, true).catch(() => undefined);
    }
    for (const slot of released) if (slot.claims.size === 0) void this.stopSlot(slot, false).catch(() => undefined);
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
      let record: HostRecord;
      try {
        this.forwardingAdmissions.get(message)?.();
        record = this.requireWritableClaim(
          connection, message.hostId, message.leaseId, message.generation,
        );
      } catch (cause) {
        // Only this boundary proves that native forwarding never began.
        throw new HostSendNotAdmittedError(cause);
      }
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
        const operation = record.physical.transport.sendWithContext
          ? record.physical.transport.sendWithContext(frame, context, signal)
          : record.physical.transport.send(frame, signal);
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
      physical: null,
      startAbort: null,
      resetOperation: null,
      serviceAdmissions: new Set(),
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
      const record = await this.ensureSlotOpen(slot, () => {
        // A trusted reset may revoke this reservation while it waits on an old
        // physical cleanup. Recheck before joining or starting another owner.
        if (this.closed || connection.isClosed || slot.resetOperation || slot.claims.get(key) !== claim) {
          throw new Error("App Host connection closed during Host activation");
        }
      });
      if (
        this.closed
        || connection.isClosed
        || slot.claims.get(key) !== claim
        || slot.record !== record
      ) {
        throw new Error("App Host connection closed during Host activation");
      }
      if (record.physical.transport.status.state !== "open") throw lostHostConnection(record.physical.transport.status);
      if (record.physical.logicalFailures.size) throw failedLogicalCleanup();
      claim.generation = record.generation;
      connection.rememberLease(hostId, leaseId, record.generation);
      if (this.options.logicalClientRouting) connection.rememberLogicalClient(key, hostId, record);
      return record;
    } catch (cause) {
      if (slot.claims.get(key) === claim) {
        slot.claims.delete(key);
        claim.forwarding.abort(lostHostConnection({ state: "closed", reason: "Host claim activation failed" }));
      }
      if (slot.claims.size === 0) void this.stopSlot(slot, false).catch(() => undefined);
      throw cause;
    }
  }

  private async ensureSlotOpen(slot: HostSlot, assertAdmission?: () => void): Promise<HostRecord> {
    for (;;) {
      if (this.closed) throw new Error("App Host Server is closed");
      // A trusted control request may have waited for a close barrier. Check
      // its current authority immediately before joining/starting a transport.
      assertAdmission?.();
      if (slot.phase === "failed") throw slot.physical!.failure!;
      if (slot.phase === "closing") {
        await this.waitForLifecycle(slot.physical!.operation!, "CLEANUP");
        continue;
      }
      if (slot.phase === "open" && slot.record?.physical.transport.status.state === "open") {
        if (slot.record.physical.logicalFailures.size) throw failedLogicalCleanup();
        return slot.record;
      }
      if (slot.phase === "starting") return this.waitForLifecycle(slot.startOperation!, "START");
      if (slot.phase === "open") {
        await this.waitForLifecycle(this.stopSlot(slot, true), "CLEANUP");
        continue;
      }
      return this.waitForLifecycle(this.startSlot(slot), "START");
    }
  }

  private hasStartupOwner(slot: HostSlot): boolean {
    if (slot.claims.size > 0) return true;
    for (const admission of slot.serviceAdmissions) {
      try { admission(); return true; }
      catch { /* A revoked caller cannot invalidate another caller's demand. */ }
    }
    return false;
  }

  private startSlot(slot: HostSlot): Promise<HostRecord> {
    if (slot.phase !== "idle" || slot.physical !== null) throw new Error(`Cannot start Host ${slot.hostId} from ${slot.phase}`);
    slot.phase = "starting";
    slot.lastState = "connecting";
    const abort = new AbortController();
    slot.startAbort = abort;
    let operation!: Promise<HostRecord>;
    // Publish the startup operation before factory/subscription callbacks run.
    operation = Promise.resolve().then(async () => {
      let physical: HostPhysical | null = null;
      let record: HostRecord | null = null;
      try {
        if (this.closed || abort.signal.aborted || !this.hasStartupOwner(slot)) {
          throw new Error(`Host ${slot.hostId} activation no longer has an owner`);
        }
        const transport = await this.options.createTransport(slot.hostId, abort.signal);
        physical = { transport, disposers: [], logicalClients: new Set(), logicalFailures: new Set(), operation: null, failure: null };
        slot.physical = physical;
        if (this.closed || abort.signal.aborted || !this.hasStartupOwner(slot)) {
          throw new Error(`Host ${slot.hostId} activation no longer has an owner`);
        }
        const generation = ++this.generationSequence;
        const ownsRecord = () => !this.closed && record !== null && slot.record === record;
        const publishStatus = (status: TransportStatus) => {
          if (!ownsRecord() || record === null) return;
          if (status.state !== "open") record.forwarding.abort(lostHostConnection(status));
          else if (record.forwarding.signal.aborted) record.forwarding = new AbortController();
          slot.lastState = status.state;
          // Native-local RPC ids are not evidence for any Renderer claim.
          // Project only the protocol's shared failure disposition.
          const publicStatus = { ...status, ...(status.failure ? {
            failure: { code: status.failure.code, recovery: status.failure.recovery },
          } : {}) };
          this.publish(slot.hostId, generation, { type: "host/status", hostId: slot.hostId, generation, status: publicStatus });
        };
        // Keep each acquired disposer even if a later subscription throws.
        physical.disposers.push(transport.subscribeMessage(frame => {
          if (ownsRecord()) this.publish(slot.hostId, generation, { type: "host/frame", hostId: slot.hostId, generation, frame });
        }));
        physical.disposers.push(transport.subscribeStatus(publishStatus));
        record = { physical, generation, forwarding: new AbortController() };
        slot.record = record;
        publishStatus({ state: "connecting" });
        await transport.connect(abort.signal);
        if (this.closed || abort.signal.aborted || !this.hasStartupOwner(slot)) {
          throw new Error(`Host ${slot.hostId} activation no longer has an owner`);
        }
        if (transport.status.state !== "open") throw lostHostConnection(transport.status);
        slot.phase = "open";
        publishStatus({ state: "open" });
        return record;
      } catch (cause) {
        slot.lastState = abort.signal.aborted ? "closed" : "failed";
        if (record !== null && !this.closed) this.publish(slot.hostId, record.generation, {
          type: "host/status", hostId: slot.hostId, generation: record.generation,
          status: { state: "failed", reason: cause instanceof Error ? cause.message : String(cause),
            ...(record.physical.transport.status.failure ? { failure: record.physical.transport.status.failure } : {}) },
        });
        if (physical !== null) {
          await this.releasePhysical(slot, physical);
          if (slot.startOperation === operation && slot.phase === "idle") {
            slot.lastState = abort.signal.aborted ? "closed" : "failed";
          }
        }
        else if (slot.phase === "starting") slot.phase = "idle";
        throw cause;
      } finally {
        if (slot.startOperation === operation) slot.startOperation = null;
        if (slot.startAbort === abort) slot.startAbort = null;
      }
    });
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
    if (record.physical.transport.status.state !== "open") throw lostHostConnection(record.physical.transport.status);
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
    const client = connection.logicalClient(key, hostId);
    const notification = this.options.logicalClientRouting && record && client
      ? this.disconnectLogicalClient(client) : Promise.resolve();
    // Notification I/O cannot postpone acquiring the physical cleanup barrier.
    // Its successful release retires unknown notification waits, not vice versa.
    const cleanup = slot.claims.size === 0 ? this.stopSlot(slot, false) : Promise.resolve();
    const [notified, cleaned] = await Promise.allSettled([notification, cleanup]);
    if (cleaned.status === "rejected") throw cleaned.reason;
    if (notified.status === "rejected") throw notified.reason;
  }

  private forgetLogicalClient(client: HostLogicalClient): void {
    client.connection.forgetLogicalClient(client.key, client.hostId, client);
    client.record?.physical.logicalClients.delete(client);
    client.record?.physical.logicalFailures.delete(client);
  }

  private disconnectLogicalClient(client: HostLogicalClient, retryKnownFailure = false): Promise<void> {
    const record = client.record;
    if (!record) return Promise.resolve();
    const physical = record.physical;
    if (!physical.logicalClients.has(client)) return Promise.resolve();
    const previous = client.operation;
    if (physical.operation !== null) return previous?.promise ?? physical.operation;
    // An unknown write may still be delivered. Reentry/detach joins it; only
    // an already-known failure at this explicit detach permits one retry.
    if (previous && !(retryKnownFailure && previous.native === "failure")) return previous.promise;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const abort = new AbortController();
    const clock = this.options.lifecycleClock ?? { setTimeout, clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
    let localDone = false, timer: unknown, hasTimer = false;
    const owns = () => client.operation === operation && physical.logicalClients.has(client);
    const finish = (error?: unknown) => {
      if (localDone) return;
      localDone = true;
      if (hasTimer) { try { clock.clearTimeout(timer); } catch { /* Local outcome still settles. */ } }
      if (error === undefined) resolve(); else reject(error);
    };
    const operation: HostLogicalDisconnect = { native: "pending", promise,
      retire(error) { finish(error); abort.abort(error); },
    };
    // Install the owner before clock, provider or abort callbacks can reenter.
    client.operation = operation;
    try {
      timer = clock.setTimeout(() => {
        if (!owns() || localDone) return;
        physical.logicalFailures.add(client);
        const error = Object.assign(new Error("The server did not finish releasing a client. Retry after it recovers."), {
          code: "APP_HOST_DISCONNECT_TIMEOUT", retryable: false,
        });
        operation.retire(error);
      }, this.options.lifecycleTimeoutMs ?? 20_000);
      hasTimer = true;
      if (localDone) clock.clearTimeout(timer);
    } catch (error) {
      physical.logicalFailures.add(client); operation.retire(error);
    }
    const succeeded = () => {
      if (!owns()) return;
      operation.native = "success";
      this.forgetLogicalClient(client);
      finish();
    };
    const failed = (error: unknown) => {
      if (!owns()) return;
      operation.native = "failure";
      physical.logicalFailures.add(client);
      finish(error);
    };
    if (!localDone && owns()) {
      try {
        const native = physical.transport.send(stampLogicalClientFrame(
          JSON.stringify({ jsonrpc: "2.0", method: "runtime/client/disconnect" }), client.key), abort.signal);
        void Promise.resolve(native).then(succeeded, failed);
      } catch (error) { failed(error); }
    }
    return promise;
  }

  private publish(hostId: string, generation: number, message: AppHostToRendererMessage): void {
    if (this.options.logicalClientRouting && message.type === "host/frame") {
      const payload = JSON.parse(message.frame) as Record<string, unknown>;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid logical RPC frame");
      const target = payload[LOGICAL_CLIENT_FIELD];
      if (target !== undefined) {
        if (typeof target !== "string") return;
        const claim = this.slots.get(hostId)?.claims.get(target);
        if (!claim || !this.connections.has(claim.connection) || claim.generation !== generation || !claim.connection.ownsHost(hostId, generation)) return;
        const { [LOGICAL_CLIENT_FIELD]: _target, ...body } = payload;
        claim.connection.post({ ...message, frame: JSON.stringify(body), leaseId: claim.leaseId });
        return;
      }
      // Only ownerless notifications may fan out to admitted connections.
      if (payload.id !== undefined && payload.id !== null) return;
    }
    for (const connection of this.connections) {
      if (connection.ownsHost(hostId, generation)) connection.post(message);
    }
  }

  /** One cleanup authority from factory receipt through successful release.
   * Failure retains the same handle; only a later explicit control may retry. */
  private releasePhysical(slot: HostSlot, physical: HostPhysical, retry = false): Promise<void> {
    if (physical.operation !== null && !(retry && physical.failure !== null)) return physical.operation;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const operation = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    physical.operation = operation;
    physical.failure = null;
    slot.phase = "closing";
    slot.lastState = "closing";
    const record = slot.record;
    slot.record = null;
    // Install the physical barrier before cancellation or provider callbacks.
    if (record?.physical === physical) {
      record.forwarding.abort(lostHostConnection({ state: "closed", reason: "Host generation retired" }));
      for (const connection of this.connections) connection.forgetHost(slot.hostId, record.generation);
    }
    void Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      for (const dispose of physical.disposers.splice(0)) {
        try { dispose(); } catch (error) { physical.disposers.push(dispose); errors.push(error); }
      }
      try { await physical.transport.close(); } catch (error) { errors.push(error); }
      if (errors.length) {
        const failure = failedPhysicalCleanup(new AggregateError(errors));
        if (slot.physical === physical && physical.operation === operation) {
          physical.failure = failure; slot.phase = "failed"; slot.lastState = "failed";
        }
        for (const client of physical.logicalClients) client.operation?.retire(failure);
        reject(failure);
      } else {
        for (const client of [...physical.logicalClients]) {
          client.operation?.retire();
          this.forgetLogicalClient(client);
        }
        if (slot.physical === physical && physical.operation === operation) {
          slot.physical = null; slot.phase = "idle"; slot.lastState = "closed";
        }
        resolve();
      }
    });
    return operation;
  }

  private async stopSlot(slot: HostSlot, force: boolean, retryFailedCleanup = false): Promise<void> {
    if (!force && this.options.physicalHostLifetime === "server") return;
    if (!force && slot.claims.size > 0) return;
    if (slot.phase === "starting") {
      if (force) slot.startAbort?.abort();
      await slot.startOperation?.catch(() => undefined);
      if (!force && slot.claims.size > 0) return;
      // A failure arising during this intent is not an implicit second try.
      await this.stopSlot(slot, force, false);
      return;
    }
    if (slot.physical === null) return;
    await this.releasePhysical(slot, slot.physical, retryFailedCleanup);
  }

}

interface OwnedLease {
  readonly hostId: string;
  readonly leaseId: string;
  readonly generation: number;
}

export class AppHostServerConnection {
  private readonly leases = new Map<string, OwnedLease>();
  private readonly logicalClients = new Map<string, HostLogicalClient>();
  private unsubscribePort: (() => void) | null = null;
  private portClosed = false;
  private cleaningPort = false;
  private retiring = false;
  private activated = false;
  private readonly earlyMessages: unknown[] = [];
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
    try {
      this.unsubscribePort = port.subscribe(value => {
        if (!this.activated) { if (!this.closed) this.earlyMessages.push(value); return; }
        this.receivePort(value);
      });
    } catch (cause) {
      try { this.detach(); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], "App Host initialization and cleanup failed", { cause }); }
      throw cause;
    }
  }

  /** accept registers this owner before any queued startup message is admitted. */
  start(): void {
    if (this.activated || this.closed) return;
    try {
      this.port.start();
      if (this.closed) return;
      this.activated = true;
      for (const value of this.earlyMessages.splice(0)) {
        if (this.closed) break;
        this.receivePort(value);
      }
    } catch (cause) {
      try { this.close(); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], "App Host initialization and cleanup failed", { cause }); }
      throw cause;
    }
  }

  private readonly receivePort = (value: unknown): void => {
    if (this.closed) return;
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
  };

  get isClosed(): boolean { return this.closed; }

  close(): void {
    if (this.retiring) return;
    this.retiring = true;
    try {
      if (!this.closed) {
        this.closed = true;
        this.earlyMessages.length = 0;
        this.server.removeConnection(this);
      }
      this.cleanupPort();
    } finally { this.retiring = false; }
  }

  detach(): void {
    if (this.retiring) return;
    this.retiring = true;
    try {
      this.closed = true;
      this.earlyMessages.length = 0;
      this.leases.clear();
      this.logicalClients.clear();
      this.cleanupPort();
    } finally { this.retiring = false; }
  }

  private cleanupPort(): void {
    if (this.cleaningPort) return;
    this.cleaningPort = true;
    this.server.trackConnectionCleanup(this, true);
    const errors: unknown[] = [];
    try {
      if (this.unsubscribePort !== null) {
        try { this.unsubscribePort(); this.unsubscribePort = null; }
        catch (cause) { errors.push(cause); }
      }
      if (!this.portClosed) {
        try { this.port.close(); this.portClosed = true; }
        catch (cause) { errors.push(cause); }
      }
      if (!errors.length) this.server.trackConnectionCleanup(this, false);
      if (errors.length) throw new AggregateError(errors, "App Host Port cleanup failed");
    } finally { this.cleaningPort = false; }
  }

  post(message: AppHostToRendererMessage): void {
    if (!this.closed) this.port.postMessage(message);
  }

  rememberLease(hostId: string, leaseId: string, generation: number): void {
    this.leases.set(hostScopedKey(hostId, leaseId), { hostId, leaseId, generation });
  }

  forgetLease(hostId: string, leaseId: string, generation: number): void {
    const key = hostScopedKey(hostId, leaseId);
    if (this.leases.get(key)?.generation === generation) this.leases.delete(key);
  }

  rememberLogicalClient(clientId: string, hostId: string, record: HostRecord | null = null): void {
    const key = hostScopedKey(hostId, clientId);
    const existing = this.logicalClients.get(key);
    if (existing?.record === record && existing.operation === null) return;
    const client: HostLogicalClient = { key: clientId, hostId, connection: this, record, operation: null };
    this.logicalClients.set(key, client);
    record?.physical.logicalClients.add(client);
  }

  logicalClient(clientId: string, hostId: string): HostLogicalClient | undefined { return this.logicalClients.get(hostScopedKey(hostId, clientId)); }

  forgetLogicalClient(clientId: string, hostId: string, expected?: HostLogicalClient): void {
    const key = hostScopedKey(hostId, clientId);
    if (expected === undefined || this.logicalClients.get(key) === expected) this.logicalClients.delete(key);
  }

  hasLogicalClient(clientId: string, hostId: string): boolean {
    return this.logicalClients.has(hostScopedKey(hostId, clientId));
  }

  takeLogicalClients(): Map<string, HostLogicalClient> {
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

export { HostInteractions, InteractionFault } from "./interactions";
