import { ArtifactCatalog, artifactFileBody, inspectArtifactFile, type Artifact } from '@opencraft/local-agent-host/artifacts';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer, request, type IncomingMessage } from 'node:http';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const HOST_FILESYSTEM_METHODS = new Set(['fs/readDirectory', 'fs/getMetadata', 'fs/readFile', 'fs/writeFile', 'fs/createDirectory']);
const MAX_BYTES = 32 * 1024 * 1024;
export interface HostFileStream { size: number; body: Readable; dispose(): Promise<void> }
export interface HostFileSystem {
  probe(signal?: AbortSignal): Promise<void>;
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  openFile(path: string, head: boolean, signal: AbortSignal, root?: string): Promise<HostFileStream>;
  prepareArtifact(artifact: Artifact, owner: string, signal?: AbortSignal): Promise<Artifact>;
  close(): void;
}
function joinArtifactRoot(endpoint: string) { return resolve(dirname(endpoint), 'artifact-copies'); }
export interface FileSystemEndpoint { endpoint: string; tokenFile: string }
function filePath(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || value.length > 8192) throw Error('Invalid file path');
  return value;
}
async function privateToken(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 4096) throw Error('File owner credential unavailable');
  const token = (await readFile(path, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error('File owner credential unavailable');
  return token;
}
async function bodyJson(body: IncomingMessage, max = MAX_BYTES * 1.4) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > max) throw Error('File request exceeds its budget');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function openFile(path: string, head: boolean, signal: AbortSignal, root?: string): Promise<HostFileStream> {
  filePath(path);
  if (root !== undefined) {
    const [canonical, boundary] = await Promise.all([realpath(path), realpath(filePath(root))]);
    if (!canonical.startsWith(boundary.replace(/\/$/, '') + sep)) throw Error('File outside preview');
    path = canonical;
  }
  signal.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat(); signal.throwIfAborted();
    if (!info.isFile()) throw Error('Not a regular file');
    const body = head ? Readable.from([]) : handle.createReadStream({ signal });
    if (head) await handle.close();
    return { size: info.size, body, dispose: async () => { body.destroy(); await handle.close(); } };
  } catch (error) { await handle.close(); throw error; }
}

/** Files belong to Hands. No shell execution, Native environment or engine lease. */
export async function startHostFileSystem(options: FileSystemEndpoint & { concurrency?: number; queue?: number }) {
  for (const path of [options.endpoint, options.tokenFile]) filePath(path);
  await mkdir(dirname(options.endpoint), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(options.endpoint));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || parent.mode & 0o077) throw Error('File owner directory must be private');
  try { await writeFile(options.tokenFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const token = await privateToken(options.tokenFile);
  // Never unlink an existing owner. Clean shutdown owns removal of this socket.
  const concurrency = options.concurrency ?? 4, capacity = concurrency + (options.queue ?? 64);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(capacity) || capacity < concurrency) throw Error('Invalid file owner capacity');
  let artifactCatalog: ArtifactCatalog | undefined;
  const artifactStore=()=>artifactCatalog??=new ArtifactCatalog(joinArtifactRoot(options.endpoint));
  const drained: (()=>void)[] = [];
  let active = 0, closed = false;
  const controllers = new Set<AbortController>();
  const waiting: { resolve(): void; reject(error: Error): void; signal: AbortSignal; abort(): void }[] = [];
  const writes = new Map<string, Promise<unknown>>();
  async function enter(signal: AbortSignal) {
    signal.throwIfAborted();
    if (active < concurrency) { active++; return; }
    await new Promise<void>((resolve, reject) => {
      const job = { resolve, reject, signal, abort: () => {
        const index = waiting.indexOf(job); if (index >= 0) waiting.splice(index, 1);
        reject(Error('File request cancelled'));
      } };
      waiting.push(job); signal.addEventListener('abort', job.abort, { once: true });
      if (signal.aborted) job.abort();
    });
  }
  function leave() {
    const next = waiting.shift();
    if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(); }
    else active--;
  }
  async function rpc(method: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
    if (!HOST_FILESYSTEM_METHODS.has(method) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Unsupported file request');
    const params = raw as Record<string, unknown>, path = filePath(params.path);
    const keys = method === 'fs/writeFile' ? ['path', 'dataBase64'] : method === 'fs/createDirectory' ? ['path', 'recursive'] : ['path'];
    if (Object.keys(params).some(key => !keys.includes(key))) throw Error('Invalid file request');
    const operation = async () => {
      await enter(signal);
      try {
        signal.throwIfAborted();
        if (method === 'fs/readDirectory') {
          const entries = await readdir(path, { withFileTypes: true });
          if (entries.length > 100_000) throw Error('Directory exceeds its budget');
          return { entries: entries.map(entry => ({ fileName: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() })) };
        }
        if (method === 'fs/getMetadata') {
          const [info, link] = await Promise.all([stat(path), lstat(path)]);
          return { isDirectory: info.isDirectory(), isFile: info.isFile(), isSymlink: link.isSymbolicLink(),
            createdAtMs: Number.isFinite(info.birthtimeMs) ? info.birthtimeMs : 0,
            modifiedAtMs: Number.isFinite(info.mtimeMs) ? info.mtimeMs : 0 };
        }
        if (method === 'fs/createDirectory') {
          if (params.recursive != null && typeof params.recursive !== 'boolean') throw Error('Invalid directory request');
          await mkdir(path, { recursive: params.recursive !== false }); return {};
        }
        if (method === 'fs/writeFile') {
          if (typeof params.dataBase64 !== 'string' || params.dataBase64.length > Math.ceil(MAX_BYTES / 3) * 4) throw Error('Invalid file content');
          const data = Buffer.from(params.dataBase64, 'base64');
          if (data.toString('base64') !== params.dataBase64) throw Error('Invalid file content');
          if (data.length > MAX_BYTES) throw Error('File exceeds RPC budget; use streaming download');
          // Reject devices/FIFOs and avoid blocking the owner on special files.
          const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK);
          try { if (!(await handle.stat()).isFile()) throw Error('Not a regular file'); await handle.truncate(0); await handle.writeFile(data, { signal }); }
          finally { await handle.close(); }
          return {};
        }
        const file = await openFile(path, false, signal);
        try {
          if (file.size > MAX_BYTES) throw Error('File exceeds RPC budget; use streaming download');
          const chunks: Buffer[] = []; let bytes = 0;
          for await (const chunk of file.body) { bytes += chunk.length; if (bytes > MAX_BYTES) throw Error('File exceeds RPC budget'); chunks.push(Buffer.from(chunk)); }
          return { dataBase64: Buffer.concat(chunks).toString('base64') };
        } finally { await file.dispose(); }
      } finally { leave(); }
    };
    if (method !== 'fs/writeFile' && method !== 'fs/createDirectory') return operation();
    const key = await realpath(path).catch(async error => {
      if (error.code !== 'ENOENT') throw error;
      // Resolve the deepest existing ancestor, preserving paths created recursively.
      let ancestor = resolve(path), suffix: string[] = [];
      for (;;) { try { return resolve(await realpath(ancestor), ...suffix); }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' || ancestor === dirname(ancestor)) throw cause;
          suffix.unshift(ancestor.slice(dirname(ancestor).length + (dirname(ancestor) === '/' ? 0 : 1))); ancestor = dirname(ancestor); } }
    });
    const previous = writes.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation); writes.set(key, next);
    try { return await next; } finally { if (writes.get(key) === next) writes.delete(key); }
  }
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401).end(); return; }
    if (closed || controllers.size >= capacity) { res.writeHead(503).end(); return; }
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => controller.abort(); res.once('close', abort); req.once('aborted', abort);
    const timeout = setTimeout(abort, req.url === '/rpc' ? 60_000 : 30 * 60_000);
    try {
      const url = new URL(req.url ?? '/', 'http://files');
      if (url.pathname === '/health' && req.method === 'GET') { res.writeHead(200).end('{"ok":true,"protocol":1}'); return; }
      if (url.pathname === '/rpc' && req.method === 'POST') {
        const value = await bodyJson(req), result = await rpc(value.method, value.params, controller.signal);
        controller.signal.throwIfAborted();
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result })); return;
      }
      if (url.pathname === '/artifact' && ['POST','GET'].includes(req.method ?? '')) {
        await enter(controller.signal);
        try {
          const encoded = req.headers['x-opencraft-artifact'];
          if (typeof encoded !== 'string' || encoded.length > 12000) throw Error('Invalid artifact request');
          const metadata = JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
          if (!/^[a-f0-9]{64}$/.test(metadata.id) || !/^[a-f0-9]{64}$/.test(metadata.sha256)
            || !Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > 1024**3
            || typeof metadata.name !== 'string' || !metadata.name || metadata.name.length > 255
            || typeof metadata.mimeType !== 'string' || metadata.mimeType.length > 255
            || typeof metadata.owner !== 'string' || !metadata.owner || metadata.owner.length > 8192) throw Error('Invalid artifact metadata');
          const identity = {scope:'execution-copy',key:metadata.id};
          const existing = artifactStore().get(artifactStore().id(identity));
          if(existing && (existing.sha256!==metadata.sha256 || existing.size!==metadata.size || existing.name!==metadata.name || existing.mimeType!==metadata.mimeType)) throw Error('Artifact identity mismatch');
          if (req.method === 'GET') {
            if (!existing) { res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({artifact:null})); return; }
            const verified = await inspectArtifactFile(existing.path,controller.signal);
            if (verified.size !== metadata.size || verified.sha256 !== metadata.sha256) throw Error('Artifact content mismatch');
            artifactStore().lease(existing.id,metadata.owner);
            res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({artifact:existing})); return;
          }
          const artifact = await artifactStore().ingest(identity,{name:metadata.name,mimeType:metadata.mimeType,origin:'execution-copy'},req,
            {maxBytes:1024**3,size:metadata.size,sha256:metadata.sha256,signal:controller.signal,
              reference:{owner:metadata.owner,slot:metadata.id}});
          artifactStore().lease(artifact.id,metadata.owner);
          res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({artifact})); return;
        } finally { leave(); }
      }
      if (url.pathname !== '/file' || !['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(404).end(); return; }
      await enter(controller.signal);
      try {
        const head = req.method === 'HEAD', file = await openFile(filePath(url.searchParams.get('path')), head, controller.signal, url.searchParams.get('root') ?? undefined);
        try { res.writeHead(200, { 'content-length': String(file.size), 'content-type': 'application/octet-stream' });
          if (head) res.end(); else await pipeline(file.body, res, { signal: controller.signal }); }
        finally { await file.dispose(); }
      } finally { leave(); }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: -32000,
        message: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'File not found' : 'File operation unavailable' } }));
      else res.destroy();
    } finally { clearTimeout(timeout); controllers.delete(controller); if (!controllers.size) for (const finish of drained.splice(0)) finish(); res.off('close', abort); req.off('aborted', abort); }
  });
  const listen = () => new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(options.endpoint, () => { server.off('error', reject); accept(); }); });
  try { await listen(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    const live = await new Promise<boolean>((accept, reject) => {
      const socket = createConnection(options.endpoint);
      socket.setTimeout(1000);
      socket.once('connect', () => { socket.destroy(); accept(true); });
      socket.once('timeout', () => { socket.destroy(); reject(Error('File owner socket did not answer')); });
      socket.once('error', error => {
        if (['ECONNREFUSED', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) accept(false); else reject(error);
      });
    });
    if (live) throw Error('Filesystem owner already running');
    const stale = await lstat(options.endpoint);
    if (!stale.isSocket() || stale.uid !== process.getuid?.()) throw Error('File owner socket is unavailable');
    await unlink(options.endpoint); await listen();
  }
  await chmod(options.endpoint, 0o600);
  return { async close() {
    closed = true; for (const controller of controllers) controller.abort();
    server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept()));
    await unlink(options.endpoint).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (controllers.size) await new Promise<void>(accept=>drained.push(accept));
    artifactCatalog?.close();
  } };
}

/** One HTTP request per operation; cancellation and large binary streams are independent. */
export function createHostFileSystem(options: FileSystemEndpoint): HostFileSystem {
  let closed = false;
  const lifetime = new AbortController();
  async function send(path: string, method: string, signal?: AbortSignal, value?: unknown) {
    if (closed) throw Error('File owner closed');
    signal = AbortSignal.any([signal ?? new AbortController().signal, lifetime.signal, AbortSignal.timeout(30 * 60_000)]);
    signal.throwIfAborted();
    const token = await privateToken(options.tokenFile);
    return new Promise<IncomingMessage>((accept, reject) => {
      const req = request({ socketPath: options.endpoint, path, method, signal, headers: { authorization: 'Bearer ' + token, ...(value ? { 'content-type': 'application/json' } : {}) } }, response => {
        if (response.statusCode !== 200) { response.resume(); reject(Error('Hands file operation unavailable')); }
        else accept(response);
      });
      req.once('error', reject); req.end(value ? JSON.stringify(value) : undefined);
    });
  }
  async function transferArtifact(artifact: Artifact, owner: string, signal?: AbortSignal): Promise<Artifact> {
    if (closed) throw Error('File owner closed');
    const combined = AbortSignal.any([signal ?? new AbortController().signal,lifetime.signal,AbortSignal.timeout(30*60_000)]);
    const token = await privateToken(options.tokenFile);
    const metadata = Buffer.from(JSON.stringify({id:artifact.id,name:artifact.name,mimeType:artifact.mimeType,size:artifact.size,sha256:artifact.sha256,owner})).toString('base64url');
    async function call(method: 'GET'|'POST') {
      let req!: ReturnType<typeof request>;
      const response = new Promise<IncomingMessage>((accept,reject) => {
        req = request({socketPath:options.endpoint,path:'/artifact',method,signal:combined,
          headers:{authorization:'Bearer '+token,'x-opencraft-artifact':metadata,
            ...(method==='POST'?{'content-length':String(artifact.size),'content-type':'application/octet-stream'}:{})}},accept);
        req.once('error',reject);
      });
      // Observe response failure even while a source stream is still being sent.
      void response.catch(()=>{});
      try {
        if (method==='POST') await pipeline(artifactFileBody(artifact.path),req,{signal:combined}); else req.end();
        const incoming = await response;
        try {
          if (incoming.statusCode !== 200) throw Error('Artifact delivery unavailable');
          return (await bodyJson(incoming,16384)).artifact as Artifact | null;
        } finally { incoming.destroy(); }
      } catch (error) { req.destroy(); throw error; }
    }
    const result = await call('GET') ?? await call('POST');
    if (!result || result.size !== artifact.size || result.sha256 !== artifact.sha256 || result.name !== artifact.name || result.mimeType !== artifact.mimeType || typeof result.path !== 'string') throw Error('Invalid artifact delivery result');
    return result;
  }
  return {
    prepareArtifact: transferArtifact,
    async probe(signal) {
      const response = await send('/health', 'GET', signal ?? AbortSignal.timeout(5000));
      try { const value = await bodyJson(response, 1024); if (!value.ok || value.protocol !== 1) throw Error('File owner protocol unavailable'); }
      finally { response.destroy(); }
    },
    async request(method, params, signal) {
      if (!HOST_FILESYSTEM_METHODS.has(method)) throw Error('Unsupported file request');
      const response = await send('/rpc', 'POST', AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(60_000)]), { method, params });
      try { const value = await bodyJson(response); return value.result; } finally { response.destroy(); }
    },
    async openFile(path, head, signal, root) {
      const query = new URLSearchParams({ path: filePath(path), ...(root ? { root: filePath(root) } : {}) });
      const response = await send('/file?' + query, head ? 'HEAD' : 'GET', signal);
      const size = Number(response.headers['content-length']);
      if (!Number.isSafeInteger(size) || size < 0) { response.destroy(); throw Error('Invalid file size'); }
      return { size, body: response, dispose: async () => { response.destroy(); } };
    },
    close() { closed = true; lifetime.abort(); },
  };
}
