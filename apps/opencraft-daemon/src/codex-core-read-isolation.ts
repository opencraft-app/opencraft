import WebSocket from "ws";

const HISTORY_READS = new Set(["thread/read", "thread/turns/list", "thread/items/list"]);
export function isIsolatedCoreRead(message: { method?: unknown; id?: unknown }): boolean {
  return message.id !== undefined && typeof message.method === "string" && HISTORY_READS.has(message.method);
}

type ReadMessage = { id: unknown; method: string; params?: unknown };
type ReadJob = {
  message: ReadMessage;
  wireId: string;
  resolve(reply: string): void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  deadline: number;
  slot?: ReadSlot;
};
type ReadSlot = { socket?: WebSocket; ready: boolean; retired: boolean; job: ReadJob | null; initId: string;
  controller: AbortController };

/** History-only connections are reused, with at most one RPC per connection.
 * A bad reply retires only that slot and RPC, never a subscription or execution.
 * Requests are not replayed; a replacement slot serves a subsequent request. */
export class CodexCoreReadIsolation {
  private closed = false;
  private sequence = 0;
  private readonly slots = new Set<ReadSlot>();
  private readonly queue: ReadJob[] = [];
  constructor(private readonly health: (signal: AbortSignal) => Promise<{ nativeSocket: string }>,
    private readonly limits = { maxPayload: 100 * 1024 * 1024, concurrency: 4, queue: 64, timeoutMs: 30_000 }) {}

  private failure(message: ReadMessage, oversized = false): string {
    return JSON.stringify({ id: message.id, error: {
      code: oversized ? -32072 : -32073,
      message: oversized ? "History response is too large; use a smaller history page" : "History read connection is unavailable",
      data: { code: oversized ? "HISTORY_RESPONSE_TOO_LARGE" : "HISTORY_READ_UNAVAILABLE", retryable: !oversized },
    } });
  }

  read(message: ReadMessage): Promise<string> {
    const available = [...this.slots].some(slot => slot.job === null);
    if (this.closed || !isIsolatedCoreRead(message)
      || (!available && this.slots.size >= this.limits.concurrency && this.queue.length >= this.limits.queue)) {
      return Promise.resolve(this.failure(message));
    }
    return new Promise(resolve => {
      const job: ReadJob = { message, wireId: `opencraft-history-${++this.sequence}`, resolve,
        timer: setTimeout(() => this.finish(job, this.failure(message), true), this.limits.timeoutMs), settled: false,
        deadline: performance.now() + this.limits.timeoutMs };
      this.queue.push(job);
      this.pump();
    });
  }

  private pump(): void {
    while (!this.closed && this.queue.length > 0) {
      const next = this.queue[0]!;
      if (performance.now() >= next.deadline) {
        this.finish(next, this.failure(next.message));
        continue;
      }
      let slot = [...this.slots].find(candidate => candidate.job === null);
      if (!slot) {
        if (this.slots.size >= this.limits.concurrency) return;
        slot = { ready: false, retired: false, job: null, initId: `opencraft-history-init-${++this.sequence}`,
          controller: new AbortController() };
        this.slots.add(slot);
      }
      const job = this.queue.shift()!;
      slot.job = job; job.slot = slot;
      if (slot.ready) this.send(slot);
      else void this.open(slot);
    }
  }

  private async open(slot: ReadSlot): Promise<void> {
    try {
      const endpoint = await this.health(slot.controller.signal);
      // A deadline, reset or close may have retired this slot while health was pending.
      if (this.closed || slot.retired) return;
      if (!slot.job || performance.now() >= slot.job.deadline) { this.fail(slot); return; }
      const ws = new WebSocket(`ws+unix://${endpoint.nativeSocket}:/`, {
        handshakeTimeout: Math.min(5_000, this.limits.timeoutMs), maxPayload: this.limits.maxPayload,
      });
      slot.socket = ws;
      ws.on("error", error => this.fail(slot, (error as NodeJS.ErrnoException).code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"));
      ws.on("close", () => this.fail(slot));
      ws.on("open", () => {
        if (slot.retired) return;
        if (!slot.job || performance.now() >= slot.job.deadline) { this.fail(slot); return; }
        ws.send(JSON.stringify({ id: slot.initId, method: "initialize", params: {
          clientInfo: { name: "opencraft-history-reader", version: "0.1.0" }, capabilities: { experimentalApi: true },
        } }), error => { if (error) this.fail(slot); });
      });
      ws.on("message", raw => this.receive(slot, String(raw)));
    } catch { this.fail(slot); }
  }

  private receive(slot: ReadSlot, raw: string): void {
    if (slot.retired) return;
    if (slot.job && performance.now() >= slot.job.deadline) { this.fail(slot); return; }
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) { this.fail(slot); return; }
      if (!slot.ready) {
        if (value.id !== slot.initId) return;
        if (value.error || !("result" in value)) { this.fail(slot); return; }
        slot.ready = true;
        slot.socket!.send(JSON.stringify({ method: "initialized" }), error => { if (error) this.fail(slot); });
        this.send(slot);
      } else if (slot.job && value.id === slot.job.wireId && !value.method) {
        if (!("result" in value) && !("error" in value)) { this.fail(slot); return; }
        this.finish(slot.job, JSON.stringify({ ...value, id: slot.job.message.id }));
      }
      // Notifications and late/duplicate replies never satisfy another RPC.
    } catch { this.fail(slot); }
  }

  private send(slot: ReadSlot): void {
    const job = slot.job;
    if (!job || slot.retired) return;
    if (performance.now() >= job.deadline) { this.fail(slot); return; }
    try {
      slot.socket!.send(JSON.stringify({ ...job.message, id: job.wireId }), error => { if (error) this.fail(slot); });
    } catch { this.fail(slot); }
  }

  private retire(slot: ReadSlot): void {
    slot.retired = true;
    this.slots.delete(slot);
    slot.controller.abort();
    slot.socket?.terminate();
  }

  private fail(slot: ReadSlot, oversized = false): void {
    if (slot.retired) return;
    if (slot.job) this.finish(slot.job, this.failure(slot.job.message, oversized), true);
    else { this.retire(slot); this.pump(); }
  }

  private finish(job: ReadJob, reply: string, retire = false): void {
    if (job.settled) return;
    job.settled = true; clearTimeout(job.timer);
    const index = this.queue.indexOf(job);
    if (index !== -1) this.queue.splice(index, 1);
    if (job.slot) {
      job.slot.job = null;
      if (retire) this.retire(job.slot);
    }
    job.resolve(reply);
    this.pump();
  }

  /** Initialization context changed: fail old reads without replay; allow new slots. */
  reset(): void {
    const jobs = [...this.queue, ...[...this.slots].flatMap(slot => slot.job ? [slot.job] : [])];
    for (const slot of this.slots) this.retire(slot);
    // Remove this incarnation's queue before settling so pump cannot start old jobs.
    this.queue.length = 0;
    for (const job of jobs) this.finish(job, this.failure(job.message));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reset();
  }
}
