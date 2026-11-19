import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  RESUME_DETACH_MS, RESUME_GLOBAL_MAX_BYTES, RESUME_PROTOCOL_VERSION, RESUME_SESSION_MAX_BYTES,
  ResumeLink, type ResumeAttempt, type ResumeFailureReason, type ResumeGrant,
} from "./index.js";

export interface ResumeRegistryOptions {
  readonly maxBytes?: number;
  readonly sessionMaxBytes?: number;
  readonly detachMs?: number;
  readonly now?: () => number;
  readonly setTimeout?: (run: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

/** Frame retained by a server session: encoded once, outside the V8 heap. */
export type RetainedFrame = Buffer | null;

/**
 * One resumable App Host connection. The registry owns its lifetime; the
 * integration owns the payload (the live App Host connection and its route).
 */
export class ResumeSession<P> {
  readonly link: ResumeLink<RetainedFrame>;
  private detachTimer: unknown = null;
  private ended = false;
  private evictedWhileDetached = false;
  detachedAt: number | null = null;

  constructor(
    private readonly registry: ResumeRegistry<P>,
    readonly id: string,
    private readonly token: Buffer,
    readonly identity: string,
    readonly payload: P,
    private readonly onEnd: (reason: string) => void,
    maxBytes: number,
  ) {
    this.link = new ResumeLink<RetainedFrame>({ maxBytes, onBytes: delta => registry.account(this, delta), onEvict: () => this.noteEviction() });
  }

  get isEnded(): boolean { return this.ended; }
  get isDetached(): boolean { return this.detachedAt !== null; }

  grant(): ResumeGrant {
    return { v: RESUME_PROTOCOL_VERSION, sessionId: this.id, token: this.token.toString("base64url"), detachMs: this.registry.detachMs };
  }

  matches(token: string): boolean {
    const presented = Buffer.from(token, "base64url");
    return presented.length === this.token.length && timingSafeEqual(presented, this.token);
  }

  /** The socket died: keep the connection for the detach window (or until `deadline`). */
  detach(deadline = Infinity): void {
    if (this.ended || this.detachedAt !== null) return;
    this.detachedAt = this.registry.clock();
    this.evictedWhileDetached = false;
    const remaining = Math.max(0, Math.min(this.registry.detachMs, deadline - this.detachedAt));
    this.detachTimer = this.registry.timers.setTimeout(() => this.end("detach-expired"), remaining);
    (this.detachTimer as { unref?: () => void })?.unref?.();
  }

  /** A new socket adopted the session. */
  attach(): void {
    if (this.detachTimer !== null) this.registry.timers.clearTimeout(this.detachTimer);
    this.detachTimer = null;
    this.detachedAt = null;
  }

  /** Budget pressure removed unacknowledged output while nobody could receive it. */
  noteEviction(): void {
    if (this.detachedAt !== null && !this.evictedWhileDetached) {
      this.evictedWhileDetached = true;
      queueMicrotask(() => this.end("window-overflow"));
    }
  }

  end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    if (this.detachTimer !== null) this.registry.timers.clearTimeout(this.detachTimer);
    this.detachTimer = null;
    this.link.clear();
    this.registry.forget(this);
    try { this.onEnd(reason); } catch { /* The integration's cleanup cannot strand the registry. */ }
  }
}

export interface ResumeRegistryStats {
  readonly sessions: number;
  readonly detached: number;
  readonly bytes: number;
}

/** Process-wide owner of resumable sessions and their shared memory budget. */
export class ResumeRegistry<P> {
  private readonly sessions = new Map<string, ResumeSession<P>>();
  private total = 0;
  private evicting = false;
  readonly maxBytes: number;
  readonly sessionMaxBytes: number;
  readonly detachMs: number;
  readonly clock: () => number;
  readonly timers: { setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };

  constructor(options: ResumeRegistryOptions = {}) {
    this.maxBytes = options.maxBytes ?? RESUME_GLOBAL_MAX_BYTES;
    this.sessionMaxBytes = options.sessionMaxBytes ?? RESUME_SESSION_MAX_BYTES;
    this.detachMs = options.detachMs ?? RESUME_DETACH_MS;
    this.clock = options.now ?? Date.now;
    this.timers = {
      setTimeout: options.setTimeout ?? ((run, ms) => setTimeout(run, ms)),
      clearTimeout: options.clearTimeout ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    };
  }

  get stats(): ResumeRegistryStats {
    let detached = 0;
    for (const session of this.sessions.values()) if (session.isDetached) detached++;
    return { sessions: this.sessions.size, detached, bytes: this.total };
  }

  create(identity: string, payload: P, onEnd: (reason: string) => void): ResumeSession<P> {
    let id: string;
    do id = randomBytes(16).toString("hex"); while (this.sessions.has(id));
    const session = new ResumeSession(this, id, randomBytes(32), identity, payload, onEnd, this.sessionMaxBytes);
    this.sessions.set(id, session);
    return session;
  }

  /** Authenticate a resume attempt. Identity must match exactly; tokens compare in constant time. */
  find(attempt: ResumeAttempt, identity: string): { session: ResumeSession<P> } | { failure: ResumeFailureReason } {
    const session = this.sessions.get(attempt.sessionId);
    if (!session || session.isEnded || !session.matches(attempt.token)) return { failure: "unknown-session" };
    if (session.identity !== identity) return { failure: "identity" };
    return { session };
  }

  close(): void {
    for (const session of [...this.sessions.values()]) session.end("server-closed");
  }

  /** @internal */
  forget(session: ResumeSession<P>): void {
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
  }

  /** @internal Global budget: over it, the largest sessions lose their oldest frames. */
  account(_session: ResumeSession<P>, delta: number): void {
    this.total += delta;
    if (this.total <= this.maxBytes || this.evicting) return;
    this.evicting = true;
    try {
      while (this.total > this.maxBytes) {
        let largest: ResumeSession<P> | null = null;
        for (const candidate of this.sessions.values()) if (!largest || candidate.link.bytes > largest.link.bytes) largest = candidate;
        if (!largest || !largest.link.evictOldest()) break;
      }
    } finally { this.evicting = false; }
  }
}

export type { ResumeAttempt, ResumeGrant };
