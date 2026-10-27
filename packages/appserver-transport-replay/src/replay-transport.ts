import type {
  DuplexTransport,
  TransportStatus,
} from "@opencraft/appserver-client/transport";
import { ClientObserverList, TransportStatusObservers } from "@opencraft/appserver-client/transport";

import type { RecordedFrame } from "./recording";

export type ReplayMatchMode = "exact" | "json-rpc";
export type ReplayTimingMode = "immediate" | "recorded";

export interface ReplayClock {
  sleep(delayMs: number): Promise<void>;
}

export interface ReplayTransportOptions {
  recording: readonly RecordedFrame[];
  match?: ReplayMatchMode;
  timing?: ReplayTimingMode;
  clock?: ReplayClock;
}

export class ReplayMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayMismatchError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown, omitEnvelopeId = false): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => !omitEnvelopeId || key !== "id")
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function parseObject(frame: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(frame) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function framesMatch(expected: string, actual: string, mode: ReplayMatchMode): boolean {
  if (mode === "exact") return expected === actual;
  const expectedValue = parseObject(expected);
  const actualValue = parseObject(actual);
  if (expectedValue === null || actualValue === null) return expected === actual;
  return JSON.stringify(canonicalize(expectedValue, true)) === JSON.stringify(canonicalize(actualValue, true));
}

interface ReplayClaim {
  readonly index: number;
  readonly frame: RecordedFrame;
}
interface ReplayDrain {
  readonly promise: Promise<void>;
  claim: ReplayClaim | null;
}
interface ReplayConnection {
  phase: "connecting" | "open" | "retired";
  readonly startup: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
  readonly revoked: Promise<never>;
  readonly revoke: (cause: unknown) => void;
  readonly requestIds: Map<string | number, string | number>;
  disposeSignal(): void;
  cause?: unknown;
  drain: ReplayDrain | null;
  cancelTimer?: () => void;
}
function replayAbort(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("Replay operation was aborted"); error.name = "AbortError"; return error;
}

export class ReplayTransport implements DuplexTransport {
  private readonly recording: readonly RecordedFrame[];
  private readonly match: ReplayMatchMode;
  private readonly timing: ReplayTimingMode;
  private readonly clock: ReplayClock | undefined;
  private readonly messageListeners = new ClientObserverList<string>();
  private readonly statusListeners = new TransportStatusObservers();
  private currentStatus: TransportStatus = { state: "idle" };
  private connection: ReplayConnection | null = null;
  private cursor = 0;
  private previousTimestampMs: number | null = null;

  constructor(options: ReplayTransportOptions | readonly RecordedFrame[]) {
    const normalized: ReplayTransportOptions = Array.isArray(options)
      ? { recording: options }
      : options as ReplayTransportOptions;
    this.recording = [...normalized.recording].sort((left, right) => left.sequence - right.sequence);
    this.match = normalized.match ?? "json-rpc";
    this.timing = normalized.timing ?? "immediate";
    this.clock = normalized.clock ?? undefined;
  }

  get status(): TransportStatus { return this.currentStatus; }
  get remainingFrames(): number { return this.recording.length - this.cursor; }

  connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(replayAbort(signal));
    if (this.connection?.phase === "open") return Promise.resolve();
    if (this.connection?.phase === "connecting") return this.connection.startup;
    let resolve!: () => void, reject!: (cause: unknown) => void, revoke!: (cause: unknown) => void;
    const startup = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const revoked = new Promise<never>((_, fail) => { revoke = fail; });
    void startup.catch(() => undefined); void revoked.catch(() => undefined);
    const owner: ReplayConnection = { phase: "connecting", startup, resolve, reject, revoked, revoke,
      requestIds: new Map(), drain: null, disposeSignal: () => signal?.removeEventListener("abort", abort) };
    const abort = () => this.failConnection(owner, replayAbort(signal));
    this.connection = owner;
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    if (!this.live(owner)) return startup;
    this.setStatus({ state: "connecting" });
    if (!this.live(owner)) return startup;
    owner.phase = "open";
    this.setStatus({ state: "open" });
    if (!this.live(owner)) return startup;
    void this.drainServerFrames(owner).then(() => {
      if (!this.live(owner)) return;
      owner.disposeSignal(); owner.resolve();
    }, cause => { this.failConnection(owner, cause); });
    return startup;
  }

  async send(frame: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw replayAbort(signal);
    const owner = this.connection;
    if (owner === null || owner.phase !== "open") throw new Error("Replay transport is not open");
    const expected = this.recording[this.cursor];
    if (expected === undefined) throw new ReplayMismatchError("Replay received an unexpected client frame after the recording ended");
    if (expected.direction !== "client-to-server") {
      throw new ReplayMismatchError(`Replay expected a server frame at sequence ${expected.sequence}`);
    }
    if (!framesMatch(expected.payload, frame, this.match)) {
      throw new ReplayMismatchError(
        `Replay client frame mismatch at sequence ${expected.sequence}\nexpected: ${expected.payload}\nactual:   ${frame}`,
      );
    }
    this.captureRequestId(owner, expected.payload, frame);
    this.cursor += 1;
    this.previousTimestampMs = expected.timestampMs;
    // Caller cancellation does not retire shared incoming native traffic.
    await this.waitCaller(this.drainServerFrames(owner), signal);
  }

  captureMessageScope(): () => boolean {
    const owner = this.connection;
    return () => owner !== null && this.live(owner) && owner.phase === "open";
  }
  subscribeMessage(listener: (frame: string) => void): () => void {
    return this.messageListeners.subscribe(listener);
  }
  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    return this.statusListeners.subscribe(listener, this.currentStatus);
  }
  async close(): Promise<void> {
    if (this.currentStatus.state === "closed" || this.currentStatus.state === "closing") return;
    if (this.connection) this.retire(this.connection, new Error("Replay transport closed"));
    const closing: TransportStatus = { state: "closing" };
    this.setStatus(closing);
    // A closing observer may already have admitted a successor.
    if (this.connection === null && this.currentStatus === closing) this.setStatus({ state: "closed" });
  }

  private live(owner: ReplayConnection): boolean {
    return this.connection === owner && owner.phase !== "retired";
  }
  private check(owner: ReplayConnection): void {
    if (!this.live(owner)) throw owner.cause ?? new Error("Replay connection retired");
  }
  private retire(owner: ReplayConnection, cause: unknown): void {
    if (!this.live(owner)) return;
    owner.phase = "retired"; owner.cause = cause; this.connection = null;
    const claim = owner.drain?.claim;
    // A delayed, already admitted server frame is consumed once on retirement.
    // It must neither block the successor nor be replayed into its connection.
    if (claim && this.cursor === claim.index) {
      this.cursor = claim.index + 1; this.previousTimestampMs = claim.frame.timestampMs;
    }
    if (owner.drain) owner.drain.claim = null;
    owner.disposeSignal(); owner.cancelTimer?.(); owner.requestIds.clear(); owner.reject(cause); owner.revoke(cause);
  }
  private failConnection(owner: ReplayConnection, cause: unknown): void {
    if (!this.live(owner)) return;
    this.retire(owner, cause);
    this.setStatus({ state: "failed", reason: cause instanceof Error ? cause.message : "Replay delivery failed" });
  }
  private drainServerFrames(owner: ReplayConnection): Promise<void> {
    if (owner.drain) return owner.drain.promise;
    let resolve!: () => void, reject!: (cause: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    void promise.catch(() => undefined);
    const drain: ReplayDrain = { promise, claim: null }; owner.drain = drain;
    const run = async () => {
      this.check(owner);
      while (this.live(owner)) {
        const next = this.recording[this.cursor];
        if (next === undefined || next.direction !== "server-to-client") {
          // Stop admitting joiners synchronously. The Promise completion can run
          // after another caller has already supplied the next client frame.
          if (owner.drain === drain) owner.drain = null;
          return;
        }
        const claim: ReplayClaim = { index: this.cursor, frame: next }; drain.claim = claim;
        if (this.timing === "recorded" && this.previousTimestampMs !== null) {
          const sleeping = this.sleep(owner, Math.max(0, next.timestampMs - this.previousTimestampMs));
          await Promise.race([sleeping, owner.revoked]);
        }
        this.check(owner);
        if (owner.drain !== drain || drain.claim !== claim || this.cursor !== claim.index)
          throw new Error("Replay frame reservation lost");
        drain.claim = null; this.cursor = claim.index + 1; this.previousTimestampMs = next.timestampMs;
        const payload = this.rewriteResponseId(owner, next.payload);
        this.messageListeners.emit(payload, () => this.live(owner));
      }
      this.check(owner);
    };
    void run().then(() => {
      if (owner.drain === drain) owner.drain = null;
      resolve();
    }, cause => {
      // Retire before clearing the claim so a current clock failure consumes its
      // own reserved frame, while an old failure has no successor authority.
      this.failConnection(owner, cause);
      if (owner.drain === drain) owner.drain = null;
      reject(cause);
    });
    return promise;
  }
  private waitCaller(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return promise;
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener("abort", abort);
      const abort = () => { cleanup(); reject(replayAbort(signal)); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void promise.then(() => { cleanup(); resolve(); }, cause => { cleanup(); reject(cause); });
    });
  }
  private sleep(owner: ReplayConnection, delayMs: number): Promise<void> {
    if (this.clock) return this.clock.sleep(delayMs);
    return new Promise<void>((resolve, reject) => {
      const release = () => { if (owner.cancelTimer === cancel) owner.cancelTimer = undefined; };
      const cancel = () => {
        globalThis.clearTimeout(timer); release(); reject(owner.cause ?? new Error("Replay timer retired"));
      };
      const timer = globalThis.setTimeout(() => { release(); resolve(); }, delayMs);
      owner.cancelTimer = cancel;
    });
  }
  private captureRequestId(owner: ReplayConnection, recordedFrame: string, liveFrame: string): void {
    if (this.match !== "json-rpc") return;
    const recorded = parseObject(recordedFrame), live = parseObject(liveFrame);
    const recordedId = recorded?.id, liveId = live?.id;
    if ((typeof recordedId === "string" || typeof recordedId === "number") &&
        (typeof liveId === "string" || typeof liveId === "number")) owner.requestIds.set(recordedId, liveId);
  }
  private rewriteResponseId(owner: ReplayConnection, frame: string): string {
    if (this.match !== "json-rpc") return frame;
    const value = parseObject(frame);
    if (value === null) return frame;
    const id = value.id;
    if (typeof id !== "string" && typeof id !== "number") return frame;
    const liveId = owner.requestIds.get(id);
    return liveId === undefined ? frame : JSON.stringify({ ...value, id: liveId });
  }
  private setStatus(status: TransportStatus): void {
    this.currentStatus = status;
    this.statusListeners.emit(status, () => this.currentStatus === status);
  }
}
