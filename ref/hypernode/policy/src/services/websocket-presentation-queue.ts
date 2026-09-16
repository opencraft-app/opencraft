export const PRESENTATION_DRAIN_TIMEOUT_MS = 300;

export interface PresentationMetadata {
  threadId?: unknown;
  turnId?: unknown;
  itemId?: unknown;
}

export interface PresentationSocket {
  hasPendingPresentation?(presentationKey: string): boolean;
}

export function presentationKeyFor(metadata: PresentationMetadata = {}): string | null {
  const { threadId, turnId, itemId } = metadata;
  if (![threadId, turnId, itemId].every((value) => typeof value === "string" && value.length > 0)) {
    return null;
  }
  return `${String(threadId)}\u0000${String(turnId)}\u0000${String(itemId)}`;
}

interface PresentationQueueEntry {
  bytes: Uint8Array<ArrayBufferLike>;
  presentationKey: string | null;
}

interface PresentationQueueOptions {
  onPresentationDrained?: (presentationKey: string) => void;
}

/**
 * Preserves WebSocket byte order and reports when presentation frames cross
 * the transport boundary. Presentation cadence belongs to the shared logical
 * stream before fanout; applying it here would create an independent clock and
 * backlog for every subscriber.
 */
export class WebSocketPresentationQueue {
  private readonly onPresentationDrained: (presentationKey: string) => void;
  private readonly entries: PresentationQueueEntry[] = [];
  private readonly presentationCounts = new Map<string, number>();
  private offset = 0;

  constructor({
    onPresentationDrained = () => {},
  }: PresentationQueueOptions = {}) {
    this.onPresentationDrained = onPresentationDrained;
  }

  get length(): number {
    return this.entries.length;
  }

  push(bytes: Uint8Array<ArrayBufferLike>, presentationKey: string | null = null): void {
    this.entries.push({ bytes, presentationKey });
    if (presentationKey !== null) {
      this.presentationCounts.set(
        presentationKey,
        (this.presentationCounts.get(presentationKey) ?? 0) + 1,
      );
    }
  }

  hasPendingPresentation(presentationKey: string): boolean {
    return presentationKey.length > 0 && (this.presentationCounts.get(presentationKey) ?? 0) > 0;
  }

  drain(limit = 512 * 1024): Uint8Array<ArrayBufferLike>[] {
    const chunks: Uint8Array<ArrayBufferLike>[] = [];
    let remaining = limit;
    while (remaining > 0 && this.entries.length > 0) {
      const current = this.entries[0];
      if (current == null) break;
      const available = current.bytes.length - this.offset;
      const length = Math.min(available, remaining);
      chunks.push(current.bytes.slice(this.offset, this.offset + length));
      this.offset += length;
      remaining -= length;
      if (this.offset === current.bytes.length) {
        this.entries.shift();
        this.offset = 0;
        if (current.presentationKey != null) {
          const remainingForKey = (this.presentationCounts.get(current.presentationKey) ?? 1) - 1;
          if (remainingForKey <= 0) {
            this.presentationCounts.delete(current.presentationKey);
            this.onPresentationDrained(current.presentationKey);
          } else {
            this.presentationCounts.set(current.presentationKey, remainingForKey);
          }
        }
      }
    }
    return chunks;
  }
}

interface PresentationBarrier {
  presentationKey: string;
  action: () => void;
  deadlineAtMs: number;
}

interface PresentationBarrierOptions {
  sockets?: () => PresentationSocket[];
  now?: () => number;
  requestWake?: (delayMs: number) => void;
  timeoutMs?: number;
}

/**
 * Logical item completion is allowed only after its paced text has crossed the
 * WebSocket queue. A bounded deadline prevents an abandoned client from
 * holding the authoritative Turn open forever.
 */
export class PresentationDrainBarrierRegistry {
  private readonly sockets: () => PresentationSocket[];
  private readonly now: () => number;
  private readonly requestWake: (delayMs: number) => void;
  private readonly timeoutMs: number;
  private barriers: PresentationBarrier[] = [];

  constructor({
    sockets = () => [],
    now = () => Date.now(),
    requestWake = () => {},
    timeoutMs = PRESENTATION_DRAIN_TIMEOUT_MS,
  }: PresentationBarrierOptions = {}) {
    this.sockets = sockets;
    this.now = now;
    this.requestWake = requestWake;
    this.timeoutMs = timeoutMs;
  }

  afterDrained(metadata: PresentationMetadata, action: () => void): boolean {
    const presentationKey = presentationKeyFor(metadata);
    if (presentationKey == null || !this.isPending(presentationKey)) {
      action();
      return false;
    }
    this.barriers.push({ presentationKey, action, deadlineAtMs: this.now() + this.timeoutMs });
    this.requestWake(this.timeoutMs);
    return true;
  }

  isPending(presentationKey: string): boolean {
    return this.sockets().some(
      (socket) => socket.hasPendingPresentation?.(presentationKey) === true,
    );
  }

  flush(nowMs = this.now()): number {
    const ready: PresentationBarrier[] = [];
    const pending: PresentationBarrier[] = [];
    for (const barrier of this.barriers) {
      if (barrier.deadlineAtMs <= nowMs || !this.isPending(barrier.presentationKey)) ready.push(barrier);
      else pending.push(barrier);
    }
    this.barriers = pending;
    for (const barrier of ready) barrier.action();
    return ready.length;
  }
}
