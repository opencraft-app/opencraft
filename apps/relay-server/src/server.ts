import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createGunzip, createBrotliDecompress, createInflate } from 'node:zlib';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { relayDuplex } from '@opencraft/relay-protocol/node';
import { AssertionSigner, ASSERTION_HEADER, type IdentityProvider } from "@opencraft/identity-core/node";
import { CONTROL_PATH, DATA_PATH, STREAM_HEADER, RELAY_PROTOCOL, MAX_RELAY_STREAMS, relayPathAllowed } from "@opencraft/relay-protocol";
import { RelayAuthentication, type EntryOriginResolver } from './authentication.js';
import type { HubNetwork } from '../../../packages/hub-network/src/node.js';
import { SERVERS_PATH, LEGACY_SERVERS_PATH, isServerPath, selectedPath, serverBase, selectorPage, scopedHtml, targetCookies, scopedCookies, selectionDefault, parseServerPaths, type ServerPaths } from './selection.js';
import type { Principal } from '@opencraft/identity-core';
import type { HubService } from '../../../packages/hub-network/src/contract.js';

export interface RelayRoute {
  readonly instanceId: string;
  readonly name?: string;
  readonly origin: string;
  readonly credential: string;
  readonly signer: AssertionSigner;
  readonly identityProvider: IdentityProvider;
  readonly hubId?: string;
}
interface Connection { socket: WebSocket; streams: Set<Duplex>; alive: boolean; }
interface Pending { connection: Connection; token: string; accept: (socket: WebSocket) => void; reject: (error: Error) => void; }
function equal(a: string, b: string) { return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest()); }
function bearer(req: IncomingMessage) { const value = req.headers.authorization; return typeof value === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/u.test(value) ? value.slice(7) : ''; }
function failure(response: ServerResponse, status: number) {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json' }); response.end(JSON.stringify({ error: status === 401 ? 'authentication_required' : status === 403 ? 'access_denied' : 'relay_unavailable' }));
}
function reject(socket: Duplex, code: number) { socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
const identityHeaders = new Set(['timestamp', 'signature', 'x-rio-seq', 'staffid', 'staffname', 'x-ext-data', 'x-tai-identity']);
export function createRelayServer(routes: readonly RelayRoute[], options: { authentication?: { origin: string; provider: IdentityProvider }; entryOrigin?: EntryOriginResolver; build?: { sourceRevision: string | null; buildId: string | null };
  hub?: HubNetwork; networkRoute?: (service: HubService) => RelayRoute | null; operator?: { credential: string }; serverSelection?: boolean; selectionDefaults?: ReadonlyMap<string, string>; serverPaths?: ServerPaths } = {}) {
  if ((!routes.length && !options.hub) || routes.length > 1000) throw new Error('Relay requires explicit routes');
  const byHost = new Map<string, RelayRoute>(), byId = new Map<string, RelayRoute>();
  for (const route of routes) {
    const url = new URL(route.origin);
    if (route.origin !== url.origin || !['http:', 'https:'].includes(url.protocol) || !/^[A-Za-z0-9_-]{43}$/u.test(route.credential)
      || route.signer.scope.instanceId !== route.instanceId || route.signer.scope.origin !== route.origin
      || (route.name !== undefined && (typeof route.name !== 'string' || !route.name.trim() || route.name.length>128))
      || byHost.has(url.host) || byId.has(route.instanceId) || [...byId.values()].some(r => equal(r.credential, route.credential))) throw new Error('Invalid or duplicate relay route');
    byHost.set(url.host, route); byId.set(route.instanceId, route);
  }
  if (options.serverSelection && (!options.authentication || !routes.some(route => route.origin === options.authentication!.origin))) throw new Error('Server selection requires an authenticated entry route');
  if (options.entryOrigin && !options.serverSelection) throw new Error('Entry origins require shared server selection');
  const paths = options.serverPaths === undefined ? undefined : parseServerPaths(options.serverPaths);
  if (paths && (!options.serverSelection || (paths.defaultServer !== undefined
    && !routes.some(r => r.instanceId === paths.defaultServer && r.origin === options.authentication?.origin))
    || Object.entries(paths.aliases ?? {}).some(([id, label]) => routes.some(r => r.instanceId === label && r.instanceId !== id)))) throw new Error('Ambiguous or invalid server paths');
  const routeLabel = (id: string) => paths?.aliases && Object.hasOwn(paths.aliases, id) ? paths.aliases[id]! : id;
  const canonicalBase = (id: string) => paths?.defaultServer === id ? '' : serverBase(routeLabel(id));
  const resolveRoute = (key: string) => {
    const matches = availableRoutes().filter(r => routeLabel(r.instanceId) === key);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const connections = new Map<string, Connection>(), pending = new Map<string, Pending>();
  const availableRoutes = () => [...routes, ...(options.hub?.routes() ?? []).flatMap(r => {
    const route = options.networkRoute?.(r.service); return route && !byHost.has(new URL(route.origin).host) && !byId.has(route.instanceId)
      && (!options.authentication || new URL(route.origin).host !== new URL(options.authentication.origin).host) ? [route] : [];
  })];
  const names = () => new Map((options.hub?.snapshot().peers ?? []).filter(p => p.hubId).map(p => [p.hubId!, p.name]));
  const selected = new WeakMap<IncomingMessage, { route: RelayRoute; principal: Principal; base: string; name: string; canonicalPath?: string }>();
  const authentication = options.authentication ? new RelayAuthentication(options.authentication.origin, options.authentication.provider, availableRoutes, options.entryOrigin) : null;
  const findRoute = (request: IncomingMessage) => {
    const host = request.headers.host ?? '';
    const route = availableRoutes().find(r => new URL(r.origin).host === host);
    if (route || !authentication || !options.entryOrigin) return route;
    const origin = authentication.originFor(request);
    if (origin === authentication.origin) return undefined;
    const entry = routes.find(r => r.origin === authentication.origin);
    return entry ? { ...entry, origin } : undefined;
  };
  const controls = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const data = new WebSocketServer({ noServer: true, maxPayload: 65_536, perMessageDeflate: false });
  let closing = false;
  const retire = (connection: Connection) => {
    connection.socket.terminate();
    for (const stream of connection.streams) stream.destroy();
    for (const [id, p] of pending) if (p.connection === connection) { pending.delete(id); p.reject(new Error('Relay disconnected')); }
  };
  async function channel(route: RelayRoute, signal: AbortSignal): Promise<Duplex> {
    if (route.hubId && options.hub) return options.hub.open(route.hubId, undefined, signal);
    const connection = connections.get(route.instanceId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN || connection.streams.size + [...pending.values()].filter(p => p.connection === connection).length >= MAX_RELAY_STREAMS || pending.size + [...connections.values()].reduce((sum,c)=>sum+c.streams.size,0) >= 4096 || closing) throw new Error('Instance unavailable or busy');
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    return new Promise((resolve, rejectPromise) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); pending.delete(id); };
      const abort = () => { cleanup(); rejectPromise(new Error('Client disconnected')); };
      const timer = setTimeout(() => { cleanup(); rejectPromise(new Error('Relay connection timeout')); }, 10_000); timer.unref();
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      pending.set(id, { connection, token, reject: error => { cleanup(); rejectPromise(error); }, accept: ws => {
        cleanup(); const stream = relayDuplex(ws);
        stream.on('error', () => {}); connection.streams.add(stream);
        const lifetime = setTimeout(() => stream.destroy(), 3_600_000); lifetime.unref();
        stream.once('close', () => { clearTimeout(lifetime); connection.streams.delete(stream); ws.terminate(); }); resolve(stream);
      } });
      connection.socket.send(JSON.stringify({ type: 'open', id, token }));
    });
  }
  function authorize(req: IncomingMessage) {
    const context = selected.get(req);
    if (context) return { route: context.route, principal: context.principal };
    const route = findRoute(req);
    if (!route || !relayPathAllowed(req.url ?? '/') || (req.headers.origin !== undefined && req.headers.origin !== route.origin)) return { status: 403 as const };
    const principal = authentication ? authentication.authenticate(req, route) : route.identityProvider.authenticate(req);
    if (!principal || principal.expiresAt <= Date.now()) return { status: 401 as const };
    return { route, principal };
  }
  function headers(req: IncomingMessage, assertion: string, upgrade = false) {
    const result: Record<string, string | string[]> = {};
    const connectionTokens = String(req.headers.connection ?? '').toLowerCase().split(',').map(s => s.trim());
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || key.startsWith('x-opencraft-relay-') || key.startsWith('x-forwarded-') || key === 'forwarded'
        || identityHeaders.has(key) || ['connection', 'upgrade', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', ...connectionTokens].includes(key)
        || (upgrade && ['content-length', 'transfer-encoding'].includes(key))) continue;
      result[key] = value;
    }
    if (typeof result.cookie === 'string') {
      const cookies = result.cookie.split(';').map(c=>c.trim()).filter(c => !/^(?:__Host-)?opencraft-relay-(?:session|login)=/u.test(c)
        && !/^(?:__Host-|__Secure-)?opencraft-server-[a-f0-9]{32}-/u.test(c));
      if (cookies.length) result.cookie = cookies.join('; '); else delete result.cookie;
    }
    result.host = req.headers.host!;
    result[ASSERTION_HEADER] = assertion;
    result.connection = upgrade ? 'Upgrade' : 'close';
    if (upgrade) result.upgrade = 'websocket';
    return result;
  }
  function prepareSelection(req: IncomingMessage): number {
    const path = req.url ?? '/';
    if (!options.serverSelection) return 0;
    const entry = findRoute(req);
    const unprefixed = !isServerPath(path) && entry && entry.origin === authentication?.originFor(req)
      && (paths?.defaultServer === entry.instanceId || entry.origin !== authentication?.origin);
    if (!isServerPath(path) && !unprefixed) return 0;
    const target = unprefixed ? { id: routeLabel(entry!.instanceId), path, base: '' } : selectedPath(path);
    if (!target || !entry || !relayPathAllowed(target.path) || isServerPath(target.path)) return 403;
    if (req.headers.origin !== undefined && req.headers.origin !== entry.origin) return 403;
    const route = resolveRoute(target.id); if (!route) return 404;
    const principal = authentication ? authentication.authenticate(req, entry) : entry.identityProvider.authenticate(req);
    if (!principal || principal.expiresAt <= Date.now()) return 401;
    const document = req.method === 'GET' && req.headers.accept?.includes('text/html');
    const base = document && paths ? canonicalBase(route.instanceId) : target.base;
    selected.set(req, { route, principal, base, ...(document && base !== target.base ? { canonicalPath: base + target.path } : {}), name: route.name ?? (names().get(route.hubId ?? '')?.trim() || new URL(route.origin).hostname) });
    req.url = target.path; req.headers.host = new URL(route.origin).host;
    if (req.headers.origin !== undefined) req.headers.origin = route.origin;
    // SSH session grants are origin-bound. A browser's Referer still uses the
    // entry address; translate only a same-entry reference to this exact target.
    if (req.headers.referer) {
      try {
        const reference = new URL(req.headers.referer);
        const scope = selectedPath(reference.pathname + reference.search);
        if (reference.origin === entry.origin && ((scope && resolveRoute(scope.id)?.instanceId === route.instanceId)
          || (!scope && !isServerPath(reference.pathname) && paths?.defaultServer === route.instanceId))) {
          req.headers.referer = route.origin + (scope?.path ?? reference.pathname + reference.search);
        }
      } catch { /* Untrusted/malformed references never gain a target origin. */ }
    }
    // Preserve only this installation's namespaced cookies; never the entry login.
    const cookies=targetCookies(req.headers.cookie,route.instanceId);
    if(cookies)req.headers.cookie=cookies;else delete req.headers.cookie;
    return 0;
  }
  async function admitted(route: RelayRoute, principal: Principal): Promise<boolean> {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 4000); let stream: Duplex | undefined;
    const path = '/__opencraft_access/session';
    try {
      stream = await channel(route, abort.signal);
      return await new Promise<boolean>(resolve => {
        const upstream = httpRequest({ method: 'GET', path, createConnection: () => stream!, headers: { host: new URL(route.origin).host,
          [ASSERTION_HEADER]: route.signer.issue(principal, 'GET', path), connection: 'close' } }, response => {
          let body = ''; response.on('data', chunk => { body += String(chunk); if (body.length > 16384) upstream.destroy(); });
          response.on('end', () => { try { const value = JSON.parse(body); resolve(response.statusCode === 200 && ['member','admin'].includes(value.role)); } catch { resolve(false); } });
          response.on('error', () => resolve(false));
        });
        abort.signal.addEventListener('abort', () => upstream.destroy(), { once: true }); upstream.on('error', () => resolve(false)); upstream.end();
      });
    } catch { return false; } finally { clearTimeout(timer); stream?.destroy(); }
  }
  async function handleSelector(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!options.serverSelection) return false;
    const url = new URL(req.url ?? '/', 'http://selector.invalid'), entry = findRoute(req);
    if (!entry || !authentication || entry.origin !== authentication.originFor(req)) return false;
    // Canonicalize browser bookmarks only. Existing clients keep their original
    // HTTP/stream/WS prefix until navigation; never redirect a request body.
    if (req.method === 'GET' && (url.pathname === LEGACY_SERVERS_PATH || url.pathname === LEGACY_SERVERS_PATH + '/' || url.pathname === SERVERS_PATH + '/'
      || (url.pathname.startsWith(LEGACY_SERVERS_PATH + '/') && req.headers.accept?.includes('text/html') && selectedPath(req.url ?? '') !== null))) {
      if (req.headers.origin !== undefined && req.headers.origin !== entry.origin) { failure(res,403); return true; }
      const location = url.pathname.startsWith(LEGACY_SERVERS_PATH) ? SERVERS_PATH + url.pathname.slice(LEGACY_SERVERS_PATH.length).replace(/^\/$/u, '') + url.search : SERVERS_PATH + url.search;
      res.writeHead(308, {location, 'cache-control':'no-store'}); res.end(); return true;
    }
    if (req.method !== 'GET' || !((url.pathname === '/' && req.headers.accept?.includes('text/html') && (!paths?.defaultServer || !url.search)) || url.pathname === SERVERS_PATH)) return false;
    if (req.headers.origin !== undefined && req.headers.origin !== entry.origin) { failure(res,403); return true; }
    const principal = authentication.authenticate(req, entry);
    if (!principal || principal.expiresAt <= Date.now()) { authentication.begin(req,res,entry); return true; }
    const candidates = availableRoutes().slice(0,128), visible: { id: string; name: string; route?: string }[] = [], labels = names();
    for (let i=0; i<candidates.length; i+=8) {
      const group = candidates.slice(i,i+8), access = await Promise.all(group.map(route => admitted(route,principal)));
      for (let j=0; j<group.length; j++) if (access[j]) { const route=group[j]!; visible.push({id:route.instanceId,route:routeLabel(route.instanceId),name:route.name ?? (labels.get(route.hubId ?? '')?.trim() || new URL(route.origin).hostname)}); }
    }
    res.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'private, no-store','referrer-policy':'no-referrer','x-frame-options':'DENY'});
    res.end(selectorPage(principal,visible,url.pathname === '/',selectionDefault(principal,options.selectionDefaults) ?? paths?.defaultServer)); return true;
  }
  const server = createServer(async (req, res) => {
    if (req.url === '/__opencraft_hub/operator') {
      if (!options.hub || !options.operator || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') || !equal(bearer(req), options.operator.credential)) { failure(res, 403); return; }
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(options.hub.snapshot())); return; }
      if (req.method !== 'POST') { failure(res, 403); return; }
      try {
        const { readCommand } = await import('../../../packages/hub-network/src/node.js'); const input = await readCommand(req);
        const operator = typeof req.headers['x-opencraft-hub-operator'] === 'string' ? Buffer.from(req.headers['x-opencraft-hub-operator'], 'base64url').toString('utf8') : 'local-operator';
        const result = options.hub.command(input, operator); res.writeHead('conflict' in result ? 409 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(result));
      } catch { res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"error":"invalid_hub_change"}'); } return;
    }
    if (req.url === '/__opencraft_relay/health' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ok:true,protocol:1,...options.build})); return; }
    if (authentication?.handle(req, res)) return;
    if (await handleSelector(req,res)) return;
    const selectionStatus = prepareSelection(req);
    if (selectionStatus) {
      const entry = findRoute(req);
      if (selectionStatus===401 && authentication && entry && req.method==='GET' && req.headers.accept?.includes('text/html')) authentication.begin(req,res,entry);
      else if (selectionStatus === 404 && req.method === 'GET' && req.headers.accept?.includes('text/html')) { res.writeHead(303,{location:SERVERS_PATH,'cache-control':'no-store'});res.end(); }
      else failure(res,selectionStatus); return;
    }
    const auth = authorize(req);
    if ('status' in auth) {
      const route = findRoute(req);
      if (auth.status === 401 && authentication && route && req.method === 'GET' && req.headers.accept?.includes('text/html')) authentication.begin(req, res, route);
      else failure(res, auth.status!);
      return;
    }
    const abort = new AbortController(); res.once('close', () => abort.abort());
    let stream: Duplex | undefined;
    try {
      stream = await channel(auth.route, abort.signal);
      const upstream = httpRequest({ host: new URL(auth.route.origin).hostname, method: req.method, path: req.url,
        createConnection: () => stream!, headers: headers(req, auth.route.signer.issue(auth.principal, req.method!, req.url!)) }, result => {
        const context = selected.get(req);
        const targetPath = (req.url ?? '/').split('?')[0]!;
        const standalonePreview = targetPath === '/__opencraft_preview' || targetPath.startsWith('/__opencraft_preview/');
        // Preview documents already own their relative URLs, CSP and sandbox.
        // Workbench HTML injection would corrupt them and buffer large reports.
        // Old entry bookmarks can load the Workbench without deployment context,
        // hiding Settings → Servers. Canonicalize only admitted HTML navigation,
        // preserving this instance and deep link; never replay API request bodies.
        if (!standalonePreview && !context && options.serverSelection && auth.route.origin === options.authentication?.origin
          && req.method === 'GET' && req.headers.accept?.includes('text/html')
          && result.statusCode === 200 && String(result.headers['content-type']).includes('text/html')) {
          result.resume();
          res.writeHead(303, { location: serverBase(auth.route.instanceId) + req.url!, 'cache-control': 'private, no-store' });
          res.end(); return;
        }
        if (!standalonePreview && context && (result.statusCode ?? 502) >= 400 && req.method === 'GET' && req.headers.accept?.includes('text/html')) {
          result.resume(); res.writeHead(303, {location:SERVERS_PATH,'cache-control':'no-store'});res.end();return;
        }
        if (!standalonePreview && context && String(result.headers['content-type']).includes('text/html')) {
          const encoding=result.headers['content-encoding'];
          const decoder=encoding==='gzip'?createGunzip():encoding==='br'?createBrotliDecompress():encoding==='deflate'?createInflate():null;
          if(encoding && encoding!=='identity' && !decoder){result.resume();failure(res,502);return;}
          const document=decoder?result.pipe(decoder):result;
          let body = '', bytes=0; document.setEncoding('utf8'); document.on('data', chunk => {
            bytes+=Buffer.byteLength(chunk); if(bytes>2_097_152){upstream.destroy(new Error('Relay document limit'));document.destroy();return;} body+=chunk;
          });
          result.on('error', () => res.destroy());document.on('error', () => res.destroy());result.on('aborted',()=>res.destroy()); document.on('end', () => {
            const navigation = req.method === 'GET' && req.headers.accept?.includes('text/html') && result.statusCode === 200;
            const html = scopedHtml(body,{id:context.route.instanceId,name:context.name,base:context.base,targetOrigin:context.route.origin,canonicalPath:context.canonicalPath},navigation ? auth.principal : undefined);
            const output = {...result.headers}; delete output['content-length']; delete output['content-encoding']; delete output['transfer-encoding']; delete output.etag;
            if(output['set-cookie'])output['set-cookie']=scopedCookies(output['set-cookie'],context.route.instanceId,context.base);
            res.writeHead(result.statusCode ?? 502,{...output,'cache-control':'private, no-store','content-length':Buffer.byteLength(html)});res.end(html);
          });
        } else { const output = {...result.headers}; if(context && output['set-cookie']) output['set-cookie']=scopedCookies(output['set-cookie'],context.route.instanceId,context.base); res.writeHead(result.statusCode ?? 502, output); result.on('error', () => res.destroy()); result.on('aborted', () => res.destroy()); result.pipe(res); }
      });
      const responseTimer = setTimeout(() => upstream.destroy(new Error('Relay response timeout')), 60_000); responseTimer.unref();
      upstream.once('response', () => clearTimeout(responseTimer)); upstream.once('close', () => clearTimeout(responseTimer));
      upstream.on('error', () => failure(res, 502));
      res.once('close', () => { upstream.destroy(); stream?.destroy(); }); req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
    } catch { stream?.destroy(); if (selected.has(req) && req.method === 'GET' && req.headers.accept?.includes('text/html')) { res.writeHead(303,{location:SERVERS_PATH,'cache-control':'no-store'});res.end(); } else failure(res, 503); }
  });
  server.maxConnections = 16_384;
  server.headersTimeout = 15_000;
  server.requestTimeout = 600_000;
  server.maxRequestsPerSocket = 1000;
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    if (options.hub?.handleUpgrade(req, socket, head)) return;
    if (req.url === CONTROL_PATH) {
      const token = bearer(req), route = [...byId.values()].find(r => token && equal(r.credential, token));
      if (!route || req.headers['sec-websocket-protocol'] !== RELAY_PROTOCOL || req.headers.origin) { reject(socket, 401); return; }
      controls.handleUpgrade(req, socket, head, ws => {
        const previous = connections.get(route.instanceId); if (previous) retire(previous);
        const connection: Connection = { socket: ws, streams: new Set(), alive: true }; connections.set(route.instanceId, connection);
        ws.on('pong', () => { connection.alive = true; }); ws.on('error', () => {});
        ws.on('message', () => ws.close(1008, 'Unexpected control message'));
        ws.once('close', () => { if (connections.get(route.instanceId) === connection) connections.delete(route.instanceId); retire(connection); });
      }); return;
    }
    if (req.url === DATA_PATH) {
      const id = req.headers[STREAM_HEADER], p = typeof id === 'string' ? pending.get(id) : undefined;
      if (!p || !equal(bearer(req), p.token) || req.headers.origin || req.headers['sec-websocket-protocol'] !== RELAY_PROTOCOL) { reject(socket, 401); return; }
      pending.delete(String(id)); data.handleUpgrade(req, socket, head, ws => p.accept(ws)); return;
    }
    const selectionStatus = prepareSelection(req); if (selectionStatus) { reject(socket,selectionStatus); return; }
    const auth = authorize(req); if ('status' in auth) { reject(socket, auth.status!); return; }
    if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['transfer-encoding'] !== undefined || ![undefined, '0'].includes(req.headers['content-length'])) { reject(socket, 400); return; }
    const abort = new AbortController(); socket.once('close', () => abort.abort());
    void (async () => {
      let stream: Duplex | undefined;
      try {
        stream = await channel(auth.route, abort.signal);
        const upstream = httpRequest({ host: new URL(auth.route.origin).hostname, method: req.method, path: req.url,
          createConnection: () => stream!, headers: headers(req, auth.route.signer.issue(auth.principal, req.method!, req.url!), true) });
        upstream.on('upgrade', (response, tunnel, initial) => {
          socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).flatMap(([k,v]) => (Array.isArray(v) ? v : [v]).map(x => `${k}: ${x}`)).join('\r\n')}\r\n\r\n`);
          if (initial.length) socket.write(initial); if (head.length) tunnel.write(head);
          socket.pipe(tunnel); tunnel.pipe(socket);
          const timer = setTimeout(() => socket.destroy(), Math.min(auth.principal.expiresAt - Date.now(), 2_147_483_647)); timer.unref();
          socket.once('close', () => { clearTimeout(timer); tunnel.destroy(); }); tunnel.once('close', () => socket.destroy()); tunnel.on('error', () => socket.destroy());
        });
        upstream.on('response', response => { reject(socket, response.statusCode ?? 502); response.resume(); stream?.destroy(); });
        upstream.on('error', () => { socket.destroy(); stream?.destroy(); }); socket.once('close', () => { upstream.destroy(); stream?.destroy(); });
        const upgradeTimer = setTimeout(() => upstream.destroy(), 30_000); upgradeTimer.unref();
        upstream.once('upgrade', () => clearTimeout(upgradeTimer)); upstream.once('close', () => clearTimeout(upgradeTimer)); upstream.end();
      } catch { stream?.destroy(); reject(socket, 503); }
    })();
  });
  const heartbeat = setInterval(() => { for (const connection of connections.values()) {
    if (!connection.alive) retire(connection); else { connection.alive = false; connection.socket.ping(); }
  } }, 15_000); heartbeat.unref();
  return { server, connected: (id: string) => connections.has(id), async close() {
    closing = true; clearInterval(heartbeat); for (const connection of connections.values()) retire(connection);
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); controls.close(); data.close();
  } };
}
