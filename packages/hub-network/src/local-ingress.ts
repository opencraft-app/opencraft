import { createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import type { Duplex } from 'node:stream';
import { relayPathAllowed } from '../../relay-protocol/src/index.js';

/** A tunnel never exports the software updater, peer transport or operator authority. */
export function createLocalIngress(target: () => { port: number; origin: string }) {
  const allowed = (req: { url?: string; headers: { host?: string; origin?: string } }) => {
    try { const local = target(), path = decodeURIComponent(new URL(req.url ?? '/', 'http://hub.invalid').pathname);
      return local.port > 0 && local.origin && req.headers.host === new URL(local.origin).host
        && (req.headers.origin === undefined || req.headers.origin === local.origin) && relayPathAllowed(req.url ?? '/')
        && (!path.startsWith('/__opencraft_hub') || path === '/__opencraft_hub/settings');
    } catch { return false; }
  };
  const server = createServer((req, res) => {
    if (!allowed(req)) { res.writeHead(403, { 'cache-control': 'no-store' }); res.end(); return; }
    const upstream = request({ host: '127.0.0.1', port: target().port, method: req.method, path: req.url, headers: req.headers }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers); response.on('error', () => res.destroy()); response.on('aborted', () => res.destroy()); response.pipe(res);
    });
    upstream.setTimeout(3600_000, () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy(); });
    req.on('aborted', () => upstream.destroy()); res.once('close', () => upstream.destroy()); req.pipe(upstream);
  });
  server.headersTimeout = 15_000; server.requestTimeout = 600_000;
  server.on('upgrade', (req, socket, head) => {
    if (!allowed(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const upstream = createConnection({ host: '127.0.0.1', port: target().port });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    upstream.once('close', () => socket.destroy()); socket.once('close', () => upstream.destroy());
    upstream.once('connect', () => {
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${Array.from({ length: req.rawHeaders.length / 2 }, (_, i) => `${req.rawHeaders[i * 2]}: ${req.rawHeaders[i * 2 + 1]}`).join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
    });
  });
  return { accept(stream: Duplex) { server.emit('connection', stream); }, close() { server.close(); server.closeAllConnections(); } };
}
