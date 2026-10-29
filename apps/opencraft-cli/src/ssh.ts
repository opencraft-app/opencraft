import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Duplex } from 'node:stream';
import WebSocket from 'ws';
import type { DuplexTransport, TransportStatus } from '@opencraft/appserver-client/transport';

/** OpenSSH owns configuration, agent and host-key verification. This process owns
 * exactly one authenticated proxy channel and never starts a remote engine. */
export class CliSshTransport implements DuplexTransport {
  private state: TransportStatus = { state: 'idle' };
  private child?: ChildProcessWithoutNullStreams;
  private socket?: WebSocket;
  private stream?: Duplex;
  private messages = new Set<(frame: string) => void>();
  private statuses = new Set<(status: TransportStatus) => void>();
  constructor(readonly alias: string, readonly configFile?: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,254}$/u.test(alias)) throw new Error('Invalid SSH alias');
  }
  get status() { return this.state; }
  private update(status: TransportStatus) { this.state = status; for (const listener of this.statuses) listener(status); }
  subscribeMessage(listener: (frame: string) => void) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  subscribeStatus(listener: (status: TransportStatus) => void) { this.statuses.add(listener); return () => { this.statuses.delete(listener); }; }
  async connect(signal?: AbortSignal) {
    if (this.state.state !== 'idle') throw new Error('SSH channel cannot be reused');
    this.update({ state: 'connecting' });
    const child = this.child = spawn('ssh', [...(this.configFile ? ['-F', this.configFile] : []), '-T',
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
      '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10', '--', this.alias, 'codex app-server proxy'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    const stream = this.stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    stream.on('error', () => {});
    child.on('error', () => this.update({ state: 'failed', failure: { code: 'SSH_UNAVAILABLE', recovery: 'manual' } }));
    child.once('exit', () => { if (!['closed', 'closing'].includes(this.state.state)) this.update({ state: 'failed', failure: { code: 'SSH_ACCESS_REQUIRED', recovery: 'manual' } }); });
    const socket = this.socket = new WebSocket('ws://127.0.0.1/rpc', { createConnection: () => stream, maxPayload: 16 * 1024 * 1024, handshakeTimeout: 12_000 });
    socket.on('message', (data, binary) => {
      if (binary) { socket.terminate(); return; }
      for (const listener of this.messages) listener(data.toString());
    });
    socket.on('close', () => { if (!['closed', 'closing'].includes(this.state.state)) this.update({ state: 'failed', failure: { code: 'SSH_ACCESS_REQUIRED', recovery: 'manual' } }); });
    socket.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      const abort = () => { socket.terminate(); reject(new Error('SSH connection cancelled')); };
      const fail = () => { signal?.removeEventListener('abort', abort); reject(new Error('SSH access required')); };
      socket.once('error', fail); socket.once('close', fail);
      socket.once('open', () => { signal?.removeEventListener('abort', abort); socket.off('error', fail); socket.off('close', fail); this.update({ state: 'open' }); resolve(); });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  async send(frame: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.state.state !== 'open' || !this.socket) throw new Error('SSH connection unavailable');
    await new Promise<void>((resolve, reject) => this.socket!.send(frame, error => error ? reject(error) : resolve()));
  }
  async close() {
    this.update({ state: 'closing' });
    this.socket?.terminate(); this.stream?.destroy(); this.child?.kill('SIGTERM');
    this.update({ state: 'closed' });
  }
}
