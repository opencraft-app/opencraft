import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { isBridgeCallback, decodeFrame, splitLines, encodeFrame, isRequest, isNotification, isSuccess, type BridgeWireMessage, type BridgeCommand } from '@opencraft/agent-bridge-protocol';
import { createSandbox, type SandboxPool, type Sandbox, type SandboxProcess } from '@opencraft/sandbox';
import type { Generation } from './types.js';
/** One pinned generation owns one sandbox and bridge. No gateway lifetime here. */
export class Peer {
  private sandbox?: Sandbox;
  private child?: SandboxProcess;
  private pending = new Map<string, { resolve(value: BridgeWireMessage): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private decoder = new StringDecoder('utf8');
  private lines = { carry: '', discarding: false };
  private failed?: Error;
  private callbackSequence = 0;
  private incarnation = randomUUID();
  private cleanup?: Promise<void>;
  private incoming: Promise<void> = Promise.resolve();
  constructor(readonly config: Generation, private callback: (id: string, method: string, params: unknown) => Promise<void>, private timeoutMs = 30_000) {}
  async start(pool: SandboxPool): Promise<void> {
    this.sandbox = await createSandbox(pool, { owner: `agent-bridge:${this.config.id}:${this.config.digest}` });
    try {
      this.child = await this.sandbox.spawn(this.config.launch, output => {
        if (output.stream !== 'stdout') return; // stderr must never enter protocol or persisted user events.
        const batch = splitLines(this.decoder.write(Buffer.from(output.data)), this.lines);
        this.lines = batch;
        if (batch.oversized.length) this.fail(Error('Bridge frame too large'));
        for (const line of batch.lines) {
          this.incoming = this.incoming.then(() => this.receive(line), () => this.receive(line));
          void this.incoming.catch(error => { void this.abort(error).catch(() => {}); });
        }
      });
      void this.child.exited.then(() => { void this.abort(Error('Bridge EOF')).catch(() => {}); }, error => { void this.abort(error).catch(() => {}); });
    } catch (error) { await this.sandbox.close(); throw error; }
  }
  private fail(error: Error): void {
    this.failed ??= error;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
  }
  private async receive(line: string): Promise<void> {
    const decoded = decodeFrame(line);
    if (decoded.kind === 'error') { try { await this.write({ jsonrpc: '2.0', id: null, error: decoded.error }); } catch {} return; }
    const message = decoded.message;
    if (isRequest(message) || isNotification(message)) {
      if (!isBridgeCallback(message.method)) {
        try { await this.write({ jsonrpc: '2.0', id: isRequest(message) ? message.id : null, error: { code: -32601, kind: 'unsupported', message: 'Unsupported bridge callback' } }); } catch {}
        return;
      }
      const id = isRequest(message) ? `${this.incarnation}:request:${message.id}` : `${this.incarnation}:notification:${++this.callbackSequence}`;
      try { await this.callback(id, message.method, message.params); }
      catch (error) {
        // Persistence loss ends execution custody. Do not wait on this incoming
        // chain from cleanup: close() drains it after the environment is gone.
        void this.abort(error as Error).catch(() => {});
        return;
      }
      if (isRequest(message)) {
        try { await this.write({ jsonrpc: '2.0', id: message.id, result: { durable: true } }); }
        catch (error) { this.fail(error as Error); } // EOF cannot discard later received frames.
      }
      return;
    }
    if (message.id === null) return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return; // timed out requests stay unknown, including late success.
    clearTimeout(waiter.timer); this.pending.delete(message.id); waiter.resolve(message);
  }
  private async write(message: BridgeWireMessage): Promise<void> {
    if (this.failed || !this.child) throw this.failed ?? Error('Bridge unavailable');
    const data = Buffer.from(encodeFrame(message) + '\n');
    if (data.byteLength > 1_048_576) throw Error('Bridge request too large');
    await this.child.writeStdin(data);
  }
  async request(id: string, method: BridgeCommand, params: unknown): Promise<BridgeWireMessage> {
    if (this.failed) throw this.failed;
    const response = new Promise<BridgeWireMessage>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('Native request outcome unknown')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    // Observe rejection immediately even if write waits for backpressure.
    void response.catch(() => {});
    try { await this.write({ jsonrpc: '2.0', id, method, params }); }
    catch (error) { this.fail(error as Error); }
    return response;
  }
  abort(error: Error): Promise<void> {
    this.fail(error);
    return this.cleanup ??= this.sandbox?.close() ?? Promise.resolve();
  }
  async close(): Promise<void> {
    await this.abort(Error('Bridge owner closing'));
    await this.incoming; // drain every frame already received, even after EOF
  }
}
export const successful = isSuccess;
