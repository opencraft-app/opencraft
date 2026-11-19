import { request, type IncomingMessage, type Server, type ServerResponse, type IncomingHttpHeaders } from 'node:http';
import { type Duplex } from 'node:stream';
import { Worker } from 'node:worker_threads';
import type { Principal } from '../../opencraft/packages/identity-core/src/index.js';
import { joinEntryOrigin } from './relay-entry-aliases.js';

const base = '/grasp';
const prefix = (path: string) => path.startsWith('/') && !path.startsWith('//') && path !== base && !path.startsWith(base + '/') ? base + path : path;
const deniedHeaders = new Set(['host', 'cookie', 'authorization', 'proxy-authorization', 'proxy-authenticate', 'connection', 'upgrade', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'timestamp', 'signature', 'x-rio-seq', 'staffid', 'staffname', 'x-ext-data', 'x-tai-identity', 'origin', 'referer', 'accept-encoding']);
export function graspHeaders(input: IncomingHttpHeaders, target: URL, upgrade = false) {
  const connection = new Set(String(input.connection ?? '').toLowerCase().split(',').map(v => v.trim()));
  const headers: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(input)) if (!deniedHeaders.has(key) && !connection.has(key) && !key.startsWith('x-opencraft-') && !key.startsWith('x-forwarded-') && key !== 'forwarded') headers[key] = value;
  headers.host = target.host; headers['accept-encoding'] = 'identity';
  // Browser cookies belong to Join. Only the explicitly scoped Grasp cookies cross this boundary.
  const cookies = String(input.cookie ?? '').split(';').map(v => v.trim()).filter(v => /^grasp-upstream-[A-Za-z0-9_-]+=/.test(v)).flatMap(v => {
    const i = v.indexOf('='), name = Buffer.from(v.slice(15, i), 'base64url').toString();
    return /^[!#$%&'*+.^_`|~\w-]+$/.test(name) ? [name + v.slice(i)] : [];
  });
  if (cookies.length) headers.cookie = cookies.join('; ');
  if (input.origin) headers.origin = target.origin;
  if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
  return headers;
}

function responseHeaders(input: IncomingHttpHeaders) {
  const headers: IncomingHttpHeaders = { ...input, 'cache-control': 'private, no-store' };
  for (const key of ['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'etag', 'content-security-policy', 'content-security-policy-report-only']) delete headers[key];
  if (headers['set-cookie']) headers['set-cookie'] = headers['set-cookie'].map(value => {
    const [pair, ...attrs] = value.split(';'), i = pair!.indexOf('=');
    const name = pair!.slice(0, i), kept = attrs.filter(a => !/^\s*(?:domain|path)\s*=/i.test(a));
    return 'grasp-upstream-' + Buffer.from(name).toString('base64url') + pair!.slice(i) + '; Path=/grasp/' + kept.map(a => ';' + a).join('');
  });
  if (typeof headers.location === 'string' && headers.location.startsWith('/')) headers.location = prefix(headers.location);
  // Root Vite must not install a service worker over the Join origin.
  headers['service-worker-allowed'] = '/grasp/';
  return headers;
}

function fail(response: ServerResponse, code: number) { if (response.headersSent) response.destroy(); else { response.writeHead(code, { 'cache-control': 'no-store' }); response.end(); } }
type Rewrite = (source: string, type: string, path: string) => Promise<string>;
type Authenticate = (request: IncomingMessage) => Principal | null;

function workerRewriter(server: Server): Rewrite {
  const worker = new Worker(new URL('./grasp-rewrite-worker.mjs', import.meta.url));
  let sequence = 0, failed = false;
  const pending = new Map<number, { resolve: (body: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const failAll = () => { failed = true; for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Grasp transformer unavailable')); } pending.clear(); };
  worker.on('message', (value: { id: number; body?: string; error?: boolean }) => {
    const entry = pending.get(value.id); if (!entry) return;
    pending.delete(value.id); clearTimeout(entry.timer);
    if (value.error || typeof value.body !== 'string') entry.reject(new Error('Grasp transform failed')); else entry.resolve(value.body);
  });
  worker.on('error', failAll); worker.on('exit', failAll);
  server.once('close', () => { failAll(); void worker.terminate(); });
  return (source, type, path) => new Promise((resolve, reject) => {
    if (failed || pending.size >= 16) { reject(new Error('Grasp transformer unavailable')); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Grasp transform timed out')); }, 15_000); timer.unref();
    pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, source, type, path });
  });
}

/** Product-owned namespace, fixed upstream, native IOA validation; no Join credentials reach Grasp. */
export function installGraspProxy(server: Server, upstream: string | undefined, authenticate: Authenticate, origin: string, rewrite?: Rewrite) {
  if (!upstream) return;
  const target = new URL(upstream);
  if (target.protocol !== 'http:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Invalid Grasp upstream');
  const transformBody = rewrite ?? workerRewriter(server);
  const approvedOrigin = joinEntryOrigin(origin);
  const authorize = (req: IncomingMessage) => {
    const entry = approvedOrigin(req);
    if (!entry || req.headers.origin !== undefined && req.headers.origin !== entry || req.headers['sec-fetch-site'] === 'cross-site') return null;
    const principal = authenticate(req);
    return principal && principal.expiresAt > Date.now() ? principal : null;
  };
  const matches = (url = '/') => url === base || url.startsWith(base + '/') || url.startsWith(base + '?');
  const listeners = server.listeners('request'); server.removeAllListeners('request');
  server.on('request', (req, res) => {
    if (req.url === '/servers' || req.url?.startsWith('/servers?')) {
      const end = res.end;
      res.end = function (this: ServerResponse, chunk: any, ...args: any[]) {
        if (res.statusCode === 200 && typeof chunk === 'string' && chunk.includes('id="server-choices"')) chunk = chunk.replace('</ul>', '<li><a href="/grasp/">Grasp</a></li></ul>');
        return Reflect.apply(end, this, [chunk, ...args]);
      } as typeof res.end;
    }
    if (!matches(req.url)) { for (const listener of listeners) listener.call(server, req, res); return; }
    if (!authorize(req)) { fail(res, 401); return; }
    if (req.url === base || req.url?.startsWith(base + '?')) { res.writeHead(307, { location: base + '/' + req.url.slice(base.length), 'cache-control': 'no-store' }); res.end(); return; }
    const path = req.url!.slice(base.length);
    // HEAD needs the same rewritten entity semantics, with no response body.
    const remote = request(target, { method: req.method === 'HEAD' ? 'GET' : req.method, path, headers: graspHeaders(req.headers, target) }, response => {
      const type = String(response.headers['content-type'] ?? ''), headers = responseHeaders(response.headers);
      if (typeof headers.location === 'string' && headers.location.startsWith(target.origin + '/')) headers.location = prefix(headers.location.slice(target.origin.length));
      const transform = /(?:javascript|ecmascript|text\/html|text\/css)/.test(type) && response.statusCode === 200;
      if (!transform) { res.writeHead(response.statusCode ?? 502, headers); if (req.method === 'HEAD') { response.resume(); res.end(); } else response.pipe(res); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) { remote.destroy(); fail(res, 502); } else chunks.push(Buffer.from(chunk)); });
      response.on('end', () => { if (res.destroyed || res.writableEnded) return; void transformBody(Buffer.concat(chunks).toString(), type, path).then(body => { if (res.destroyed) return; res.writeHead(response.statusCode ?? 502, headers); res.end(req.method === 'HEAD' ? undefined : body); }).catch(() => fail(res, 502)); });
      response.on('error', () => fail(res, 502)); response.on('aborted', () => fail(res, 502));
    });
    remote.setTimeout(60_000, () => remote.destroy()); remote.on('error', () => fail(res, 502));
    req.on('aborted', () => remote.destroy()); res.once('close', () => remote.destroy()); req.pipe(remote);
  });
  const upgrades = server.listeners('upgrade'); server.removeAllListeners('upgrade');
  server.on('upgrade', (req, socket, head) => {
    if (!matches(req.url)) { for (const listener of upgrades) listener.call(server, req, socket, head); return; }
    const principal = authorize(req);
    if (!principal) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    const remote = request(target, { method: 'GET', path: req.url!.slice(base.length) || '/', headers: graspHeaders(req.headers, target, true) });
    let tunnel: Duplex | undefined;
    const expiry = setTimeout(() => { remote.destroy(); tunnel?.destroy(); socket.destroy(); }, Math.min(principal.expiresAt - Date.now(), 2 ** 31 - 1)); expiry.unref();
    const timer = setTimeout(() => remote.destroy(), 10_000); timer.unref();
    remote.on('upgrade', (response, stream, initial) => {
      clearTimeout(timer); tunnel = stream;
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).filter(([key]) => ['upgrade', 'connection', 'sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions'].includes(key)).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n`);
      if (initial.length) socket.write(initial); if (head.length) stream.write(head);
      stream.on('error', () => socket.destroy()); stream.once('close', () => socket.destroy()); socket.pipe(stream).pipe(socket);
    });
    remote.on('response', response => { response.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
    remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy()); socket.once('close', () => { clearTimeout(expiry); clearTimeout(timer); remote.destroy(); tunnel?.destroy(); }); remote.end();
  });
}
