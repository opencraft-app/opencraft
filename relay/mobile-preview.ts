import { request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export const MOBILE_PREVIEW_PREFIX = '/mobile/';
const publicHost = 'join.woa.com';
const allowedHeaders = new Set(['accept', 'accept-encoding', 'expo-platform', 'expo-protocol-version', 'expo-runtime-version', 'expo-expect-signature', 'expo-json-error']);

export function prefixExpoManifest(value: unknown, path: readonly string[] = [], publicOrigin = 'https://join.woa.com'): unknown {
  if (Array.isArray(value)) return value.map((child, index) => prefixExpoManifest(child, [...path, String(index)], publicOrigin));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    ['hostUri', 'debuggerHost'].includes(key) && typeof child === 'string' && /^join\.woa\.com(?::(?:80|443))?$/u.test(child)
      ? publicHost + MOBILE_PREVIEW_PREFIX : prefixExpoManifest(child, [...path, key], publicOrigin)]));
  const asset = path[0] === 'launchAsset' || path[0] === 'assets'
    || (path[0] === 'extra' && path[1] === 'expoClient' && ['iconUrl', 'imageUrl', 'faviconUrl'].includes(path.at(-1) ?? ''));
  if (asset && typeof value === 'string') {
    const origin = ['http://', 'https://'].map(scheme => scheme + publicHost).find(candidate => value.startsWith(candidate + '/'));
    if (origin) {
      const resource = value.slice(origin.length);
      return publicOrigin + (resource.startsWith(MOBILE_PREVIEW_PREFIX) ? resource : MOBILE_PREVIEW_PREFIX + resource.slice(1));
    }
  }
  return value;
}

function launchPage(response: ServerResponse, secure: boolean, head: boolean) {
  const uri = `${secure ? 'exps' : 'exp'}://${publicHost}${MOBILE_PREVIEW_PREFIX}`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Expo Go 手机预览</title><style>
  :root{color-scheme:light dark;font-family:system-ui,sans-serif;background:Canvas;color:CanvasText}*{box-sizing:border-box}body{margin:0;padding:max(32px,env(safe-area-inset-top)) 24px max(32px,env(safe-area-inset-bottom));min-height:100svh;display:grid;place-items:center}main{width:100%;max-width:360px}h1{font-size:28px;line-height:1.2;margin:0 0 16px}p{font-size:16px;line-height:1.6;margin:0 0 28px}a{display:flex;min-height:52px;align-items:center;justify-content:center;padding:12px 20px;border-radius:16px;background:CanvasText;color:Canvas;font-weight:600;text-decoration:none}a:focus-visible{outline:2px solid CanvasText;outline-offset:4px}small{display:block;margin-top:24px;font-size:13px;line-height:1.5}
  </style></head><body><main><h1>在 Expo Go 中预览</h1><p>点击下方按钮，打开手机预览。</p><a href="${uri}">在 Expo Go 打开</a><small>需要已安装兼容 SDK 57 的 Expo Go。</small></main></body></html>`;
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(html), 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
  response.end(head ? undefined : html);
}

function unavailable(response: ServerResponse) {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: 'Mobile preview is not running' }));
}

/** Product-owned, read-only Expo Go namespace; no business credentials enter Metro. */
export function installJoinMobilePreview(server: Server, port = 18087): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid preview port');
  const listeners = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? '/';
    if (path !== '/mobile' && !path.startsWith(MOBILE_PREVIEW_PREFIX)) {
      for (const listener of listeners) listener.call(server, request, response);
      return;
    }
    if (!/^join\.woa\.com(?::(?:80|443))?$/iu.test(request.headers.host ?? '')) {
      response.writeHead(404); response.end(); return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' }); response.end(); return;
    }
    if (path === '/mobile') { response.writeHead(307, { location: MOBILE_PREVIEW_PREFIX }); response.end(); return; }
    const target = '/' + path.slice(MOBILE_PREVIEW_PREFIX.length);
    let pathname: string;
    try { pathname = decodeURIComponent(target.split('?')[0]!); }
    catch { response.writeHead(400); response.end(); return; }
    if (/[\x00-\x20\x7f\\]/u.test(pathname) || pathname.split('/').some(part => part === '..' || part === '.')) {
      response.writeHead(400); response.end(); return;
    }
    const manifest = pathname === '/';
    if (!manifest && !pathname.startsWith('/assets/') && !/^\/(?:apps\/mobile\/index\.ts|\.expo\/\.virtual-metro-entry)\.bundle$/u.test(pathname)) {
      response.writeHead(404); response.end(); return;
    }
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => allowedHeaders.has(key)));
    if (manifest) {
      const platform = request.headers['expo-platform'] ?? new URL(target, 'http://localhost').searchParams.get('platform');
      const nativeRequest = platform !== null && platform !== undefined
        || request.headers['expo-protocol-version'] !== undefined
        || /application\/(?:expo\+json|json)|multipart\/mixed/iu.test(String(request.headers.accept ?? ''));
      if (!nativeRequest) {
        launchPage(response, request.headers['x-forwarded-proto'] === 'https', request.method === 'HEAD');
        return;
      }
      if (platform !== null && platform !== undefined && platform !== 'ios' && platform !== 'android') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Unsupported mobile platform' }));
        return;
      }
      headers['expo-platform'] = platform ?? 'ios';
      headers.accept = 'application/expo+json'; headers['accept-encoding'] = 'identity';
    }
    const upstream = httpRequest({ hostname: '127.0.0.1', port, path: target, method: request.method, headers }, result => {
      if (!manifest || result.statusCode !== 200 || request.method === 'HEAD') {
        const safe = { ...result.headers, 'cache-control': 'no-store' };
        delete safe['set-cookie'];
        response.writeHead(result.statusCode ?? 502, safe); result.pipe(response); return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      result.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { result.destroy(); unavailable(response); }
        else chunks.push(Buffer.from(chunk));
      });
      result.on('error', () => unavailable(response));
      result.on('end', () => {
        if (response.destroyed || response.writableEnded) return;
        try {
          const publicOrigin = request.headers['x-forwarded-proto'] === 'https' ? 'https://' + publicHost : 'http://' + publicHost;
          const document = JSON.stringify(prefixExpoManifest(JSON.parse(Buffer.concat(chunks).toString('utf8')), [], publicOrigin));
          const protocolHeaders = Object.fromEntries(['expo-protocol-version', 'expo-sfv-version'].flatMap(key => {
            const value = result.headers[key];
            return typeof value === 'string' ? [[key, value]] : [];
          }));
          response.writeHead(200, { ...protocolHeaders, 'content-type': 'application/expo+json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(document) });
          response.end(document);
        } catch { unavailable(response); }
      });
    });
    upstream.setTimeout(manifest ? 30_000 : 300_000, () => upstream.destroy());
    upstream.on('error', () => unavailable(response));
    response.once('close', () => upstream.destroy());
    upstream.end();
  });
}
