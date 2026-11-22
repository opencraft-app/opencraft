import { connect, type Socket } from 'node:net';
import type { ExecutionEnvironmentRuntime, EnvironmentExecutionScope } from '@opencraft/execution-environment';
import { prepareProcessIdentity, TerminalCapacityError, type PreparedProcessIdentity } from './process-identity.js';
import { lstat, readFile } from 'node:fs/promises';
import { launchTerminalOwner, terminalOwnerLocation } from './terminal-owner-runtime.js';
import { readOwnerFrames, sendOwnerFrame, TERMINAL_OWNER_PROTOCOL } from './terminal-owner-wire.js';

/** Host-side authority adapter. Closing this adapter only detaches observers. */
export class DurableHostProcessService {
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  private readonly watched = new Set<string>();
  private socket?: Socket;
  private connecting?: Promise<Socket>;
  private closed = false;
  private next = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly directory: string, private readonly environment?: ExecutionEnvironmentRuntime,
    private readonly external?: { endpoint: string; tokenFile: string;
      prepare(method: string, params: unknown, scope?: EnvironmentExecutionScope): PreparedProcessIdentity }) {}
  subscribe(listener: (method: string, params: unknown) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async probe(): Promise<void> { await this.connection(); }
  private async connection(): Promise<Socket> {
    if (this.closed) throw new Error('Process service is closed');
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (!this.connecting) {
      this.connecting = this.establish().finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }
  private async establish() {
    if (this.external) {
      const info = await lstat(this.external.tokenFile);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('Invalid terminal owner token file');
      const token = (await readFile(this.external.tokenFile, 'utf8')).trim();
      if (token.length < 32 || token.length > 512) throw new Error('Invalid terminal owner token');
      return this.attach(this.external.endpoint, token);
    }
    const location = await terminalOwnerLocation(this.directory);
    const until = Date.now() + 15_000;
    let started = false;
    do {
      if (this.closed) throw new Error('Process service is closed');
      try { return await this.attach(location.endpoint); }
      catch (error) {
        if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      if (!started) { await launchTerminalOwner(location); started = true; }
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < until);
    throw new Error('Terminal owner unavailable');
  }
  private attach(endpoint: string, token?: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(endpoint);
      let attached = false;
      const timer = setTimeout(() => { reject(new Error('Terminal owner attach timed out')); socket.destroy(); }, 5000);
      socket.on('error', error => { if (!attached) reject(error); });
      socket.once('close', () => {
        clearTimeout(timer);
        if (!attached) reject(new Error('Terminal owner attach closed'));
        if (this.socket !== socket) return;
        this.socket = undefined; this.watched.clear();
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Terminal owner disconnected; operation outcome may be unknown')); }
        this.pending.clear();
      });
      socket.once('connect', () => sendOwnerFrame(socket, { type: 'attach', protocol: TERMINAL_OWNER_PROTOCOL, ...(token ? { token } : {}) }));
      readOwnerFrames(socket, message => {
        if (!attached) {
          if (message?.type !== 'attached' || message.protocol !== TERMINAL_OWNER_PROTOCOL || this.closed) {
            clearTimeout(timer); reject(new Error('Terminal owner protocol incompatible or Host closed')); socket.destroy(); return;
          }
          attached = true; clearTimeout(timer); this.socket = socket; resolve(socket); return;
        }
        if (typeof message.method === 'string') {
          if (this.watched.has(message.params?.processHandle)) for (const listener of this.listeners) listener(message.method, message.params);
          if (message.method === 'process/exited') this.watched.delete(message.params?.processHandle);
          return;
        }
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(message.error === 'capacity' ? new TerminalCapacityError() : new Error('Terminal unavailable for this account or project'));
        else request.resolve(message.result);
      });
    });
  }
  async threadScopes(): Promise<{hostId: string; threadId: string}[]> {
    return await this.dispatchIdentity('process/threadScopes', {}, { quotaOwner: 'server-lifecycle', lifecycleAuthority: true }) as {hostId: string; threadId: string}[];
  }
  /** Trusted composition only; not in the public method catalog. */
  async releaseThread(hostId: string, threadId: string, activate = false, aliases: readonly {owner: string; resourceOwnerId: string}[] = []): Promise<void> {
    const deadline = Date.now() + 5000;
    const identity: PreparedProcessIdentity = { quotaOwner: 'server-lifecycle', lifecycleAuthority: true,
      scope: { hostId, threadId, account: null, projectId: null } };
    for (;;) {
      const result = await this.dispatchIdentity('process/releaseThread', { aliases }, identity) as { pending: number };
      if (result.pending === 0) {
        if (activate) await this.dispatchIdentity('process/releaseThread', { activate: true, aliases }, identity);
        return;
      }
      if (Date.now() >= deadline) throw new Error('Conversation terminal cleanup pending');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  async dispatch(method: string, params: unknown, scope?: EnvironmentExecutionScope, assertCurrent?: () => void, onAccepted?: () => void): Promise<unknown> {
    const identity = this.external ? this.external.prepare(method, params, scope) : prepareProcessIdentity(this.environment, scope, method, params);
    return this.dispatchIdentity(method, params, identity, assertCurrent, onAccepted);
  }
  private async dispatchIdentity(method: string, params: unknown, identity: PreparedProcessIdentity, assertCurrent?: () => void, onAccepted?: () => void): Promise<unknown> {
    const socket = await this.connection();
    if (this.closed || socket.destroyed) throw new Error('Process service is closed');
    assertCurrent?.();
    if (this.pending.size >= 128) throw new Error('Terminal request limit reached');
    const id = ++this.next;
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Terminal operation timed out; outcome may be unknown')); }, 15_000);
      this.pending.set(id, { resolve: value => {
        try {
          assertCurrent?.();
          const handle = (params as any)?.processHandle;
          if (typeof handle === 'string' && method !== 'process/kill') {
            if (method === 'process/attach' && (value as any)?.phase !== 'running') this.watched.delete(handle);
            else this.watched.add(handle);
          }
          // Install authorized forwarding synchronously with the reply, before
          // subsequent output/exit frames in the same socket read are consumed.
          onAccepted?.(); resolve(value);
        } catch (error) { reject(error as Error); }
      }, reject, timer });
      sendOwnerFrame(socket, { id, method, params, identity });
    });
    return result;
  }
  close() {
    this.closed = true; this.listeners.clear(); this.watched.clear();
    this.socket?.destroy();
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Process service is closed')); }
    this.pending.clear();
  }
}
