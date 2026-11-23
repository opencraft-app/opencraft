import { EventEmitter } from 'node:events';
import { TextDecoder } from 'node:util';
import { openSandboxEndpoint, type SandboxEndpointConnection, type SandboxEnvironment } from '@opencraft/sandbox';

export interface SandboxBrowserOwnerTransport extends EventEmitter {
  connected: boolean;
  inventory: unknown[];
  workerPid: number;
  automationCancellation: number;
  automationNavigation: number;
  send(message: unknown, callback?: (error?: Error) => void): void;
  /** Detach only; the workspace lifecycle owns the independent browser owner. */
  kill(): void;
  close(): Promise<void>;
}
/** Existing private Browser Owner v1 protocol over a provider-neutral sandbox endpoint
 * (one attached relay process; its loss ends this attachment only). No CDP
 * listener, new page owner, local browser fallback or write replay is introduced.
 * Runtime preparation/startup and per-page authority remain with their owners. */
export async function connectSandboxBrowserOwner(options: {
  sandbox: Pick<SandboxEnvironment, 'spawn'>;
  /** Incarnation-local IPC, never placed on the persistent NFS workspace. */
  socketPath: string;
  authorize(): Promise<void>;
  onLost(): void;
  onCleanupUnconfirmed(): void;
}): Promise<SandboxBrowserOwnerTransport> {
  if (!/^\/tmp\/opencraft-browser-[a-zA-Z0-9_-]{1,64}\/owner\.sock$/.test(options.socketPath))
    throw Error('Invalid sandbox browser socket');
  await options.authorize();
  const transport = new EventEmitter() as SandboxBrowserOwnerTransport;
  transport.connected = false;
  let child: SandboxEndpointConnection | undefined, stopped = false, attached = false, cleanup: Promise<void> | undefined;
  let resolve!: (value: SandboxBrowserOwnerTransport) => void, reject!: (error: Error) => void;
  const ready = new Promise<SandboxBrowserOwnerTransport>((yes, no) => { resolve = yes; reject = no; });
  // Attach may fail during spawn before the caller starts awaiting ready.
  void ready.catch(() => {});
  let timer: ReturnType<typeof setTimeout>;
  const close = (): Promise<void> => cleanup ??= (async () => {
    stopped = true; transport.connected = false; clearTimeout(timer);
    reject(Error('Sandbox browser transport closed'));
    if (child) try { await child.close(); } catch { options.onCleanupUnconfirmed(); throw Error('Sandbox browser transport cleanup unconfirmed'); }
  })();
  const fail = () => {
    if (stopped) return;
    if (attached) { try { options.onLost(); } catch {} }
    reject(Error('Sandbox browser owner unavailable'));
    void close().catch(() => {});
    if (attached) queueMicrotask(() => transport.emit('exit'));
  };
  timer = setTimeout(fail, 15000); timer.unref();
  transport.kill = () => { void close().catch(() => {}); };
  transport.close = close;
  let pendingBytes = 0, pendingCount = 0, writes = Promise.resolve();
  transport.send = (message, callback) => {
    let bytes: Buffer;
    try {
      if (!message || typeof message !== 'object' || Array.isArray(message)
        || typeof (message as { id?: unknown }).id !== 'string'
        || ((message as { id: string }).id).length > 100) throw Error('invalid message');
      bytes = Buffer.from(JSON.stringify(message) + '\n');
    }
    catch { callback?.(Error('Invalid browser owner message')); return; }
    if (stopped || !attached || bytes.length > 256 * 1024 || pendingBytes + bytes.length > 4 * 1024 * 1024 || pendingCount >= 128) {
      callback?.(Error('Browser owner transport unavailable')); return;
    }
    pendingBytes += bytes.length; pendingCount++;
    const operation = writes.then(async () => {
      await options.authorize();
      if (stopped || !child) throw Error('Browser owner transport unavailable');
      await child.write(bytes);
    });
    writes = operation.catch(() => { fail(); });
    void operation.then(() => { callback?.(); }, () => { callback?.(Error('Browser owner transport unavailable')); })
      .finally(() => { pendingBytes -= bytes.length; pendingCount--; }).catch(() => {});
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', bufferBytes = 0;
  const receive = (data: Uint8Array) => {
    if (stopped) return;
    try {
      const decoded = decoder.decode(data, { stream: true });
      buffer += decoded; bufferBytes += Buffer.byteLength(decoded);
      for (;;) {
        const end = buffer.indexOf('\n');
        const lineBytes = end < 0 ? bufferBytes : Buffer.byteLength(buffer.slice(0, end));
        if (lineBytes > 32 * 1024 * 1024) throw Error('frame limit');
        if (end < 0) return;
        const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); bufferBytes -= lineBytes + 1;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid frame');
        if (!attached) {
          if (value.type !== 'attached' || value.protocol !== 1 || !Array.isArray(value.pages)
            || value.pages.length > 1024 || !Number.isSafeInteger(value.workerPid) || value.workerPid <= 0
            || value.automationCancellation !== 1 || value.automationNavigation !== 1) throw Error('owner incompatible');
          attached = true; transport.connected = true; clearTimeout(timer);
          transport.inventory = value.pages; transport.workerPid = value.workerPid;
          transport.automationCancellation = 1; transport.automationNavigation = 1;
          resolve(transport);
        } else queueMicrotask(() => { if (!stopped) transport.emit('message', value); });
      }
    } catch { fail(); }
  };
  try {
    child = await openSandboxEndpoint(options.sandbox, { target: { unix: options.socketPath }, cwd: '/workspace', onData: receive });
    if (stopped) { try { await child.close(); } catch { options.onCleanupUnconfirmed(); } throw Error('Sandbox browser attach expired'); }
    void child.closed.then(fail);
    await options.authorize();
    if (stopped) throw Error('Sandbox browser attach expired');
    await child.write(Buffer.from('{"type":"attach","protocol":1}\n'));
    const attachedOwner = await ready;
    await options.authorize();
    if (stopped) throw Error('Sandbox browser attach expired');
    return attachedOwner;
  } catch (error) { await close(); throw error; }
}
