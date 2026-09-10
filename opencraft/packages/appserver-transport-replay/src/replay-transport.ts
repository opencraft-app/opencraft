import type {
  DuplexTransport,
  TransportStatus,
} from "@opencraft/appserver-client/transport";

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

const systemClock: ReplayClock = {
  sleep: (delayMs) => new Promise((resolve) => globalThis.setTimeout(resolve, delayMs)),
};

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

export class ReplayTransport implements DuplexTransport {
  private readonly recording: readonly RecordedFrame[];
  private readonly match: ReplayMatchMode;
  private readonly timing: ReplayTimingMode;
  private readonly clock: ReplayClock;
  private readonly messageListeners = new Set<(frame: string) => void>();
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  private readonly requestIds = new Map<string | number, string | number>();
  private currentStatus: TransportStatus = { state: "idle" };
  private cursor = 0;
  private previousTimestampMs: number | null = null;

  constructor(options: ReplayTransportOptions | readonly RecordedFrame[]) {
    const normalized: ReplayTransportOptions = Array.isArray(options)
      ? { recording: options }
      : options as ReplayTransportOptions;
    this.recording = [...normalized.recording].sort((left, right) => left.sequence - right.sequence);
    this.match = normalized.match ?? "json-rpc";
    this.timing = normalized.timing ?? "immediate";
    this.clock = normalized.clock ?? systemClock;
  }

  get status(): TransportStatus {
    return this.currentStatus;
  }

  get remainingFrames(): number {
    return this.recording.length - this.cursor;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("Replay connection was aborted");
    if (this.currentStatus.state === "open") return;
    this.setStatus({ state: "connecting" });
    this.setStatus({ state: "open" });
    await this.drainServerFrames();
  }

  async send(frame: string): Promise<void> {
    if (this.currentStatus.state !== "open") throw new Error("Replay transport is not open");
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
    this.captureRequestId(expected.payload, frame);
    this.cursor += 1;
    this.previousTimestampMs = expected.timestampMs;
    await this.drainServerFrames();
  }

  subscribeMessage(listener: (frame: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.currentStatus.state === "closed") return;
    this.setStatus({ state: "closing" });
    this.setStatus({ state: "closed" });
  }

  private async drainServerFrames(): Promise<void> {
    while (this.currentStatus.state === "open") {
      const next = this.recording[this.cursor];
      if (next === undefined || next.direction !== "server-to-client") return;
      if (this.timing === "recorded" && this.previousTimestampMs !== null) {
        await this.clock.sleep(Math.max(0, next.timestampMs - this.previousTimestampMs));
      }
      this.cursor += 1;
      this.previousTimestampMs = next.timestampMs;
      const payload = this.rewriteResponseId(next.payload);
      for (const listener of this.messageListeners) listener(payload);
    }
  }

  private captureRequestId(recordedFrame: string, liveFrame: string): void {
    if (this.match !== "json-rpc") return;
    const recorded = parseObject(recordedFrame);
    const live = parseObject(liveFrame);
    const recordedId = recorded?.id;
    const liveId = live?.id;
    if ((typeof recordedId === "string" || typeof recordedId === "number") &&
        (typeof liveId === "string" || typeof liveId === "number")) {
      this.requestIds.set(recordedId, liveId);
    }
  }

  private rewriteResponseId(frame: string): string {
    if (this.match !== "json-rpc") return frame;
    const value = parseObject(frame);
    if (value === null) return frame;
    const id = value.id;
    if (typeof id !== "string" && typeof id !== "number") return frame;
    const liveId = this.requestIds.get(id);
    if (liveId === undefined) return frame;
    return JSON.stringify({ ...value, id: liveId });
  }

  private setStatus(status: TransportStatus): void {
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }
}
