import { WebSocketSendProgress } from "@opencraft/appserver-transport-websocket";
import { AppHostAdmissionError } from './app-host-admission';
import type { TransportSendProgressOptions } from "@opencraft/appserver-client/transport";
import { createPagePauseDiagnostics, type PagePauseDiagnostic } from "./page-pause-diagnostics";
import { serverFetch, serverUrl } from "./server-context";
import { observeEvent } from "./observability";
import { exponentialBackoffMs, retryDelayMs, wasEstablished } from "@opencraft/workbench-runtime/retry-schedule";
import {
  RESUME_ACK_DELAY_MS, RESUME_ATTEMPT_MS, RESUME_CLIENT_MAX_BYTES, RESUME_PROTOCOL_VERSION, ResumeLink,
  isAcknowledgement, isSequence, parseResumeGrant, utf8Length, type ResumeGrant,
} from "@opencraft/app-host-resume";
import { MessagePortAppHostClient } from "@opencraft/app-host-client";
import type { RendererToAppHostMessage } from "@opencraft/app-host-protocol";
import { captureTransportMessageScope, ClientObserverList, TransportStatusObservers } from "@opencraft/appserver-client/transport";
import type { DuplexTransport, TransportStatus, TransportFailureDiagnostic } from "@opencraft/appserver-client/transport";

type AppHostConnectionPhase = "connecting" | "socket-open" | "ready";
type AppHostFailure = "socket-error" | "socket-close" | "handshake-timeout" | "probe-timeout" | "liveness-timeout" | "invalid-response";

/** Heartbeat liveness: a heartbeat-capable route is suspect after this many
 * intervals without any server frame, then gets one short probe to answer. */
const LIVENESS_STALE_INTERVALS = 2.5;
const LIVENESS_CHECK_MS = 5_000;
const LIVENESS_TICK_MS = 5_000;
/** One resumption handshake (new socket + resumed reply) must finish within this. */
const RESUME_HANDSHAKE_MS = 10_000;

interface LostRoute {
  readonly message: string;
  readonly failure: AppHostFailure;
  readonly closeCode?: number;
  readonly wasClean?: boolean;
  readonly timing?: { timeoutMs: number; timerLateMs: number };
}

export interface AppHostRecoveryEvents {
  isVisible(): boolean;
  diagnosticContext?(): PagePauseDiagnostic;
  subscribe(listener: (reason?: string) => void): () => void;
}

function createBrowserRecoveryEvents(): AppHostRecoveryEvents {
  const browserPagePause = createPagePauseDiagnostics();
  const recordedPageEvents = new WeakSet<Event>();
  let browserPageSuspended = false;
  return {
    isVisible: () => !browserPageSuspended && (typeof document === "undefined" || document.visibilityState !== "hidden"),
    diagnosticContext: () => browserPagePause.snapshot(),
    subscribe(listener) {
      if (typeof window === "undefined") return () => undefined;
      const record = (event: Event) => {
        if (recordedPageEvents.has(event)) return;
        recordedPageEvents.add(event);
        if (event.type === "freeze" || event.type === "pagehide") {
          browserPageSuspended = true;
          browserPagePause.pause();
        } else if (event.type === "resume" || event.type === "pageshow") {
          browserPageSuspended = false;
          browserPagePause.resume(event.type === "pageshow" && (event as PageTransitionEvent).persisted === true);
        } else if (event.type === "visibilitychange") {
          if (document.visibilityState === "hidden") browserPagePause.pause();
          else if (!browserPageSuspended) browserPagePause.resume();
        }
      };
      const wake = (event: Event) => { record(event); listener(event.type); };
      if (globalThis.document?.visibilityState === "hidden") browserPagePause.pause();
      window.addEventListener?.("online", wake);
      window.addEventListener?.("pageshow", wake);
      globalThis.document?.addEventListener("visibilitychange", wake);
      // A frozen/BFCache page can still report visibilityState=visible. Retire
      // its foreground probe before suspension and wake the existing owner with
      // a fresh probe on resume, rather than expiring the pre-pause deadline.
      window.addEventListener?.("pagehide", wake);
      globalThis.document?.addEventListener("freeze", wake);
      globalThis.document?.addEventListener("resume", wake);
      return () => {
        window.removeEventListener?.("online", wake);
        window.removeEventListener?.("pageshow", wake);
        globalThis.document?.removeEventListener("visibilitychange", wake);
        window.removeEventListener?.("pagehide", wake);
        globalThis.document?.removeEventListener("freeze", wake);
        globalThis.document?.removeEventListener("resume", wake);
      };
    },
  };
}

interface AppHostConnectionDiagnostic extends PagePauseDiagnostic {
  attemptId: string;
  failure: AppHostFailure;
  phase: AppHostConnectionPhase;
  readyState: number;
  ageMs: number;
  closeCode?: number;
  eventAtMs: number;
  visibility: "visible" | "hidden";
  networkState: "online" | "offline" | "unknown";
  bufferedBytes: number;
  wasClean?: 0 | 1;
  lastMessageAgoMs?: number;
  probeElapsedMs?: number;
  lastProbeRttMs?: number;
  timeoutMs?: number;
  timerLateMs?: number;
}

function reportAppHostConnectionFailure(diagnostic: AppHostConnectionDiagnostic): void {
  // The queued observation survives temporary disconnection and is attributable
  // to the same producer/physical attempt as recovery events. No error text/URL.
  observeEvent({ kind: "client_signal", clientSignal: "transport_failure", outcome: "failed",
    attemptId: diagnostic.attemptId, at: diagnostic.eventAtMs,
    transportFailure: diagnostic.failure, transportPhase: diagnostic.phase,
    socketReadyState: diagnostic.readyState, durationMs: diagnostic.ageMs,
    visibility: diagnostic.visibility, networkState: diagnostic.networkState,
    socketBufferedBytes: diagnostic.bufferedBytes,
    ...(diagnostic.closeCode === undefined ? {} : { socketCloseCode: diagnostic.closeCode }),
    ...(diagnostic.wasClean === undefined ? {} : { socketWasClean: diagnostic.wasClean }),
    ...(diagnostic.lastMessageAgoMs === undefined ? {} : { lastMessageAgoMs: diagnostic.lastMessageAgoMs }),
    ...(diagnostic.probeElapsedMs === undefined ? {} : { probeElapsedMs: diagnostic.probeElapsedMs }),
    ...(diagnostic.lastProbeRttMs === undefined ? {} : { lastProbeRttMs: diagnostic.lastProbeRttMs }),
    ...(diagnostic.timeoutMs === undefined ? {} : { transportTimeoutMs: diagnostic.timeoutMs }),
    ...(diagnostic.timerLateMs === undefined ? {} : { timerLateMs: diagnostic.timerLateMs }),
    ...(diagnostic.pagePauseMs === undefined ? {} : { pagePauseMs: diagnostic.pagePauseMs }),
    ...(diagnostic.pageResumeAgoMs === undefined ? {} : { pageResumeAgoMs: diagnostic.pageResumeAgoMs }),
    ...(diagnostic.pageHiddenForMs === undefined ? {} : { pageHiddenForMs: diagnostic.pageHiddenForMs }),
    measurementScope: "connection" });
  console.info("[opencraft apphost failure]", diagnostic);
  if (typeof globalThis.fetch !== "function") return;
  try {
    void serverFetch("/__opencraft_apphost_diagnostic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(diagnostic),
      keepalive: true,
    }).catch(() => undefined);
  } catch { /* Diagnostics must never alter transport behavior. */ }
}

class WebSocketAppHostPort {
  private socket: WebSocket;
  /** The socket whose events this port still trusts; null while a resumed route is replaced. */
  private live: WebSocket | null;
  private outgoing: WebSocketSendProgress;
  /** Negotiated session resumption (packages/app-host-resume); null keeps the legacy model. */
  private resume: { readonly grant: ResumeGrant; readonly link: ResumeLink<string>; ackTimer: ReturnType<typeof setTimeout> | null } | null = null;
  private hello: Record<string, unknown> | null = null;
  private resuming: { readonly startedAt: number; attempts: number; timer: ReturnType<typeof setTimeout> | null;
    handshake: ReturnType<typeof setTimeout> | null; readonly cause: LostRoute } | null = null;
  private resumes = 0;
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  private readonly queued: string[] = [];
  private readonly handshakeTimer: ReturnType<typeof globalThis.setTimeout>;
  private readonly startedAt = Date.now();
  private phase: AppHostConnectionPhase = "connecting";
  private closed = false;
  private socketCloseAccepted = false;
  private supportsProbe = false;
  private lastMessageAt: number | undefined;
  private lastProbeRttMs: number | undefined;
  private probeSequence = 0;
  private probe: { id: string; startedAt: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Server heartbeat interval once negotiated; null keeps the legacy probe model. */
  private heartbeatMs: number | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private liveness: { id: string; startedAt: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly livenessProbeIds = new Set<string>();
  /** Hidden time never counts against the route: frozen pages receive nothing. */
  private visibleSince = Date.now();
  private wasVisible = true;

  failureDiagnostic: TransportFailureDiagnostic | undefined;

  get probeAgeMs(): number { return this.probe ? Math.max(0, Date.now() - this.probe.startedAt) : 0; }
  get isClosed(): boolean { return this.closed; }
  // close() accepting the request is distinct from a terminal notification or
  // remote execution acknowledgement. A throwing provider retains this debt.
  get closeAccepted(): boolean { return this.socketCloseAccepted; }
  get isReady(): boolean { return this.phase === "ready" && !this.closed; }

  constructor(
    private readonly url: string,
    readonly attemptId: string,
    private readonly createSocket: (url: string) => WebSocket = value => new WebSocket(value),
    handshakeTimeoutMs = 20_000,
    private readonly reportFailure = reportAppHostConnectionFailure,
    private readonly probeTimeoutMs = 60_000,
    private readonly isVisible: () => boolean = () => true,
    private readonly pageContext: () => PagePauseDiagnostic = () => ({}),
    private readonly validated: () => void = () => {},
  ) {
    this.socket = createSocket(url);
    this.live = this.socket;
    this.outgoing = new WebSocketSendProgress(this.socket);
    this.handshakeTimer = globalThis.setTimeout(() => {
      this.fail("App Host handshake timed out", "handshake-timeout", undefined, undefined,
        { timeoutMs: handshakeTimeoutMs, timerLateMs: Math.max(0, Date.now() - this.startedAt - handshakeTimeoutMs) });
    }, handshakeTimeoutMs);
    this.attach(this.socket);
  }

  /** Install handlers that act only while `socket` is this port's live route. */
  private attach(socket: WebSocket): void {
    socket.addEventListener("open", () => {
      if (this.closed || socket !== this.live) return;
      if (this.resuming) { this.sendResumeHello(socket); return; }
      this.phase = "socket-open";
      for (const frame of this.queued.splice(0)) this.outgoing.send(frame);
    });
    socket.addEventListener("message", event => {
      if (this.closed || socket !== this.live) return;
      this.lastMessageAt = Date.now();
      // Any server frame answers an outstanding liveness check.
      if (this.liveness) this.clearLiveness();
      try {
        const data = String(event.data);
        let message = JSON.parse(data);
        if (message?.type === "connection/heartbeat") return;
        if (this.resuming) { this.receiveResumeReply(message); return; }
        if (message?.type === "connection/ack") {
          if (!this.resume || !this.resume.link.acknowledge(message.received)) throw new Error("Invalid acknowledgement");
          return;
        }
        if (this.phase === "ready" && message?.type === "ready") throw new Error("Duplicate ready");
        if (this.resume && (!message || typeof message !== "object" || !("seq" in message))) throw new Error("Missing sequence");
        if (this.resume && message && typeof message === "object" && "seq" in message) {
          if (!isSequence(message.seq)) throw new Error("Invalid sequence");
          const arrival = this.resume.link.accept(message.seq, utf8Length(data));
          if (arrival === "duplicate") return;
          if (arrival === "gap") throw new Error("Sequence gap");
          const { seq: _seq, ...body } = message;
          message = body;
          this.scheduleAck();
        }
        if (message?.type === "ready") {
          this.phase = "ready";
          this.supportsProbe = message.capabilities?.connectionProbe === true;
          const heartbeatMs = message.capabilities?.heartbeatMs;
          if (typeof heartbeatMs === "number" && Number.isFinite(heartbeatMs) && heartbeatMs >= 1_000 && heartbeatMs <= 60_000)
            this.startLiveness(heartbeatMs);
          const grant = message.capabilities?.resume === undefined ? null : parseResumeGrant(message.capabilities.resume);
          if (grant && this.hello) this.resume = { grant, link: new ResumeLink<string>({ maxBytes: RESUME_CLIENT_MAX_BYTES }), ackTimer: null };
          this.clearHandshakeTimer();
        }
        if (message?.type === "response" && this.livenessProbeIds.delete(message.requestId)) return;
        const probe = this.probe;
        if (probe && message?.type === "response" && message.requestId === probe.id && message.ok === true) {
          this.lastProbeRttMs = Math.max(0, Date.now() - probe.startedAt);
          this.cancelProbe();
          this.validated();
          return;
        }
        this.publish(message);
      }
      catch { this.fail("Invalid App Host response", "invalid-response"); }
    });
    socket.addEventListener("close", event => {
      if (this.closed || socket !== this.live) return;
      if (this.resuming) { this.resumeAttemptFailed(); return; }
      this.lost({ message: "App Host connection closed", failure: "socket-close", closeCode: event.code, wasClean: event.wasClean });
    });
    socket.addEventListener("error", () => {
      if (this.closed || socket !== this.live) return;
      if (this.resuming) { this.resumeAttemptFailed(); return; }
      this.lost({ message: "App Host connection failed", failure: "socket-error" });
    });
  }

  /** Number of times this port continued its session on a new socket. */
  get resumedCount(): number { return this.resumes; }

  /** A working route died: continue the same session on a new socket when negotiated, else fail. */
  private lost(cause: LostRoute): void {
    if (this.closed || this.resuming) return;
    if (this.resume === null || this.phase !== "ready" || this.outgoing.watching) {
      this.fail(cause.message, cause.failure, cause.closeCode, cause.wasClean, cause.timing);
      return;
    }
    this.cancelProbe();
    this.clearLiveness();
    if (this.resume.ackTimer !== null) globalThis.clearTimeout(this.resume.ackTimer);
    this.resume.ackTimer = null;
    const dead = this.socket;
    this.live = null;
    try { dead.close(); } catch { /* The replacement does not depend on the old socket closing. */ }
    this.resuming = { startedAt: Date.now(), attempts: 0, timer: null, handshake: null, cause };
    this.tryResume();
  }

  private tryResume(): void {
    const resuming = this.resuming;
    if (this.closed || resuming === null) return;
    resuming.timer = null;
    if (Date.now() - resuming.startedAt >= RESUME_ATTEMPT_MS) { this.abandonResume(); return; }
    resuming.attempts++;
    const url = new URL(this.url);
    url.searchParams.set("attempt", globalThis.crypto?.randomUUID?.() ?? `client-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);
    let socket: WebSocket;
    try { socket = this.createSocket(url.href); }
    catch { this.resumeAttemptFailed(); return; }
    this.socket = socket;
    this.live = socket;
    this.outgoing.dispose();
    this.outgoing = new WebSocketSendProgress(socket);
    resuming.handshake = globalThis.setTimeout(() => {
      if (this.resuming === resuming && this.live === socket) this.resumeAttemptFailed();
    }, Math.min(RESUME_HANDSHAKE_MS, RESUME_ATTEMPT_MS - (Date.now() - resuming.startedAt)));
    this.attach(socket);
    if (socket.readyState === 1) this.sendResumeHello(socket);
  }

  private sendResumeHello(socket: WebSocket): void {
    if (!this.resume || !this.hello) return;
    try { socket.send(JSON.stringify({ ...this.hello, heartbeat: true, resume: {
      v: RESUME_PROTOCOL_VERSION, sessionId: this.resume.grant.sessionId, token: this.resume.grant.token, received: this.resume.link.received,
    } })); } catch { this.resumeAttemptFailed(); }
  }

  private receiveResumeReply(message: { type?: unknown; received?: unknown }): void {
    const resuming = this.resuming!, resume = this.resume!;
    if (message?.type === "connection/resume-failed") { this.abandonResume(); return; }
    if (message?.type !== "connection/resumed" || !isAcknowledgement(message.received)) { this.abandonResume(); return; }
    const replay = resume.link.replay(message.received);
    if (replay === null) { this.abandonResume(); return; }
    if (resuming.handshake !== null) globalThis.clearTimeout(resuming.handshake);
    this.resuming = null;
    this.resumes++;
    this.visibleSince = Date.now();
    for (const frame of replay) this.outgoing.send(frame.data);
    // Anything received before the route died may still be unacknowledged.
    this.scheduleAck();
  }

  private resumeAttemptFailed(): void {
    const resuming = this.resuming;
    if (this.closed || resuming === null) return;
    if (resuming.handshake !== null) globalThis.clearTimeout(resuming.handshake);
    resuming.handshake = null;
    const failed = this.live;
    this.live = null;
    try { failed?.close(); } catch { /* A failed attempt socket owns no session state. */ }
    const remaining = RESUME_ATTEMPT_MS - (Date.now() - resuming.startedAt);
    if (remaining <= 0) { this.abandonResume(); return; }
    const delay = Math.min(remaining, exponentialBackoffMs(resuming.attempts - 1, { initialMs: 500, maxMs: 8_000 }));
    resuming.timer = globalThis.setTimeout(() => this.tryResume(), delay);
  }

  /** Foreground/online hint during resumption: try again now instead of after the backoff. */
  private resumeNow(): void {
    const resuming = this.resuming;
    if (this.closed || resuming === null || resuming.timer === null) return;
    globalThis.clearTimeout(resuming.timer);
    this.tryResume();
  }

  /** Resumption is not possible: fall back to the ordinary full reconnect. */
  private abandonResume(): void {
    const resuming = this.resuming;
    if (resuming === null) return;
    if (resuming.timer !== null) globalThis.clearTimeout(resuming.timer);
    if (resuming.handshake !== null) globalThis.clearTimeout(resuming.handshake);
    this.resuming = null;
    if (this.resume?.ackTimer != null) globalThis.clearTimeout(this.resume.ackTimer);
    this.resume?.link.dispose();
    this.resume = null;
    const attempt = this.live;
    this.live = null;
    try { attempt?.close(); } catch { /* Fallback proceeds regardless. */ }
    const cause = resuming.cause;
    this.fail(cause.message, cause.failure, cause.closeCode, cause.wasClean, cause.timing);
  }

  private scheduleAck(): void {
    const resume = this.resume;
    if (!resume || this.resuming) return;
    const due = resume.link.acknowledgementDue;
    if (!due) return;
    const flush = () => {
      resume.ackTimer = null;
      if (this.closed || this.resuming || this.resume !== resume || this.live?.readyState !== 1) return;
      try { this.outgoing.send(JSON.stringify({ type: "connection/ack", received: resume.link.acknowledged() })); }
      catch { this.lost({ message: "App Host acknowledgement failed", failure: "socket-error" }); }
    };
    if (due === "now") { if (resume.ackTimer !== null) globalThis.clearTimeout(resume.ackTimer); flush(); }
    else if (resume.ackTimer === null) resume.ackTimer = globalThis.setTimeout(flush, RESUME_ACK_DELAY_MS);
  }

  /** Number a frame for the session and retain it until the server acknowledges it. */
  private sequence(message: RendererToAppHostMessage): string | null {
    const resume = this.resume;
    if (!resume || message.type === "hello") return null;
    const seq = resume.link.next();
    const frame = JSON.stringify({ ...message, seq });
    resume.link.retain(seq, frame, utf8Length(frame));
    return frame;
  }

  postMessage(message: RendererToAppHostMessage): void {
    if (this.closed) throw new Error("App Host connection is closed");
    // While a resumable route is replaced, frames are numbered and retained; the
    // resumed socket replays them, so the caller sees no interruption.
    if (this.resuming) {
      if (!this.sequence(message)) throw new Error("App Host connection is unavailable");
      return;
    }
    if (message.type === "hello") this.hello = { ...message };
    // Heartbeats and resumption are WebSocket-route concerns; other App Host ports never see them.
    const frame = this.sequence(message) ?? JSON.stringify(message.type === "hello"
      ? { ...message, heartbeat: true, resume: { v: RESUME_PROTOCOL_VERSION } } : message);
    if (this.socket.readyState === 1) {
      try { this.outgoing.send(frame); }
      catch (error) { this.fail("App Host send failed", "socket-error"); throw error; }
    }
    else if (this.socket.readyState === 0 && this.queued.length < 16) this.queued.push(frame);
    else throw new Error("App Host connection is unavailable");
  }

  postMessageWithProgress(message: RendererToAppHostMessage, signal: AbortSignal | undefined, progress: TransportSendProgressOptions): void {
    if (this.closed || this.resuming || this.socket.readyState !== 1) throw new Error("App Host connection is unavailable");
    signal?.throwIfAborted();
    try { this.outgoing.send(this.sequence(message) ?? JSON.stringify(message), signal, progress); }
    catch (error) {
      // A refused local write cannot remain retained and later replay behind a
      // caller's non-dispatch retry. Retire the logical owner conservatively.
      this.fail("App Host send failed", "socket-error");
      throw error;
    }
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.delete(listener);
  }

  start(): void {}

  probeReachability(): void {
    if (this.resuming) return;
    // A negotiated heartbeat already proves the route; skip the slow legacy probe.
    if (this.heartbeatMs !== null) return;
    if (this.closed || !this.supportsProbe || this.phase !== "ready" || this.probe !== null || !this.isVisible()) return;
    const id = `${this.attemptId}:probe:${++this.probeSequence}`;
    const startedAt = Date.now();
    const check = () => {
      if (this.closed || this.probe?.id !== id) return;
      if (!this.isVisible()) { this.probe = null; return; }
      // Browser JS cannot observe partial messages or native Pong. Allow a full
      // minute without application progress; a missing probe alone is not death.
      const idleMs = Date.now() - Math.max(startedAt, this.lastMessageAt ?? startedAt);
      if (idleMs < this.probeTimeoutMs && Date.now() - startedAt < this.probeTimeoutMs * 5) {
        this.probe.timer = globalThis.setTimeout(check, Math.max(1, Math.min(this.probeTimeoutMs - idleMs, this.probeTimeoutMs * 5 - (Date.now() - startedAt))));
        return;
      }
      this.lost({ message: "App Host reachability probe timed out", failure: "probe-timeout",
        timing: { timeoutMs: this.probeTimeoutMs, timerLateMs: Math.max(0, Date.now() - startedAt - this.probeTimeoutMs) } });
    };
    const timer = globalThis.setTimeout(check, this.probeTimeoutMs);
    this.probe = { id, timer, startedAt };
    try { this.postMessage({ type: "connection/probe", requestId: id }); }
    catch { this.lost({ message: "App Host connection failed", failure: "socket-error" }); }
  }

  cancelProbe(): void {
    if (this.probe !== null) globalThis.clearTimeout(this.probe.timer);
    this.probe = null;
  }

  /** Foreground/online hint. A heartbeat route silent for more than one and a
   * half intervals must answer a short probe before it is trusted again. */
  revalidate(): void {
    if (this.resuming) { this.resumeNow(); return; }
    if (this.closed || this.heartbeatMs === null || this.phase !== "ready" || !this.isVisible()) return;
    this.wasVisible = true;
    const silentMs = Date.now() - (this.lastMessageAt ?? this.startedAt);
    if (silentMs > this.heartbeatMs * 1.5) this.beginLivenessCheck();
  }

  private startLiveness(heartbeatMs: number): void {
    if (this.livenessTimer !== null) return;
    this.heartbeatMs = heartbeatMs;
    this.cancelProbe();
    this.visibleSince = Date.now();
    this.livenessTimer = globalThis.setInterval(() => this.livenessTick(), LIVENESS_TICK_MS);
  }

  private livenessTick(): void {
    if (this.closed || this.heartbeatMs === null) return;
    if (!this.isVisible()) { this.wasVisible = false; this.clearLiveness(); return; }
    if (!this.wasVisible) { this.wasVisible = true; this.visibleSince = Date.now(); }
    const base = Math.max(this.lastMessageAt ?? this.startedAt, this.visibleSince);
    if (Date.now() - base > this.heartbeatMs * LIVENESS_STALE_INTERVALS) this.beginLivenessCheck();
  }

  private beginLivenessCheck(): void {
    if (this.resuming) return;
    if (this.closed || this.liveness !== null) return;
    const id = `${this.attemptId}:liveness:${++this.probeSequence}`;
    const startedAt = Date.now();
    const timer = globalThis.setTimeout(() => {
      if (this.closed || this.liveness?.id !== id) return;
      this.liveness = null;
      // A page frozen during the check has not observed the route; retry later.
      if (!this.isVisible()) return;
      if ((this.lastMessageAt ?? 0) >= startedAt) return;
      this.lost({ message: "App Host liveness check timed out", failure: "liveness-timeout",
        timing: { timeoutMs: LIVENESS_CHECK_MS, timerLateMs: Math.max(0, Date.now() - startedAt - LIVENESS_CHECK_MS) } });
    }, LIVENESS_CHECK_MS);
    this.liveness = { id, startedAt, timer };
    if (this.livenessProbeIds.size >= 16) this.livenessProbeIds.clear();
    this.livenessProbeIds.add(id);
    try { this.postMessage({ type: "connection/probe", requestId: id }); }
    catch { this.lost({ message: "App Host connection failed", failure: "socket-error" }); }
  }

  private clearLiveness(): void {
    if (this.liveness !== null) globalThis.clearTimeout(this.liveness.timer);
    this.liveness = null;
  }

  close(): void {
    if (!this.closed) {
      // An intentional close releases a resumable server session at once instead of after its window.
      if (this.resume && !this.resuming && this.socket.readyState === 1) {
        try { this.outgoing.send(JSON.stringify({ type: "connection/end" })); } catch { /* The server window still bounds it. */ }
      }
      const resuming = this.resuming;
      if (resuming?.timer) globalThis.clearTimeout(resuming.timer);
      if (resuming?.handshake) globalThis.clearTimeout(resuming.handshake);
      this.resuming = null;
      if (this.resume?.ackTimer) globalThis.clearTimeout(this.resume.ackTimer);
      this.resume?.link.dispose();
      this.resume = null;
      this.live = null;
      this.closed = true;
      this.outgoing.dispose();
      this.clearHandshakeTimer();
      this.cancelProbe();
      this.clearLiveness();
      if (this.livenessTimer !== null) globalThis.clearInterval(this.livenessTimer);
      this.livenessTimer = null;
      this.queued.length = 0;
      this.listeners.clear();
    }
    if (!this.socketCloseAccepted) {
      this.socket.close();
      this.socketCloseAccepted = true;
    }
  }

  private publish(data: unknown): void {
    const event = new MessageEvent("message", { data });
    for (const listener of this.listeners) listener(event);
  }

  private fail(message: string, failure: AppHostFailure, closeCode?: number, wasClean?: boolean,
    timing: { timeoutMs: number; timerLateMs: number } | undefined = undefined): void {
    if (this.closed) return;
    this.failureDiagnostic = {
      attemptId: this.attemptId, occurredAt: new Date().toISOString(),
      phase: this.phase, failure,
      ...(closeCode === undefined ? {} : { closeCode }),
    };
    try {
      this.reportFailure({
        attemptId: this.attemptId,
        failure,
        phase: this.phase,
        readyState: this.socket.readyState,
        ageMs: Math.max(0, Date.now() - this.startedAt),
        eventAtMs: Date.now(), visibility: this.isVisible() ? "visible" : "hidden",
        networkState: typeof navigator === "undefined" || typeof navigator.onLine !== "boolean"
          ? "unknown" : navigator.onLine ? "online" : "offline",
        bufferedBytes: this.socket.bufferedAmount ?? 0,
        ...(wasClean === undefined ? {} : { wasClean: wasClean ? 1 as const : 0 as const }),
        ...(this.lastMessageAt === undefined ? {} : { lastMessageAgoMs: Math.max(0, Date.now() - this.lastMessageAt) }),
        ...(this.probe === null ? {} : { probeElapsedMs: Math.max(0, Date.now() - this.probe.startedAt) }),
        ...(this.lastProbeRttMs === undefined ? {} : { lastProbeRttMs: this.lastProbeRttMs }),
        ...timing,
        ...this.pageContext(),
        ...(closeCode === undefined ? {} : { closeCode }),
      });
    } catch { /* Diagnostics must never alter transport behavior. */ }
    this.publish({ type: "fatal", error: { code: "APP_HOST_DISCONNECTED", message, retryable: true } });
    this.close();
  }

  private clearHandshakeTimer(): void {
    globalThis.clearTimeout(this.handshakeTimer);
  }
}

// Workbench keeps one transport object for its lifetime. A closed WebSocket
// invalidates its AppHost client and lease, so reconnect must replace the
// lease *inside* that object rather than ask Workbench to create another one.
class RenewableAppHostTransport implements DuplexTransport {
  private lease: DuplexTransport | null = null;
  private removeMessageListener: (() => void) | null = null;
  private removeStatusListener: (() => void) | null = null;
  private readonly messageListeners = new ClientObserverList<string>();
  private readonly statusListeners = new TransportStatusObservers();
  private readonly recoveryListeners = new Set<() => void>();
  private currentStatus: TransportStatus = { state: "idle" };
  private attempt: { readonly controller: AbortController; readonly promise: Promise<void>;
    cancel(reason: unknown, retirement?: TransportStatus): void } | null = null;
  // Physical lease release is serialized independently of local attempt cancellation.
  private closeBarrier: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly createLease: (assertCurrent: () => void, waiting: (delayMs: number) => void) => Promise<{ transport: DuplexTransport; attemptId: string; diagnostic: () => TransportFailureDiagnostic | undefined; subscribeStage(listener: (stage: "bridge" | "host") => void): () => void }>, private readonly onClose: () => void, private readonly beforeConnect?: () => Promise<void>) {}

  get status(): TransportStatus { return this.currentStatus; }

  connect(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error("App Host transport is closed"));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Connection cancelled"));
    if (this.currentStatus.state === "open" && this.lease && !this.captureMessageScope()()) {
      const native = this.lease.status;
      const retirement: TransportStatus = { ...(native.state === "open" ? { state: "closed" as const } : native),
        attemptId: this.currentStatus.attemptId };
      if (this.attempt) this.attempt.cancel(new Error(retirement.reason ?? "App Host connection retired"), retirement);
      else this.setStatus(retirement);
    }
    if (this.attempt !== null) return this.attempt.promise;
    if (this.currentStatus.state === "open") return Promise.resolve();
    let resolve!: () => void, reject!: (cause: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    void promise.catch(() => undefined);
    const controller = new AbortController();
    let removeStage: (() => void) | undefined;
    const cleanup = () => { signal?.removeEventListener("abort", abort); removeStage?.(); };
    const attempt = { controller, promise, cancel: (cause: unknown, retirement?: TransportStatus) => {
      if (this.attempt !== attempt) return;
      this.attempt = null;
      cleanup();
      // Detach callbacks and install the physical barrier before abort/status reentry.
      this.retireLease();
      controller.abort(cause);
      reject(cause);
      if (!this.closed && this.currentStatus.state !== "failed")
        this.setStatus(retirement ?? { state: "failed", reason: cause instanceof Error ? cause.message : String(cause),
          ...(cause instanceof AppHostAdmissionError ? { failure: cause.failure } : {}) });
    } };
    const abort = () => attempt.cancel(signal?.reason ?? new Error("Connection cancelled"));
    this.attempt = attempt;
    signal?.addEventListener("abort", abort, { once: true });
    const assertCurrent = () => {
      if (this.closed || this.attempt !== attempt || controller.signal.aborted)
        throw controller.signal.reason ?? new Error("Connection was superseded");
    };
    // One cancellable local wait per operation. Old external work can finish later,
    // but every continuation checks its owner before allocating or publishing.
    const revoked = new Promise<never>((_, fail) => {
      controller.signal.addEventListener("abort", () => fail(controller.signal.reason), { once: true });
    });
    void revoked.catch(() => undefined);
    const wait = async <T>(operation: Promise<T>): Promise<T> => {
      const result = await Promise.race([operation, revoked]);
      assertCurrent();
      return result;
    };
    const run = async () => {
      assertCurrent();
      this.setStatus({ state: "connecting", connectionStage: "admission" });
      assertCurrent();
      await wait(Promise.resolve(this.beforeConnect?.()));
      this.setStatus({ state: "connecting", connectionStage: "release" });
      assertCurrent();
      // Cancellation cannot bypass a physical close already started by an old lease.
      this.retireLease();
      await wait(this.closeBarrier);
      const acquired = await this.createLease(assertCurrent, retryAfterMs => {
        assertCurrent();
        this.setStatus({ state: "connecting", connectionStage: "retry", retryAfterMs });
      });
      try { assertCurrent(); }
      catch (cause) {
        // Acquisition may finish in the microtask after local cancellation.
        // Release only this lease; healthy peers keep their physical socket.
        this.closeBarrier = this.closeBarrier.then(() => acquired.transport.close()).catch(() => undefined);
        throw cause;
      }
      const next = acquired.transport;
      this.lease = next;
      this.removeMessageListener = next.subscribeMessage(frame => {
        if (this.lease !== next) return;
        this.messageListeners.emit(frame, this.captureMessageScope());
      });
      this.removeStatusListener = next.subscribeStatus(status => {
        if (this.lease !== next) return;
        const diagnostic = acquired.diagnostic();
        this.setStatus({ ...status, attemptId: acquired.attemptId, ...(status.failure && diagnostic
          ? { failure: { ...status.failure, diagnostic } } : {}) });
      });
      // Install observers before I/O. Stage notifications grant no readiness.
      removeStage = acquired.subscribeStage(stage => {
        if (this.attempt === attempt) this.setStatus({ state: "connecting", connectionStage: stage, attemptId: acquired.attemptId });
      });
      assertCurrent();
      await wait(next.connect(controller.signal));
      assertCurrent();
    };
    void run().then(() => {
      if (this.attempt !== attempt) return;
      this.attempt = null;
      cleanup();
      resolve();
    }, cause => { cleanup(); attempt.cancel(cause); });
    return promise;
  }

  private retireLease(): void {
    const previous = this.lease;
    this.lease = null;
    this.detachLease();
    if (previous) this.closeBarrier = this.closeBarrier.then(() => previous.close()).catch(() => undefined);
  }

  send(frame: string, signal?: AbortSignal, progress?: TransportSendProgressOptions): Promise<void> {
    if (this.closed || this.lease === null) return Promise.reject(new Error("App Host transport is not open"));
    return this.lease.send(frame, signal, progress);
  }

  captureMessageScope(): () => boolean {
    const lease = this.lease;
    const native = lease ? captureTransportMessageScope(lease) : () => false;
    return () => !this.closed && this.lease === lease && native();
  }
  subscribeMessage(listener: (frame: string) => void): () => void {
    return this.messageListeners.subscribe(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    return this.statusListeners.subscribe(listener);
  }

  subscribeRecoveryHint(listener: () => void): () => void {
    this.recoveryListeners.add(listener);
    return () => this.recoveryListeners.delete(listener);
  }

  notifyRecoveryHint(): void {
    for (const listener of this.recoveryListeners) listener();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    this.recoveryListeners.clear();
    this.attempt?.cancel(new Error("App Host transport is closed"));
    this.retireLease();
    this.setStatus({ state: "closing" });
    await this.closeBarrier;
    this.setStatus({ state: "closed" });
    this.messageListeners.clear();
    this.statusListeners.clear();
  }

  private detachLease(): void {
    this.removeMessageListener?.();
    this.removeStatusListener?.();
    this.removeMessageListener = null;
    this.removeStatusListener = null;
  }

  private setStatus(status: TransportStatus): void {
    this.currentStatus = status;
    this.statusListeners.emit(status, () => this.currentStatus === status);
  }
}

export function connectWebSocketAppHost(
  createSocket?: (url: string) => WebSocket,
  options: {
    readonly handshakeTimeoutMs?: number;
    readonly probeTimeoutMs?: number;
    /** Minimum spacing of recovery hints produced only by the periodic route check. */
    readonly periodicHintIntervalMs?: number;
    readonly recoveryEvents?: AppHostRecoveryEvents;
    readonly reportFailure?: (diagnostic: AppHostConnectionDiagnostic) => void;
    readonly path?: "/apphost" | "/ssh-apphost";
    /** Revalidate private admission through its existing owner before opening a socket. */
    readonly beforeConnect?: () => Promise<void>;
    /** Explicit physical retry schedule; defaults use exponential backoff with jitter. */
    readonly retryDelaysMs?: readonly number[];
  } = {},
): { createTransport(hostId: string): DuplexTransport; close(): void } {
  let current: { port: WebSocketAppHostPort; client: MessagePortAppHostClient } | null = null;
  let disposed = false;
  let closing = false;
  let recoveryDetached = false;
  const transports = new Set<RenewableAppHostTransport>();
  // Shared physical admission: logical Host retries and direct IM connects
  // consume the same failure budget, regardless of their local schedulers.
  let failures = 0;
  let retryAt = 0;
  let readyAt: number | null = null;
  let admission: { promise: Promise<void>; finish(): void; timer: ReturnType<typeof setTimeout> } | null = null;
  const failed = () => {
    // A lost established route restarts the schedule; refusals still escalate.
    if (wasEstablished(readyAt, Date.now())) failures = 0;
    readyAt = null;
    retryAt = Date.now() + retryDelayMs(failures++, { schedule: options.retryDelaysMs });
  };
  const awaitPhysicalAdmission = async (assertCurrent: () => void, waiting: (delayMs: number) => void) => {
    while (true) {
      assertCurrent();
      if (disposed) throw new Error("App Host connection is closed");
      if ((current && !current.port.isClosed) || Date.now() >= retryAt) return;
      waiting(Math.max(0, retryAt - Date.now()));
      if (admission === null) {
        let finish!: () => void;
        const promise = new Promise<void>(resolve => { finish = resolve; });
        const timer = globalThis.setTimeout(() => {
          admission = null;
          finish();
        }, Math.max(1, retryAt - Date.now()));
        admission = { promise, finish, timer };
      }
      // Canceling one logical waiter never tears down this shared admission.
      await admission.promise;
    }
  };
  // Read-only validation: no logical lease or business request on a candidate.
  let validation: { cancel(): void } | null = null;
  let lastValidationAt = Number.NEGATIVE_INFINITY;
  const validateReplacement = () => {
    const old = current;
    if (!old || old.port.isClosed || old.port.probeAgeMs < 15_000 || validation
      || Date.now() - lastValidationAt < 60_000 || Date.now() < retryAt) return;
    lastValidationAt = Date.now();
    let candidate: { port: WebSocketAppHostPort; client: MessagePortAppHostClient } | undefined;
    let stopped = false;
    const token = { cancel() {
      if (stopped) return;
      stopped = true; globalThis.clearTimeout(timer);
      if (validation === token) validation = null;
      candidate?.client.close();
    } };
    const timer = globalThis.setTimeout(() => token.cancel(), 25_000);
    validation = token;
    void Promise.resolve().then(async () => {
      await options.beforeConnect?.();
      if (stopped || disposed || current !== old || !events.isVisible() || old.port.probeAgeMs < 15_000) { token.cancel(); return; }
      const url = new URL(serverUrl(options.path ?? "/apphost"), window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const id = globalThis.crypto?.randomUUID?.() ?? "validation-" + Date.now();
      url.searchParams.set("attempt", id);
      const port = new WebSocketAppHostPort(url.href, id, createSocket,
        options.handshakeTimeoutMs ?? 20_000,
        diagnostic => {
          if (current?.port === port) failed();
          (options.reportFailure ?? reportAppHostConnectionFailure)(diagnostic);
          queueMicrotask(() => token.cancel());
        }, options.probeTimeoutMs ?? 60_000, () => events.isVisible(),
        () => events.diagnosticContext?.() ?? {}, () => {
          if (stopped || disposed || current !== old || !candidate || !events.isVisible()
            || old.port.probeAgeMs < 15_000) { token.cancel(); return; }
          // Retain the old owner's cleanup debt until native close is accepted.
          // Reentrant connect runs asynchronously; disposal can still win here.
          try { old.client.close(); } catch { token.cancel(); return; }
          if (!old.port.closeAccepted || disposed || current !== old) { token.cancel(); return; }
          const replacement = candidate; candidate = undefined;
          current = replacement; readyAt = Date.now();
          token.cancel();
          for (const transport of [...transports]) transport.notifyRecoveryHint();
        });
      candidate = {port, client:new MessagePortAppHostClient(port,id)};
      port.addEventListener("message", event => {
        if ((event.data as {type?:unknown})?.type === "ready") {
          queueMicrotask(() => { if (!stopped && !port.isClosed) port.probeReachability(); });
        }
      });
    }).catch(() => token.cancel());
  };
  const events = options.recoveryEvents ?? createBrowserRecoveryEvents();
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryTicket = 0;
  // Periodic checks probe the shared socket every few seconds, but their
  // recovery hints are spaced out. Otherwise a visible page converts the Host
  // retry backoff into a fixed-rate reconnect loop on a weak or absent route.
  const periodicHintIntervalMs = options.periodicHintIntervalMs ?? 30_000;
  let lastPeriodicHintAt = Number.NEGATIVE_INFINITY;
  let lastEventHintAt = Number.NEGATIVE_INFINITY;
  const stopRecoveryTimer = () => {
    ++recoveryTicket;
    if (recoveryTimer !== null) globalThis.clearTimeout(recoveryTimer);
    recoveryTimer = null;
  };
  const scheduleRecoveryCheck = () => {
    if (disposed || recoveryTimer !== null || transports.size === 0 || !events.isVisible()) return;
    // Mobile routes can recover without an online/visibility event. This is a
    // shared physical-route observation, never a second Host retry scheduler.
    const ticket = ++recoveryTicket;
    recoveryTimer = globalThis.setTimeout(() => {
      if (ticket !== recoveryTicket) return;
      recoveryTimer = null;
      checkRecovery(true);
    }, 5_000);
  };
  const checkRecovery = (periodic = false) => {
    if (disposed) return;
    // A backgrounded page cannot spend its foreground probe deadline.
    if (!events.isVisible()) { stopRecoveryTimer(); current?.port.cancelProbe(); validation?.cancel(); return; }
    if (transports.size === 0) return;
    // Lifecycle/online events demand a fast answer from a silent heartbeat route.
    if (!periodic) current?.port.revalidate();
    current?.port.probeReachability();
    validateReplacement();
    // Arm before notifying consumers: synchronous disposal must cancel this
    // owner's timer, and a subscriber cannot create duplicate periodic work.
    scheduleRecoveryCheck();
    if (periodic) {
      const now = Date.now();
      if (now - lastPeriodicHintAt < periodicHintIntervalMs) return;
      lastPeriodicHintAt = now;
    }
    if (!periodic) {
      if (Date.now() - lastEventHintAt < 5_000) return;
      lastEventHintAt = Date.now();
    }
    for (const transport of [...transports]) {
      if (disposed) break;
      if (transports.has(transport)) transport.notifyRecoveryHint();
    }
  };
  // Page lifecycle and network events are explicit foreground hints.
  let lastRouteValidationAt = Number.NEGATIVE_INFINITY;
  const unsubscribeRecovery = events.subscribe(reason => {
    // Only explicit browser route/lifecycle events can spend this exception.
    // Periodic hints and ordinary IM demand retain the shared failure budget.
    if (events.isVisible() && ["online", "pageshow", "resume", "visibilitychange"].includes(reason ?? "")
      && (!current || current.port.isClosed) && Date.now() - lastRouteValidationAt >= 30_000) {
      lastRouteValidationAt = Date.now();
      retryAt = Date.now();
      if (admission) {
        const waiting = admission; admission = null;
        globalThis.clearTimeout(waiting.timer); waiting.finish();
      }
    }
    checkRecovery();
  });
  const retireCurrent = (): boolean => {
    const owner = current;
    if (owner === null) return true;
    owner.client.close();
    // Client.close may have joined a synchronous termination already in flight.
    // Its return alone cannot release the parent while raw close is unresolved.
    if (!owner.port.closeAccepted) return false;
    if (current === owner) current = null;
    return true;
  };
  return {
    createTransport(hostId) {
      if (disposed) throw new Error("App Host connection is closed");
      const transport = new RenewableAppHostTransport(async (assertCurrent, waiting) => {
        do {
          const delayed = (!current || current.port.isClosed) && Date.now() < retryAt;
          await awaitPhysicalAdmission(assertCurrent, waiting);
          assertCurrent();
          // Private admission may have expired while the physical cooldown ran.
          if (delayed) {
            await options.beforeConnect?.();
            assertCurrent();
          }
        } while ((!current || current.port.isClosed) && Date.now() < retryAt);
        assertCurrent();
        if (disposed) throw new Error("App Host connection is closed");
        if (current?.port.isClosed && !retireCurrent()) throw new Error("App Host Socket cleanup is in progress");
        // A raw provider callback can synchronously dispose the whole factory.
        if (disposed) throw new Error("App Host connection is closed");
        if (current === null || current.port.isClosed) {
          const url = new URL(serverUrl(options.path ?? "/apphost"), window.location.href);
          url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
          const id = globalThis.crypto?.randomUUID?.() ?? `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          url.searchParams.set("attempt", id);
          let port: WebSocketAppHostPort;
          try {
            port = new WebSocketAppHostPort(
              url.href,
              id,
              createSocket,
              options.handshakeTimeoutMs ?? 20_000,
              diagnostic => {
                failed();
                (options.reportFailure ?? reportAppHostConnectionFailure)(diagnostic);
              },
              options.probeTimeoutMs ?? 60_000,
              () => events.isVisible(),
              () => events.diagnosticContext?.() ?? {},
            );
          } catch (error) { failed(); throw error; }
          port.addEventListener("message", event => {
            if ((event.data as { type?: unknown })?.type === "ready") readyAt = Date.now();
          });
          try { current = { port, client: new MessagePortAppHostClient(port, id) }; }
          catch (error) { port.close(); throw error; }
        }
        const leaseOwner = current;
        return { transport: leaseOwner.client.createTransport(hostId), attemptId: leaseOwner.port.attemptId,
          diagnostic: () => leaseOwner.port.failureDiagnostic,
          subscribeStage(listener) {
            const ready = (event: MessageEvent<unknown>) => {
              if ((event.data as { type?: unknown })?.type === "ready") listener("host");
            };
            leaseOwner.port.addEventListener("message", ready);
            listener(leaseOwner.port.isReady ? "host" : "bridge");
            return () => leaseOwner.port.removeEventListener("message", ready);
          },
        };
      }, () => {
        transports.delete(transport);
        if (transports.size === 0) stopRecoveryTimer();
      }, options.beforeConnect);
      transports.add(transport);
      scheduleRecoveryCheck();
      return transport;
    },
    close() {
      disposed = true;
      validation?.cancel();
      if (admission) {
        globalThis.clearTimeout(admission.timer);
        admission.finish();
        admission = null;
      }
      stopRecoveryTimer();
      if (closing) return;
      closing = true;
      try {
        // Every local channel loses write authority before external disposers.
        for (const transport of [...transports]) void transport.close().catch(() => undefined);
        const errors: unknown[] = [];
        try { retireCurrent(); } catch (cause) { errors.push(cause); }
        if (!recoveryDetached) {
          try { unsubscribeRecovery(); recoveryDetached = true; }
          catch (cause) { errors.push(cause); }
        }
        if (errors.length) throw new AggregateError(errors, "App Host connection cleanup failed");
      } finally { closing = false; }
    },
  };
}
