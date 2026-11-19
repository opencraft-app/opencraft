/**
 * App Host session resumption: shared wire vocabulary and the per-direction
 * sequencing engine. Environment neutral (browser and Node); the server-side
 * registry with its global memory budget lives in ./server.
 */

export const RESUME_PROTOCOL_VERSION = 1 as const;
/** How long the server keeps a detached session. Advertised to the client. */
export const RESUME_DETACH_MS = 5 * 60_000;
/** How long a client keeps trying to resume after detecting a dead route. */
export const RESUME_ATTEMPT_MS = 30_000;
/** Unacknowledged frames retained per server session. */
export const RESUME_SESSION_MAX_BYTES = 1024 * 1024;
/** Unacknowledged frames retained by all server sessions together. */
export const RESUME_GLOBAL_MAX_BYTES = 1024 * 1024 * 1024;
/** Unacknowledged frames a client retains for replay to the server. */
export const RESUME_CLIENT_MAX_BYTES = 8 * 1024 * 1024;
/** Acknowledge after this many unacknowledged bytes or frames, or this delay. */
export const RESUME_ACK_BYTES = 64 * 1024;
export const RESUME_ACK_FRAMES = 64;
export const RESUME_ACK_DELAY_MS = 1_000;

export const RESUME_CONTROL_TYPES = ["connection/ack", "connection/resumed", "connection/resume-failed", "connection/end"] as const;

export interface ResumeRequest { readonly v: typeof RESUME_PROTOCOL_VERSION }
export interface ResumeAttempt extends ResumeRequest { readonly sessionId: string; readonly token: string; readonly received: number }
export interface ResumeGrant extends ResumeRequest { readonly sessionId: string; readonly token: string; readonly detachMs: number }

export type ResumeFailureReason = "unknown-session" | "identity" | "gap" | "busy" | "invalid" | "unsupported";

const SESSION_ID = /^[a-f0-9]{32}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Strict parsers: the wire is untrusted in both directions. */
export function parseResumeAttempt(value: unknown): ResumeAttempt | ResumeRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== RESUME_PROTOCOL_VERSION) return null;
  const keys = Object.keys(record);
  if (keys.length === 1) return { v: RESUME_PROTOCOL_VERSION };
  if (keys.length !== 4 || typeof record.sessionId !== "string" || !SESSION_ID.test(record.sessionId)
    || typeof record.token !== "string" || !TOKEN.test(record.token) || !sequence(record.received)) return null;
  return { v: RESUME_PROTOCOL_VERSION, sessionId: record.sessionId, token: record.token, received: record.received };
}

export function parseResumeGrant(value: unknown): ResumeGrant | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== RESUME_PROTOCOL_VERSION || typeof record.sessionId !== "string" || !SESSION_ID.test(record.sessionId)
    || typeof record.token !== "string" || !TOKEN.test(record.token)
    || !Number.isSafeInteger(record.detachMs) || (record.detachMs as number) < 1_000 || (record.detachMs as number) > 3_600_000) return null;
  return { v: RESUME_PROTOCOL_VERSION, sessionId: record.sessionId, token: record.token, detachMs: record.detachMs as number };
}

export function isResumeAttempt(value: ResumeAttempt | ResumeRequest): value is ResumeAttempt {
  return "sessionId" in value;
}

export function isSequence(value: unknown): value is number { return sequence(value) && value > 0; }
export function isAcknowledgement(value: unknown): value is number { return sequence(value); }

interface Retained<T> { readonly seq: number; readonly data: T; readonly bytes: number }

export interface ResumeLinkOptions {
  /** Upper bound on retained unacknowledged bytes; older frames are evicted. */
  readonly maxBytes: number;
  /** Observes every change of retained bytes (server global budget). */
  readonly onBytes?: (delta: number) => void;
  /** Observes an unacknowledged frame being dropped (resumption from before it is lost). */
  readonly onEvict?: () => void;
}

export type Arrival = "deliver" | "duplicate" | "gap";

/**
 * One session's sequencing state, shared by every physical socket it uses:
 * numbers outgoing frames, retains them until the peer acknowledges them,
 * and accepts incoming frames exactly once and in order.
 */
export class ResumeLink<T> {
  private retained: Array<Retained<T> | undefined> = [];
  private head = 0;
  private retainedBytes = 0;
  private lastSent = 0;
  /** Highest frame evicted before acknowledgement; the peer can't resume from before it. */
  private lostThrough = 0;
  private lastReceived = 0;
  private unacknowledgedFrames = 0;
  private unacknowledgedBytes = 0;

  constructor(private readonly options: ResumeLinkOptions) {}

  get sent(): number { return this.lastSent; }
  get received(): number { return this.lastReceived; }
  get bytes(): number { return this.retainedBytes; }
  get frames(): number { return this.retained.length - this.head; }
  get maxBytes(): number { return this.options.maxBytes; }

  /** Assign the next outgoing sequence number. */
  next(): number { return ++this.lastSent; }

  /** Retain an outgoing frame (already numbered with next()) for replay. */
  retain(seq: number, data: T, bytes: number): void {
    if (seq !== this.lastSent) throw new Error("Retained frames must be numbered in order");
    if (bytes > this.options.maxBytes) { this.drop(this.frames); this.lostThrough = seq; this.options.onEvict?.(); return; }
    this.retained.push({ seq, data, bytes });
    this.adjust(bytes);
    while (this.retainedBytes > this.options.maxBytes) this.evictOldest();
  }

  /** Evict the oldest retained frame (budget pressure). Returns bytes freed. */
  evictOldest(): number {
    const oldest = this.retained[this.head];
    if (!oldest) return 0;
    this.lostThrough = Math.max(this.lostThrough, oldest.seq);
    this.drop(1);
    this.options.onEvict?.();
    return oldest.bytes;
  }

  /** The peer has received every frame up to `received`. False: impossible value. */
  acknowledge(received: number): boolean {
    if (!isAcknowledgement(received) || received > this.lastSent) return false;
    let count = 0;
    while (this.head + count < this.retained.length && this.retained[this.head + count]!.seq <= received) count++;
    this.drop(count);
    return true;
  }

  /** Frames the peer has not received, or null when they are no longer all retained. */
  replay(peerReceived: number): readonly { seq: number; data: T }[] | null {
    if (!this.acknowledge(peerReceived) || peerReceived < this.lostThrough) return null;
    const frames = this.retained.slice(this.head);
    if (frames.length && frames[0]!.seq !== peerReceived + 1) return null;
    if (!frames.length && peerReceived !== this.lastSent) return null;
    return frames.map(frame => ({ seq: frame!.seq, data: frame!.data }));
  }

  /** Classify an incoming numbered frame. Only "deliver" may be processed. */
  accept(seq: number, bytes = 0): Arrival {
    if (seq <= this.lastReceived) return "duplicate";
    if (seq !== this.lastReceived + 1) return "gap";
    this.lastReceived = seq;
    this.unacknowledgedFrames++;
    this.unacknowledgedBytes += bytes;
    return "deliver";
  }

  /** Whether an acknowledgement should be sent now (size) or soon (any). */
  get acknowledgementDue(): "now" | "later" | null {
    if (!this.unacknowledgedFrames) return null;
    return this.unacknowledgedFrames >= RESUME_ACK_FRAMES || this.unacknowledgedBytes >= RESUME_ACK_BYTES ? "now" : "later";
  }

  /** Record that an acknowledgement of `received` was sent; returns it. */
  acknowledged(): number {
    this.unacknowledgedFrames = 0;
    this.unacknowledgedBytes = 0;
    return this.lastReceived;
  }

  /** Release every retained frame (session ended). */
  clear(): void { this.drop(this.frames); }

  private drop(count: number): void {
    if (count <= 0) return;
    let freed = 0;
    for (let index = this.head; index < this.head + count; index++) {
      freed += this.retained[index]!.bytes;
      // Accounting and reachability must agree even before queue compaction.
      this.retained[index] = undefined;
    }
    this.head += count;
    if (this.head > 1024 && this.head * 2 > this.retained.length) { this.retained = this.retained.slice(this.head); this.head = 0; }
    if (this.head === this.retained.length) { this.retained = []; this.head = 0; }
    this.adjust(-freed);
  }

  private adjust(delta: number): void {
    if (!delta) return;
    this.retainedBytes += delta;
    this.options.onBytes?.(delta);
  }
}

/** UTF-8 length without allocating (browser and Node). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}
