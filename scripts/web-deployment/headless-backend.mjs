import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';

/** Only Headless-owned API routes. Static files and update authority stay in Web. */
export const headlessBackendRoutes = Object.freeze({
  http: ['/appserver', '/apphost', '/ssh-apphost', '/desktop/connect', '/__opencraft_health', '/health', '/__opencraft_ssh_servers', '/__opencraft_apphost_diagnostic'],
  prefixes: ['/__opencraft_observe', '/__opencraft_browser', '/__opencraft_hub', '/__opencraft_auth', '/__opencraft_actors', '/__opencraft_connectors', '/__opencraft_im', '/__opencraft_access', '/__opencraft_ssh', '/__opencraft_enterprise_identity', '/__opencraft_speech', '/__opencraft_apphost'],
  upgrade: ['/__opencraft_browser/stream', '/appserver', '/apphost', '/ssh-apphost', '/desktop/connect', '/__opencraft_hub/control', '/__opencraft_hub/data'],
});
export function validHeadlessBackendRoutes(value) {
  return !!value && ['http', 'prefixes', 'upgrade'].every(key => Array.isArray(value[key]) && value[key].length <= 64
    && value[key].every(path => typeof path === 'string' && path.length <= 128 && /^\/[A-Za-z0-9/_-]+$/u.test(path)
      && !path.startsWith('//') && !path.split('/').includes('..')));
}
export function isHeadlessBackendPath(pathname, upgrade = false, routes = headlessBackendRoutes) {
  return upgrade ? routes.upgrade.includes(pathname) : routes.http.includes(pathname)
    || routes.prefixes.some(prefix => pathname === prefix || pathname.startsWith(prefix + '/'));
}
export function createHeadlessBackendProxy(target) {
  if (!target) return null;
  const url = new URL(target);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Headless backend must be a loopback HTTP origin');
  const port = Number(url.port || 80);
  return {
    // Documents are served by the static worker, but installation admission belongs to Headless.
    // The private relay entry probes every static request, independent of Accept.
    // Direct legacy deployments retain their per-navigation policy.
    admitDocument(request, response) {
      return new Promise(resolve => {
        const headers = { ...request.headers };
        const connectionTokens = String(headers.connection ?? '').toLowerCase().split(',').map(value => value.trim());
        for (const name of ['content-length', 'transfer-encoding', 'content-type', 'expect', 'connection', 'upgrade', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', ...connectionTokens]) delete headers[name];
        const probe = httpRequest({ hostname: '127.0.0.1', port, method: 'GET',
          path: '/__opencraft_access/admission', headers: { ...headers, accept: 'text/html',
            'x-opencraft-relay-probe-method': request.method, 'x-opencraft-relay-probe-path': request.url } }, result => {
          if (result.statusCode === 204) { result.resume(); resolve(true); return; }
          response.writeHead(result.statusCode === 401 || result.statusCode === 403 ? result.statusCode : 503,
            { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store',
              'x-content-type-options': 'nosniff', "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
          result.on('error', () => response.destroy()); result.pipe(response); resolve(false);
        });
        probe.setTimeout(5000, () => probe.destroy(new Error('Admission unavailable')));
        probe.on('error', () => {
          if (!response.headersSent) { response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); response.end('暂时无法确认访问权限，请稍后重试。'); }
          else response.destroy();
          resolve(false);
        });
        response.once('close', () => probe.destroy()); probe.end();
      });
    },
    http(request, response, release) {
      const upstream = httpRequest({ hostname: '127.0.0.1', port, path: request.url, method: request.method, headers: request.headers }, result => {
        result.on('error', () => response.destroy()); result.on('aborted', () => response.destroy());
        result.on('close', () => { if (!result.complete) response.destroy(); });
        response.writeHead(result.statusCode, result.headers); result.pipe(response);
      });
      upstream.on('error', () => { if (!response.headersSent) { response.writeHead(502, { 'content-type': 'application/json' }); response.end('{"error":"Headless backend unavailable"}'); } else response.destroy(); });
      response.once('close', () => { upstream.destroy(); release(); }); request.pipe(upstream);
    },
    upgrade(request, socket, head, release, tunnels) {
      const upstream = createConnection({ host: '127.0.0.1', port }); tunnels.add(socket);
      socket.once('close', () => { tunnels.delete(socket); upstream.destroy(); release(); });
      socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy()); upstream.once('close', () => socket.destroy());
      upstream.once('connect', () => {
        const headers = request.rawHeaders;
        upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${Array.from({ length: headers.length / 2 }, (_, i) => `${headers[i * 2]}: ${headers[i * 2 + 1]}`).join('\r\n')}\r\n\r\n`);
        if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
      });
    },
  };
}
