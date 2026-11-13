import { createHash, randomBytes } from 'node:crypto';
import { BrowserWindow, session, type MessagePortMain, type Session } from 'electron';
import WebSocket from 'ws';
import { parseDesktopServerConnection, type DesktopServerConnection } from '@opencraft/app-host-protocol/desktop-server';
import { remoteServerOrigin } from '@opencraft/plugin-local-account/connections';
import { ServerAccessDenied, ServerSignInRequired, verifyDesktopServer } from './desktop-server-admission.js';

class ServerSignInCancelled extends Error {}

/** Installation-scoped native owner. Neither cookies nor a remote DOM enters the renderer. */
export class DesktopServerConnections {
  private readonly attempts = new Map<string, AbortController>();
  private readonly bridges = new Set<() => void>();
  // Each scope binds an immutable native-held credential snapshot, never a Human identity.
  private readonly credentialSessions = new Map<string, { connection: DesktopServerConnection; cookie: string }>();
  private closed = false;
  constructor(private readonly parent: () => BrowserWindow | null, private readonly revoked: (value: DesktopServerConnection) => void, private readonly loginTitle: () => string) {}
  private partition(origin: string): Session {
    const partition = session.fromPartition('persist:opencraft-server-' + createHash('sha256').update(origin).digest('hex'));
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    return partition;
  }
  private async credentialSession(origin: string, partition: Session, signal?: AbortSignal): Promise<DesktopServerConnection> {
    const cookies = await partition.cookies.get({ url: origin + '/appserver' });
    signal?.throwIfAborted();
    const cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    for (const grant of this.credentialSessions.values()) {
      if (grant.connection.origin === origin && grant.cookie === cookie) return grant.connection;
    }
    const connection = { origin, accountKey: randomBytes(32).toString('hex') };
    this.credentialSessions.set(connection.accountKey, { connection, cookie });
    return connection;
  }
  async validate(value: unknown): Promise<DesktopServerConnection | null> {
    const config = parseDesktopServerConnection(value);
    if (this.closed) return null;
    if (this.credentialSessions.get(config.accountKey)?.connection.origin === config.origin) return config;
    const partition = this.partition(config.origin);
    try {
      await verifyDesktopServer(config.origin, partition.fetch.bind(partition));
      return await this.credentialSession(config.origin, partition);
    } catch (error) {
      if (error instanceof ServerSignInRequired || error instanceof ServerAccessDenied) return null;
      throw error;
    }
  }

  cancel(id: string): void { this.attempts.get(id)?.abort(); }
  async prepare(id: string, input: string): Promise<DesktopServerConnection | null> {
    if (this.closed || !/^[a-zA-Z0-9-]{1,100}$/u.test(id) || this.attempts.has(id)) throw new Error('Invalid server configuration attempt');
    // Only one foreground sign-in can own this desktop configuration flow.
    for (const controller of this.attempts.values()) controller.abort();
    const controller = new AbortController();
    this.attempts.set(id, controller);
    const timeout = setTimeout(() => controller.abort(), 5 * 60_000);
    try {
      const origin = remoteServerOrigin(input), partition = this.partition(origin);
      const verify = async () => {
        await verifyDesktopServer(origin, partition.fetch.bind(partition), controller.signal);
        return this.credentialSession(origin, partition, controller.signal);
      };
      try { return await verify(); }
      catch (error) {
        controller.signal.throwIfAborted();
        if (!(error instanceof ServerSignInRequired)) throw error;
        return await this.signIn(origin, partition, verify, controller.signal);
      }
    } catch (error) {
      if (controller.signal.aborted || error instanceof ServerSignInCancelled) return null;
      throw error;
    } finally { controller.abort(); clearTimeout(timeout); if (this.attempts.get(id) === controller) this.attempts.delete(id); }
  }
  private signIn(origin: string, partition: Session, verify: () => Promise<DesktopServerConnection>, signal: AbortSignal): Promise<DesktopServerConnection> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const parent = this.parent();
      const window = new BrowserWindow({ title: this.loginTitle(), width: 560, height: 740, show: false,
        ...(parent ? { parent } : {}), webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false } });
      let finished = false, checking = false, again = false;
      const finish = (value?: DesktopServerConnection, error?: unknown) => {
        if (finished) return; finished = true;
        signal.removeEventListener('abort', abort);
        partition.cookies.off('changed', check);
        if (!window.isDestroyed()) window.destroy();
        if (value) resolve(value); else reject(error ?? new ServerSignInCancelled());
      };
      const abort = () => finish(undefined, signal.reason);
      const check = () => {
        if (finished) return;
        if (checking) { again = true; return; }
        checking = true;
        void verify().then(value => { if (!signal.aborted) finish(value); }, () => {}).finally(() => {
          checking = false; if (again && !finished) { again = false; check(); }
        });
      };
      signal.addEventListener('abort', abort, { once: true });
      partition.cookies.on('changed', check);
      window.once('closed', () => finish());
      window.webContents.on('page-title-updated', event => event.preventDefault());
      window.webContents.setWindowOpenHandler(({ url }) => {
        // Authentication providers may request a popup. Keep it in this isolated login surface.
        if (url.startsWith('https://') || new URL(url).origin === origin) void window.loadURL(url).catch(() => finish());
        return { action: 'deny' };
      });
      const navigate = (event: Electron.Event, url: string) => {
        const target = new URL(url);
        if (!['https:', 'http:'].includes(target.protocol) || (target.protocol === 'http:' && target.origin !== origin)) { event.preventDefault(); return; }
        if (target.origin === origin && ['/', '/index.html'].includes(target.pathname)) { event.preventDefault(); check(); }
      };
      window.webContents.on('will-navigate', navigate);
      window.webContents.on('will-redirect', navigate);
      window.webContents.on('did-navigate', check);
      window.webContents.on('did-finish-load', check);
      window.once('ready-to-show', () => { if (!finished) window.show(); });
      void window.loadURL(origin + '/__opencraft_auth/').catch(() => { if (!finished) finish(undefined, new Error('Server sign-in could not load')); });
    });
  }
  async connect(value: unknown, port: MessagePortMain): Promise<void> {
    const config = parseDesktopServerConnection(value);
    let closed = false, socket: WebSocket | null = null;
    const controller = new AbortController();
    const close = () => { if (closed) return; closed = true; controller.abort(); this.bridges.delete(close); socket?.terminate(); port.close(); };
    this.bridges.add(close);
    port.once('close', close);
    port.start();
    const fail = () => { if (closed) return; port.postMessage({ type: 'error' }); setImmediate(close); };
    try {
      if (this.closed) throw new Error('Desktop server owner closed');
      const partition = this.partition(config.origin);
      const grant = this.credentialSessions.get(config.accountKey);
      if (!grant || grant.connection.origin !== config.origin) { this.revoked(config); throw new Error('Server session retired'); }
      controller.signal.throwIfAborted();
      const endpoint = new URL('/appserver', config.origin); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(endpoint.href, { origin: config.origin, headers: { 'user-agent': partition.getUserAgent(), cookie: grant.cookie }, handshakeTimeout: 10_000, maxPayload: 100 * 1024 * 1024, followRedirects: false });
      socket.on('open', () => { if (!closed) port.postMessage({ type: 'open' }); });
      socket.on('message', (data, binary) => { if (!closed && !binary) port.postMessage({ type: 'message', data: data.toString() }); });
      socket.on('error', fail);
      socket.on('unexpected-response', (_request, response) => { if ([401, 403].includes(response.statusCode ?? 0)) { this.credentialSessions.delete(config.accountKey); this.revoked(config); } response.resume(); fail(); });
      socket.on('close', () => { if (!closed) {
        // Network recovery reuses this immutable credential snapshot. A rejected
        // upgrade retires it; ambient browser cookies cannot replace its account.
        port.postMessage({ type: 'close' }); setImmediate(close);
      } });
      port.on('message', event => {
        if (!closed && typeof event.data === 'string' && Buffer.byteLength(event.data) <= 16 * 1024 * 1024 && socket?.readyState === WebSocket.OPEN) socket.send(event.data);
        else fail();
      });
    } catch (error) {
      if ((error instanceof ServerSignInRequired || error instanceof ServerAccessDenied)) this.revoked(config);
      fail();
    }
  }
  releaseRenderer(): void {
    for (const controller of this.attempts.values()) controller.abort();
    for (const close of [...this.bridges]) close();
    this.credentialSessions.clear();
  }
  close(): void { this.closed = true; this.releaseRenderer(); }
}
