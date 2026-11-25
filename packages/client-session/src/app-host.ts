import { APP_HOST_PROTOCOL_VERSION } from "@opencraft/app-host-protocol/version";
import {
  RESUME_ACK_DELAY_MS,
  ResumeSessionCapacityError,
  isAcknowledgement,
  isResumeAttempt,
  isSequence,
  parseResumeAttempt,
  type ResumeAttempt,
  type ResumeFailureReason,
  type ResumeGrant,
  type ResumeLink,
} from "@opencraft/app-host-resume";
import type { SessionFrame, SessionSocket, SessionSocketHandler } from "@opencraft/client-session";
import {
  periodicOwnerWork,
  timeoutOwnerWake,
  type OwnerWake,
  type OwnerWakeTimer,
  type PeriodicOwnerWork,
} from "@opencraft/owner-wake";

/**
 * App Host client session over the runtime-neutral session socket: frame
 * admission, the hello handshake, per-message authorization, opt-in
 * heartbeat frames, probe diagnostics, and resumption of the logical App Host
 * connection across sockets. Logical Host routing stays in the App Host
 * server this session is accepted by.
 */

export const APP_HOST_HEARTBEAT_MS = 10_000;
const APP_HOST_HEARTBEAT_MAX_BUFFERED = 1024 * 1024;
const APP_HOST_HEARTBEAT_FRAME = JSON.stringify({ type: "connection/heartbeat" });
const OPEN = 1;

// A socket that died abnormally may come back within the detach window.
// Normal closes, policy closes and server-initiated closes end the session.
const APP_HOST_DETACHABLE_CLOSE_CODES = new Set([1001, 1005, 1006]);

// Return bounded, allowlisted metadata only: never echo an untrusted frame value.
export function appHostFrameRejection(message: unknown): Record<string, unknown> | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return { reason: "not-object" };
  const record = message as Record<string, unknown>;
  const types = ["hello", "connection/probe", "host/connect", "host/send", "host/disconnect"];
  const messageType = types.includes(record.type as string) ? record.type : "unknown";
  const reject = (reason: string, extra: Record<string, unknown> = {}) => ({ reason, messageType, ...extra });
  const validId = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 4096;
  if (record.type === "hello") {
    if (record.protocolVersion !== APP_HOST_PROTOCOL_VERSION)
      return reject("protocol-version", {
        receivedProtocolVersion:
          Number.isSafeInteger(record.protocolVersion) && (record.protocolVersion as number) >= 0
            ? record.protocolVersion
            : "invalid",
      });
    return validId(record.rendererId) ? null : reject("renderer-id");
  }
  if (!validId(record.requestId)) return reject("request-id");
  if (record.type === "connection/probe") return null;
  if (!validId(record.hostId)) return reject("host-id");
  if (!validId(record.leaseId)) return reject("lease-id");
  if (record.type === "host/connect") return null;
  if (record.type !== "host/send" && record.type !== "host/disconnect") return reject("message-type");
  if (!Number.isSafeInteger(record.generation) || (record.generation as number) < 0) return reject("generation");
  return record.type === "host/disconnect" || typeof record.frame === "string" ? null : reject("frame-type");
}

/**
 * A frame in either direction. Client frames are untrusted JSON; the session
 * reads `requestId` and `rendererId` only after `appHostFrameRejection` admitted
 * them as bounded strings, and App Host messages are trusted.
 */
export interface Message {
  readonly [field: string]: unknown;
  readonly type?: unknown;
  readonly requestId?: string;
  readonly rendererId?: string;
}

export type AppHostSessionDiagnostic = (event: string, detail?: Record<string, unknown>) => void;

/** The App Host side of one logical connection (what `AppHostServer.accept` receives). */
export interface AppHostSessionPort {
  postMessage(message: Message): void;
  subscribe(listener: (message: Message) => void): () => void;
  start(): void;
  close(): void;
}

export interface AppHostSessionAcceptor<C> {
  accept(port: AppHostSessionPort, rendererId: string, submissionContext: C): { close(): void };
}

/** Admission authority of the socket's upgrade; a resumable session holds it across sockets. */
export interface AppHostSessionAuthority {
  hold(retire: (reason: string) => void): boolean;
  release(): void;
}

/** One resumable logical connection as the resume store keeps it. */
export interface AppHostResumeSession<P> {
  readonly payload: P;
  /** Sequencing state; retained frames are UTF-8 bytes (null when too large to retain). */
  readonly link: ResumeLink<Uint8Array | null>;
  readonly isEnded: boolean;
  grant(): ResumeGrant;
  attach(): void;
  detach(deadline?: number): void;
  end(reason: string): void;
}

/**
 * Durable-resume hook: where resumable sessions live and how a resume token
 * finds one. The in-process `ResumeRegistry` keeps them in memory. A runtime
 * whose memory can be dropped answers `find` from what it kept, and answers
 * `unknown-session` when the live session is gone; the client then starts a
 * fresh connection and per-Thread cursors (gateway-split §3.3) carry
 * continuity above this layer.
 */
export interface AppHostResumeStore<P> {
  /** Diagnostic counters, spread into resume events. */
  readonly stats: object;
  /** Throws `ResumeSessionCapacityError` when full; resumption is optional. */
  create(identity: string, payload: P, onEnd: (reason: string) => void): AppHostResumeSession<P>;
  find(
    attempt: ResumeAttempt,
    identity: string,
  ): { session: AppHostResumeSession<P> } | { failure: ResumeFailureReason };
}

export interface AppHostSessionResume {
  readonly registry: AppHostResumeStore<unknown>;
  /** Exact admission identity of the upgrade; resumption requires the same one. */
  readonly identity: string;
  /** Live route the authority checks read; a resumed session moves it to the new socket. */
  readonly route: object | null;
  readonly authority: AppHostSessionAuthority;
  /** Admission deadline; a detached session never outlives it. */
  readonly deadline?: number;
}

export interface AppHostSubmissionContext {
  readonly actorContext?: { readonly credentialId?: unknown };
}

export interface AppHostClientSessionOptions<C extends AppHostSubmissionContext> {
  readonly appHostServer: AppHostSessionAcceptor<C>;
  readonly diagnostic: AppHostSessionDiagnostic;
  readonly authorize?: (message: Message) => boolean;
  readonly submissionContext?: C;
  /** Without it, or for a client that does not ask, the connection ends with its socket. */
  readonly resume?: AppHostSessionResume | null;
  /** The physical transport answers the fixed connection probe without a JS wake-up. */
  readonly idleProbe?: true;
  /** Wake-ups of this connection (heartbeat frames, delayed acknowledgements) on the owner wake-up port; they
   * live only as long as the connection. Defaults to the runtime's timeouts. */
  readonly wake?: OwnerWake;
}

const defaultWake = timeoutOwnerWake();

interface Probe {
  readonly sequence: number;
  readonly started: number;
}

interface Wire {
  readonly socket: SessionSocket;
  readonly authorize: (message: Message) => boolean;
  readonly logDiagnostic: AppHostSessionDiagnostic;
  heartbeatRequested: boolean;
  heartbeatTimer: PeriodicOwnerWork | null;
  frameSequence: number;
  probeSequence: number;
  lastProbeObservedAt: number;
  readonly probes: Map<unknown, Probe>;
  session: SessionState | null;
  /** The session closed this socket itself (revocation, expiry, policy); never detachable. */
  closedByServer: boolean;
  send(frame: SessionFrame, done?: (error?: Error) => void): void;
  probeDetail(probe: Probe): Record<string, unknown>;
  startHeartbeat(): void;
}

interface SessionState {
  wire: Wire | null;
  connection: { close(): void } | null;
  readonly listeners: Set<(message: Message) => void>;
  readonly pendingConnects: Set<unknown>;
  authorize: (message: Message) => boolean;
  resumable: AppHostResumeSession<SessionState> | null;
  sequencing: boolean;
  heartbeat: boolean;
  ackTimer: OwnerWakeTimer | null;
  readonly route: object | null;
  port: AppHostSessionPort;
  authority: AppHostSessionAuthority | null;
  adoptAuthority(authority: AppHostSessionAuthority): void;
  end(reason: string): void;
  scheduleAck(): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Mark explicit application closures only. A runtime may also close internally
// to echo a peer's close frame; that echo is not a server-initiated policy close.
function closeSocket(wire: Wire, code: number, reason: string): void {
  wire.closedByServer = true;
  wire.socket.close(code, reason);
}

/**
 * Accept one App Host client socket. With `resume` and a client that asks for
 * it, the App Host connection outlives its socket for a short window and
 * frames are numbered so a reconnecting client continues the same session.
 * Without it the connection ends with its socket. Returns the handler the
 * runtime adapter delivers socket events to.
 */
export function acceptAppHostClientSession<C extends AppHostSubmissionContext>(
  socket: SessionSocket,
  options: AppHostClientSessionOptions<C>,
): SessionSocketHandler {
  const { appHostServer, diagnostic: logDiagnostic } = options;
  const authorize = options.authorize ?? (() => true);
  const submissionContext = options.submissionContext ?? ({ sender: null } as unknown as C);
  const resume = options.resume ?? null;
  const registry = resume?.registry as AppHostResumeStore<SessionState> | undefined;
  const wake = options.wake ?? defaultWake;

  const wire: Wire = {
    socket,
    authorize,
    logDiagnostic,
    heartbeatRequested: false,
    heartbeatTimer: null,
    frameSequence: 0,
    probeSequence: 0,
    lastProbeObservedAt: -Infinity,
    probes: new Map(),
    session: null,
    closedByServer: false,
    send: (frame, done) => socket.send(frame, done),
    probeDetail: (probe) => ({
      probeSequence: probe.sequence,
      eventAtMs: Date.now(),
      elapsedMs: Math.max(0, performance.now() - probe.started),
      readyState: socket.readyState,
      bufferedBytes: socket.bufferedAmount,
    }),
    startHeartbeat: () => startHeartbeat(),
  };
  const frameContext = () => ({
    frameSequence: wire.frameSequence,
    phase: wire.session === null ? "awaiting-hello" : "ready",
  });
  const stopHeartbeat = () => {
    wire.heartbeatTimer?.close();
    wire.heartbeatTimer = null;
  };
  // Opt-in liveness: a client that asks for heartbeats judges the route by the
  // age of its last received frame instead of a slow, foreground-only probe.
  const startHeartbeat = () => {
    if (wire.heartbeatTimer !== null) return;
    wire.heartbeatTimer = periodicOwnerWork(wake, APP_HOST_HEARTBEAT_MS, () => {
      if (socket.readyState !== OPEN) {
        stopHeartbeat();
        return;
      }
      // A congested socket already proves nothing new; do not grow its queue.
      if (socket.bufferedAmount > APP_HOST_HEARTBEAT_MAX_BUFFERED) return;
      wire.send(APP_HOST_HEARTBEAT_FRAME);
    });
  };
  const protocolError = (reason: string) => {
    logDiagnostic("invalid-frame", { code: 1008, ...frameContext(), reason });
    closeSocket(wire, 1008, "Invalid App Host request");
    wire.session?.resumable?.end("protocol-error");
  };

  /** Shared state of one App Host connection; outlives sockets only when resumable. */
  const createSession = (): SessionState => {
    const session: SessionState = {
      wire: null,
      connection: null,
      listeners: new Set(),
      pendingConnects: new Set(),
      authorize,
      resumable: null,
      sequencing: false,
      heartbeat: false,
      ackTimer: null,
      route: resume?.route ?? null,
      port: null as unknown as AppHostSessionPort,
      authority: null,
      adoptAuthority: () => {},
      end: () => {},
      scheduleAck: () => {},
    };
    const current = () => session.wire;
    session.port = {
      postMessage(message) {
        if (session.resumable?.isEnded) return;
        const active = current();
        if (!session.authorize(message)) {
          if (active) closeSocket(active, 1008, "Connection access expired");
          else session.resumable?.end("access-expired");
          return;
        }
        if (message?.type === "ready") {
          const capabilities: Record<string, unknown> = { ...(message.capabilities as object | undefined) };
          if (options.idleProbe) capabilities.idleProbe = true;
          if (active?.heartbeatRequested) {
            capabilities.heartbeatMs = APP_HOST_HEARTBEAT_MS;
            session.heartbeat = true;
          }
          if (session.resumable) capabilities.resume = session.resumable.grant();
          message = { ...message, capabilities };
          if (session.heartbeat && active) active.startHeartbeat();
        }
        if (message?.type === "response" && session.pendingConnects.delete(message.requestId)) {
          active?.logDiagnostic("host-connect", { ok: message.ok === true });
        }
        let frame: string;
        if (session.sequencing) {
          // Numbered and retained (as UTF-8 bytes, off the JS heap) until acknowledged.
          const link = session.resumable!.link,
            seq = link.next();
          frame = JSON.stringify({ ...message, seq });
          const data = encoder.encode(frame);
          link.retain(seq, data.byteLength > link.maxBytes ? null : data, data.byteLength);
        } else frame = JSON.stringify(message);
        if (message?.type === "ready" && session.resumable) session.sequencing = true;
        if (!active || active.socket.readyState !== OPEN) return;
        const probe = message?.type === "response" ? active.probes.get(message.requestId) : undefined;
        if (probe) {
          active.probes.delete(message.requestId);
          const responseMs = Math.max(0, performance.now() - probe.started);
          active.logDiagnostic("probe-response", { ...active.probeDetail(probe), responseMs, ok: message.ok === true });
          active.send(frame, (error) => {
            // A completed local write does not acknowledge browser receipt.
            active.logDiagnostic("probe-written", { ...active.probeDetail(probe), responseMs, ok: !error });
          });
        } else active.send(frame);
      },
      subscribe(listener) {
        session.listeners.add(listener);
        return () => {
          session.listeners.delete(listener);
        };
      },
      start() {},
      close() {
        const active = current();
        if (active && active.socket.readyState === OPEN) closeSocket(active, 1000, "App Host closed");
        session.resumable?.end("connection-closed");
      },
    };
    session.adoptAuthority = (authority) => {
      const old = session.authority;
      session.authority = authority;
      authority?.hold((reason) => {
        const active = session.wire;
        if (active) {
          closeSocket(active, 1008, reason);
          active.socket.terminate();
        }
        session.end(reason === "Identity access expired" ? "access-expired" : "access-revoked");
      });
      if (old !== authority) old?.release();
    };
    session.end = (reason) => {
      if (session.resumable) session.resumable.end(reason);
      else session.connection?.close();
    };
    session.scheduleAck = () => {
      const due = session.resumable?.link.acknowledgementDue;
      if (!due) return;
      const flush = () => {
        session.ackTimer = null;
        const active = current();
        if (!active || active.socket.readyState !== OPEN || session.resumable!.isEnded) return;
        active.send(JSON.stringify({ type: "connection/ack", received: session.resumable!.link.acknowledged() }));
      };
      if (due === "now") {
        session.ackTimer?.cancel();
        flush();
      } else if (session.ackTimer === null) {
        session.ackTimer = wake.timer(flush);
        session.ackTimer.arm(wake.now() + RESUME_ACK_DELAY_MS);
      }
    };
    return session;
  };

  const adopt = (session: SessionState, attempt: ResumeAttempt, heartbeatRequested: boolean): number | false => {
    const replay = session.resumable!.link.replay(attempt.received);
    if (replay === null) return false;
    const previous = session.wire;
    if (previous) {
      previous.session = null;
      previous.socket.terminate();
    }
    session.resumable!.attach();
    session.wire = wire;
    wire.session = session;
    session.authorize = authorize;
    session.adoptAuthority(resume!.authority);
    // Authority closures of the original upgrade follow the live socket and request.
    if (session.route && resume!.route && session.route !== resume!.route) Object.assign(session.route, resume!.route);
    wire.heartbeatRequested = heartbeatRequested;
    wire.send(JSON.stringify({ type: "connection/resumed", received: session.resumable!.link.received }));
    for (const frame of replay) wire.send(decoder.decode(frame.data!));
    if (session.heartbeat && heartbeatRequested) startHeartbeat();
    return replay.length;
  };

  const receive = (raw: SessionFrame, byteLength: number) => {
    if (socket.readyState !== OPEN || wire.closedByServer) return;
    wire.frameSequence += 1;
    if (typeof raw !== "string") {
      logDiagnostic("invalid-frame", { code: 1003, reason: "binary", ...frameContext() });
      closeSocket(wire, 1003, "Text frames required");
      return;
    }
    let message: Message;
    try {
      message = JSON.parse(raw) as Message;
    } catch {
      logDiagnostic("invalid-frame", { code: 1003, reason: "json", ...frameContext() });
      closeSocket(wire, 1003, "Invalid App Host frame");
      return;
    }
    const session = wire.session;
    if (session?.resumable?.isEnded) {
      closeSocket(wire, 1000, "App Host session ended");
      return;
    }
    if (message && typeof message === "object" && !Array.isArray(message)) {
      if (message.type === "connection/ack") {
        if (
          !session?.resumable ||
          !isAcknowledgement(message.received) ||
          !session.resumable.link.acknowledge(message.received)
        )
          protocolError("acknowledgement");
        return;
      }
      if (message.type === "connection/end") {
        if (session?.resumable) session.resumable.end("client-end");
        closeSocket(wire, 1000, "App Host session ended");
        return;
      }
    }
    let seq: number | undefined;
    if (message && typeof message === "object" && "seq" in message) {
      if (!session?.sequencing || !isSequence(message.seq)) {
        protocolError("sequence");
        return;
      }
      const { seq: numbered, ...rest } = message;
      seq = numbered as number;
      message = rest;
    }
    if (session && (message?.type === "hello" || (session.sequencing && seq === undefined))) {
      protocolError("sequence-required");
      return;
    }
    const rejection = appHostFrameRejection(message);
    if (rejection !== null) {
      logDiagnostic("invalid-frame", { code: 1008, ...frameContext(), ...rejection });
      if (rejection.reason === "protocol-version" && socket.readyState === OPEN) {
        wire.send(
          JSON.stringify({
            type: "fatal",
            error: {
              code: "APP_HOST_PROTOCOL_MISMATCH",
              message: "Client and server versions are incompatible. Update or reload the client to reconnect.",
              retryable: false,
            },
          }),
          () => closeSocket(wire, 1008, "Invalid App Host request"),
        );
        return;
      }
      wire.session?.resumable?.end("protocol-error");
      closeSocket(wire, 1008, "Invalid App Host request");
      return;
    }
    if (message.type === "connection/probe") {
      const started = performance.now();
      const sequence = ++wire.probeSequence;
      // Observe normal five-second probes, bounded even for a flooding peer.
      if (started - wire.lastProbeObservedAt >= 1000 && wire.probes.size < 8 && !wire.probes.has(message.requestId)) {
        wire.lastProbeObservedAt = started;
        const probe = { sequence, started };
        wire.probes.set(message.requestId, probe);
        logDiagnostic("probe-received", { ...wire.probeDetail(probe), frameSequence: wire.frameSequence });
      }
    }
    if (seq !== undefined) {
      const arrival = wire.session!.resumable!.link.accept(seq, byteLength);
      if (arrival === "duplicate") return;
      if (arrival === "gap") {
        protocolError("sequence-gap");
        return;
      }
      wire.session!.scheduleAck();
    }
    if (!authorize(message)) {
      const probe = wire.probes.get(message.requestId);
      if (probe) {
        wire.probes.delete(message.requestId);
        logDiagnostic("probe-rejected", { ...wire.probeDetail(probe), reason: "access" });
      }
      const denied = {
        type: "response",
        requestId: message.requestId,
        ok: false,
        error: submissionContext.actorContext?.credentialId
          ? { code: "CHANNEL_SCOPE_REQUIRED", message: "This credential can only access Channels", retryable: false }
          : { code: "SSH_ACCESS_REQUIRED", message: "Unlock remote connections in settings", retryable: false },
      };
      // A denied operation still occupies its valid transport sequence, but never
      // reaches Host dispatch. Reply through the same retained logical owner.
      if (wire.session) wire.session.port.postMessage(denied);
      else wire.send(JSON.stringify(denied));
      return;
    }
    if (wire.session === null) {
      if (message?.type !== "hello" || typeof message.rendererId !== "string" || !message.rendererId) {
        logDiagnostic("hello-required", { code: 1008, ...frameContext(), messageType: message.type });
        closeSocket(wire, 1008, "App Host hello required");
        return;
      }
      const heartbeatRequested = !options.idleProbe && message.heartbeat === true;
      const requested = resume && message.resume !== undefined ? parseResumeAttempt(message.resume) : null;
      if (requested && isResumeAttempt(requested)) {
        const found = registry!.find(requested, JSON.stringify([resume!.identity, message.rendererId]));
        let reason: ResumeFailureReason | null = "failure" in found ? found.failure : null,
          replayed = 0;
        if (reason === null && "session" in found) {
          const adopted = adopt(found.session.payload, requested, heartbeatRequested);
          if (adopted === false) {
            reason = "gap";
            found.session.end("gap");
          } else replayed = adopted;
        }
        if (reason !== null) {
          logDiagnostic("resume-rejected", { reason });
          wire.send(JSON.stringify({ type: "connection/resume-failed", reason }), () =>
            closeSocket(wire, 1000, "App Host session not resumable"),
          );
          return;
        }
        logDiagnostic("resume-accepted", { replayedFrames: replayed, ...registry!.stats });
        return;
      }
      const session = createSession();
      wire.session = session;
      session.wire = wire;
      wire.heartbeatRequested = heartbeatRequested;
      if (requested && resume) {
        try {
          session.resumable = registry!.create(
            JSON.stringify([resume.identity, message.rendererId]),
            session,
            (reason) => {
              session.ackTimer?.cancel();
              session.ackTimer = null;
              session.authority?.release();
              session.authority = null;
              try {
                session.connection?.close();
              } finally {
                if (session.wire && session.wire.socket.readyState === OPEN)
                  closeSocket(session.wire, 1000, "App Host session ended");
              }
              if (reason !== "connection-closed" && reason !== "client-end") logDiagnostic("resume-ended", { reason });
            },
          );
        } catch (error) {
          if (!(error instanceof ResumeSessionCapacityError)) {
            closeSocket(wire, 1011, "App Host unavailable");
            return;
          }
          // Resumption is optional: registry saturation cannot evict another owner or deny a fresh legacy connection.
          logDiagnostic("resume-unavailable", { reason: "capacity" });
        }
      }
      if (session.resumable) session.adoptAuthority(resume!.authority);
      try {
        session.connection = appHostServer.accept(session.port, message.rendererId, submissionContext);
      } catch {
        logDiagnostic("hello-rejected", { code: 1011 });
        session.resumable?.end("accept-failed");
        closeSocket(wire, 1011, "App Host unavailable");
        return;
      }
      logDiagnostic("hello-accepted", {
        frameSequence: wire.frameSequence,
        receivedProtocolVersion: message.protocolVersion,
        ...(session.resumable ? { resumable: 1 } : {}),
      });
    }
    const active = wire.session;
    if (message.type === "host/connect") active.pendingConnects.add(message.requestId);
    for (const listener of active.listeners) listener(message);
  };

  let closed = false;
  return {
    message: receive,
    close(code) {
      if (closed) return;
      closed = true;
      stopHeartbeat();
      for (const probe of wire.probes.values()) logDiagnostic("probe-abandoned", wire.probeDetail(probe));
      wire.probes.clear();
      const session = wire.session;
      if (!session || session.wire !== wire) return;
      session.wire = null;
      if (
        session.resumable &&
        !session.resumable.isEnded &&
        session.sequencing &&
        !wire.closedByServer &&
        APP_HOST_DETACHABLE_CLOSE_CODES.has(code)
      ) {
        session.resumable.detach(resume!.deadline ?? Infinity);
        logDiagnostic("resume-detached", { code, ...registry!.stats });
        return;
      }
      session.end("socket-closed");
    },
    error() {
      // A resumable session decides on the following close; others end now.
      const session = wire.session;
      if (session && session.wire === wire && !session.resumable) session.connection?.close();
    },
  };
}
