import { EventEmitter } from 'node:events';
import { TextDecoder } from 'node:util';
import type { SandboxEnvironment, SandboxProcess } from '@opencraft/sandbox';

const proxy = `import os,socket,select,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.connect(sys.argv[1])
while True:
 ready,_,_=select.select([s,sys.stdin.buffer],[],[])
 if s in ready:
  data=s.recv(65536)
  if not data: break
  sys.stdout.buffer.write(data);sys.stdout.buffer.flush()
 if sys.stdin.buffer in ready:
  data=os.read(0,65536)
  if not data: break
  s.sendall(data)
s.close()`;
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
/** Existing private Browser Owner v1 protocol over sandbox process pipes. No CDP
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
  let child: SandboxProcess | undefined, stopped = false, attached = false, cleanup: Promise<void> | undefined;
  let resolve!: (value: SandboxBrowserOwnerTransport) => void, reject!: (error: Error) => void;
  const ready = new Promise<SandboxBrowserOwnerTransport>((yes, no) => { resolve = yes; reject = no; });
  // Attach may fail during spawn before the caller starts awaiting ready.
  void ready.catch(() => {});
  let timer: ReturnType<typeof setTimeout>;
  const close = (): Promise<void> => cleanup ??= (async () => {
    stopped = true; transport.connected = false; clearTimeout(timer);
    reject(Error('Sandbox browser transport closed'));
    if (child) try { await child.terminate(); } catch { options.onCleanupUnconfirmed(); throw Error('Sandbox browser transport cleanup unconfirmed'); }
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
      await child.writeStdin(bytes);
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
    child = await options.sandbox.spawn({ command: ['/usr/bin/python3', '-u', '-c', proxy, options.socketPath], cwd: '/workspace', env: {} },
      output => { if (output.stream === 'stdout') receive(output.data); });
    if (stopped) { try { await child.terminate(); } catch { options.onCleanupUnconfirmed(); } throw Error('Sandbox browser attach expired'); }
    void child.exited.then(fail, fail);
    await options.authorize();
    if (stopped) throw Error('Sandbox browser attach expired');
    await child.writeStdin(Buffer.from('{"type":"attach","protocol":1}\n'));
    const attachedOwner = await ready;
    await options.authorize();
    if (stopped) throw Error('Sandbox browser attach expired');
    return attachedOwner;
  } catch (error) { await close(); throw error; }
}
