import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { RelayEntryIdentity, RelayIngress } from '../apps/relay-server/src/server.js';
import { publicOrigin } from '../packages/hub-network/src/contract.js';

const prefix = '/__join_lightvela_test_environments/';
const methods = new Map([['health', 'GET'], ['capabilities', 'GET'], ['environments', 'GET'], ['enter', 'POST']]);

export function createTestEnvironmentIngress(origin: string, authenticate: (request: IncomingMessage) => Promise<RelayEntryIdentity | null>): RelayIngress {
  const upstreamOrigin = publicOrigin(origin);
  return (req, res) => {
    if (!req.url?.startsWith(prefix)) return false;
    const operation = req.url.slice(prefix.length), method = methods.get(operation);
    const deny = (status: number) => {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'cache-control': 'private, no-store' }); res.end();
    };
    if (!method) { deny(404); return true; }
    if (req.method !== method) { deny(405); return true; }
    void (async () => {
      if (req.headers.host !== 'join.woa.com' || req.headers['sec-fetch-site'] === 'cross-site') { deny(403); return; }
      const identity = await authenticate(req);
      if (req.headers.origin !== undefined && req.headers.origin !== identity?.origin) { deny(403); return; }
      if (identity?.principal.provider !== 'tencentoa') { deny(401); return; }
      const cookieName = (identity.origin.startsWith('https:') ? '__Host-' : '') + 'opencraft-relay-session';
      const session = String(req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(cookieName + '='));
      const headers: Record<string, string> = { host: 'join.woa.com', connection: 'close' };
      if ((operation === 'environments' || operation === 'enter') && session) headers.cookie = session;
      if (method === 'POST') {
        if (req.headers.origin !== identity.origin || req.headers['x-lightvela-test-entry'] !== '1') { deny(403); return; }
        const length = req.headers['content-length'];
        if (req.headers['content-type'] !== 'application/json' || req.headers['transfer-encoding']
          || typeof length !== 'string' || !/^[1-9][0-9]{0,2}$/u.test(length) || Number(length) > 128) { deny(400); return; }
        for (const key of ['origin', 'sec-fetch-site', 'x-lightvela-test-entry', 'content-type', 'content-length']) {
          const value = req.headers[key]; if (typeof value === 'string') headers[key] = value;
        }
      }
      const upstream = httpRequest(new URL(req.url!, upstreamOrigin), { method, headers, signal: AbortSignal.timeout(method === 'POST' ? 30_000 : 8_000) }, incoming => {
        const type = incoming.headers['content-type'];
        if (typeof type !== 'string' || !type.startsWith('application/json')) { incoming.resume(); deny(502); return; }
        res.writeHead(incoming.statusCode ?? 502, { 'content-type': type, 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
        incoming.once('error', () => res.destroy()); incoming.once('aborted', () => res.destroy()); incoming.pipe(res);
      });
      upstream.once('error', () => deny(502));
      req.once('aborted', () => upstream.destroy()); res.once('close', () => upstream.destroy());
      if (method === 'POST') req.pipe(upstream); else upstream.end();
    })().catch(() => deny(503));
    return true;
  };
}
