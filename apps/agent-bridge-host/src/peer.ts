import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { BRIDGE_MAX_FRAME_BYTES, isBridgeCallback, decodeFrame, splitLines, encodeFrame, isRequest, isNotification, isSuccess, type BridgeWireMessage, type BridgeCommand } from '@opencraft/agent-bridge-protocol';
import { createSandbox, type SandboxPool, type Sandbox, type SandboxProcess } from '@opencraft/sandbox';
import type { Generation } from './types.js';
type PeerFailure = 'transport' | 'protocol' | 'callback' | 'lease-cleanup' | 'closed';
/** One pinned generation owns one sandbox and bridge. No gateway lifetime here. */
export class Peer {
  private sandbox?: Sandbox;
  private child?: SandboxProcess;
  private pending = new Map<string, { resolve(value: BridgeWireMessage): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private decoder = new StringDecoder('utf8');
  private lines = { carry: '', discarding: false };
  private failed?: Error;
  private failure: PeerFailure | null = null;
  private nativeFault: string | null = null;
  diagnostic() { return { failed: !!this.failed, failure: this.failure, nativeFault: this.nativeFault }; }
  private callbackSequence = 0;
  private incarnation = randomUUID();
  private cleanup?: Promise<void>;
  private incoming: Promise<void> = Promise.resolve();
  private replies: Promise<void> = Promise.resolve();
  private readonly transportLifetime = new AbortController();
  constructor(readonly config: Generation, private callback: (id: string, method: string, params: unknown) => Promise<void>, private timeoutMs = 30_000, private onFailure?:()=>void) {}
  async start(pool: SandboxPool): Promise<void> {
    this.sandbox = await createSandbox(pool, { owner: `agent-bridge:${this.config.id}:${this.config.digest}` });
    try {
      this.child = await this.sandbox.spawn(this.config.launch, output => {
        if (output.stream !== 'stdout') {
          // Only this bounded diagnostic code is retained; never expose stderr content.
          const code = /(?:^|\n)(codex-native-fault:(?:unknown|turn\/(?:started|completed)|item\/(?:started|completed|agentMessage\/delta|reasoning\/textDelta|plan\/delta)|thread\/tokenUsage\/updated):(?:invalid-frame|translation|connection))(?:\n|$)/.exec(Buffer.from(output.data).toString('utf8'));
          if (code) this.nativeFault = code[1]!;
          return;
        }
        const batch = splitLines(this.decoder.write(Buffer.from(output.data)), this.lines);
        this.lines = batch;
        if (batch.oversized.length) this.fail(Error('Bridge frame too large'), 'protocol');
        for (const line of batch.lines) {
          this.incoming = this.incoming.then(() => this.receive(line), () => this.receive(line));
          void this.incoming.catch(error => { void this.abort(error, 'protocol').catch(() => {}); });
        }
      });
      void this.child.exited.then(() => { void this.abort(Error('Bridge EOF'), 'transport').catch(() => {}); }, error => { void this.abort(error, 'transport').catch(() => {}); });
    } catch (error) { await this.sandbox.close(); throw error; }
  }
  private fail(error: Error, failure: PeerFailure): void {
    if (this.failed) return;
    this.failed = error;
    this.failure = failure;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
    this.transportLifetime.abort(error);
    this.onFailure?.();
  }
  private async receive(line: string): Promise<void> {
    const decoded = decodeFrame(line);
    if (decoded.kind === 'error') {
      this.queueReply({ jsonrpc: '2.0', id: null, error: decoded.error });
      return;
    }
    const message = decoded.message;
    if (isRequest(message) || isNotification(message)) {
      if (!isBridgeCallback(message.method)) {
        this.queueReply({ jsonrpc: '2.0', id: isRequest(message) ? message.id : null,
          error: { code: -32601, kind: 'unsupported', message: 'Unsupported bridge callback' } });
        return;
      }
      const id = isRequest(message) ? `${this.incarnation}:request:${message.id}` : `${this.incarnation}:notification:${++this.callbackSequence}`;
      try { await this.callback(id, message.method, message.params); }
      catch (error) {
        // Persistence loss ends execution custody. Do not wait on this incoming
        // chain from cleanup: close() drains it after the environment is gone.
        void this.abort(error as Error, 'callback').catch(() => {});
        return;
      }
      if (isRequest(message)) this.queueReply({ jsonrpc: '2.0', id: message.id, result: { durable: true } });
      return;
    }
    if (message.id === null) return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return; // timed out requests stay unknown, including late success.
    clearTimeout(waiter.timer); this.pending.delete(message.id); waiter.resolve(message);
  }
  private queueReply(message: BridgeWireMessage): void {
    if (this.failed) return;
    // Storage commits stay ordered independently of stdin backpressure.
    this.replies = this.replies.then(() => this.writeReply(message));
    void this.replies.catch(error => { void this.abort(error, 'transport').catch(() => {}); });
  }
  private async writeReply(message: BridgeWireMessage): Promise<void> {
    if (this.failed) return;
    const signal = this.transportLifetime.signal;
    let onClosed!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      onClosed = () => reject(signal.reason);
      signal.addEventListener('abort', onClosed, { once: true });
      timer = setTimeout(() => reject(Error('Bridge callback reply write timed out')), this.timeoutMs);
    });
    try {
      await Promise.race([this.write(message), interrupted]);
    } catch (error) {
      if (!this.failed) void this.abort(error as Error, 'transport').catch(() => {});
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onClosed);
    }
  }
  private async write(message: BridgeWireMessage): Promise<void> {
    if (this.failed || !this.child) throw this.failed ?? Error('Bridge unavailable');
    const frame = encodeFrame(message);
    if (Buffer.byteLength(frame) > BRIDGE_MAX_FRAME_BYTES) throw Error('Bridge request too large');
    await this.child.writeStdin(Buffer.from(frame + '\n'));
  }
  async request(id: string, method: BridgeCommand, params: unknown): Promise<BridgeWireMessage> {
    if (this.failed) throw this.failed;
    let written = false;
    const response = new Promise<BridgeWireMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = Error('Native request outcome unknown');
        reject(error);
        // An unconfirmed write may still be queued in the sandbox transport.
        if (!written) void this.abort(error, 'transport').catch(() => {});
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    void this.write({ jsonrpc: '2.0', id, method, params }).then(
      () => { written = true; },
      error => { this.fail(error as Error, 'transport'); },
    );
    return response;
  }
  abort(error: Error, failure: PeerFailure): Promise<void> {
    this.fail(error, failure);
    return this.cleanup ??= this.sandbox?.close() ?? Promise.resolve();
  }
  async close(): Promise<void> {
    await this.abort(Error('Bridge owner closing'), 'closed');
    await this.incoming; // drain every frame already received, even after EOF
    await this.replies;
  }
}
export const successful = isSuccess;
