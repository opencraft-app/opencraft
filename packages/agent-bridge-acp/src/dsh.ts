import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";

interface SideResult { accepted?: boolean; messageId?: string; withdrawn?: boolean; settled?: boolean }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Private per-process channel. Never retries a mutation after loss or timeout. */
export class DshChannel {
  ready = false;
  private serial = 0;
  private carry = "";
  private decoder = new StringDecoder("utf8");
  private pending = new Map<number, { resolve: (value: SideResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly claimed = new Set<string>();
  constructor(private stream: Duplex, private event: (method: string, params: Record<string, unknown>) => void) {
    stream.on("data", (chunk: Buffer) => {
      this.carry += this.decoder.write(chunk);
      if (Buffer.byteLength(this.carry) > 1024 * 1024) { this.close(); return; }
      let end: number;
      while ((end = this.carry.indexOf("\n")) >= 0) {
        const line = this.carry.slice(0, end); this.carry = this.carry.slice(end + 1);
        try { this.receive(JSON.parse(line)); } catch { this.close(); }
      }
    });
    stream.on("error", () => this.close());
    stream.on("close", () => this.close());
  }
  private receive(value: unknown): void {
    if (!record(value)) throw new Error("Malformed DSH frame");
    const frame = value;
    const params = record(frame.params) ? frame.params : {};
    if (frame.method === "ready") this.ready = true;
    if (frame.method === "claimed" && typeof params.messageId === "string") this.claimed.add(params.messageId);
    if (typeof frame.method === "string") this.event(frame.method, params);
    const entry = this.pending.get(typeof frame.id === "number" ? frame.id : -1);
    if (!entry) return;
    if (!frame.error && !record(frame.result)) throw new Error("Malformed DSH result");
    clearTimeout(entry.timer); this.pending.delete(frame.id as number);
    if (frame.error) entry.reject(new Error("DSH private mutation outcome unconfirmed"));
    else {
      if (!record(frame.result)) throw new Error("Malformed DSH result");
      if (frame.result.accepted === true && typeof frame.result.messageId === "string") this.event("admission", { messageId: frame.result.messageId });
      entry.resolve({ accepted: frame.result.accepted === true, messageId: typeof frame.result.messageId === "string" ? frame.result.messageId : undefined, withdrawn: frame.result.withdrawn === true, settled: frame.result.settled === true });
    }
  }
  request(method: string, params: Record<string, unknown>): Promise<SideResult> {
    if (!this.ready) return Promise.reject(new Error("DSH private channel not ready; outcome unconfirmed"));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("DSH private mutation outcome unconfirmed")); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.stream.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (error) => { if (error) this.close(); });
    });
  }
  async settle(sessionId: string): Promise<void> {
    // The plugin barrier is ordered after all native inbox removals.
    const result = await this.request("settle", { sessionId });
    if (result.settled !== true) throw new Error("DSH cleanup outcome unconfirmed");
  }
  close(): void {
    this.ready = false;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("DSH private channel lost; outcome unconfirmed")); }
    this.pending.clear(); this.stream.destroy();
  }
}
