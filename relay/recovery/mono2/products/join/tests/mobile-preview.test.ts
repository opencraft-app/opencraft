import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { installJoinMobilePreview } from '../mobile-preview.ts';

test('fixed Expo Go path rewrites manifest resources, strips business credentials and leaves other routes alone', async () => {
  const seen: Array<{ path: string; cookie?: string; authorization?: string; accept?: string }> = [];
  const metro = createServer((req, res) => {
    seen.push({ path: req.url!, cookie: req.headers.cookie, authorization: req.headers.authorization, accept: req.headers.accept });
    if (req.url?.startsWith('/?')) {
      res.setHeader('content-type', 'application/expo+json');
      res.setHeader('expo-protocol-version', '0');
      res.setHeader('expo-sfv-version', '0');
      res.end(JSON.stringify({ launchAsset: { url: 'https://join.woa.com/apps/mobile/index.ts.bundle?platform=ios' }, assets: [{ url: 'https://join.woa.com/assets/icon.png' }], extra: { expoClient: { hostUri: 'join.woa.com:80', extra: { apiBase: 'https://join.woa.com/api' } } } }));
    } else { res.setHeader('set-cookie', 'must-not-leak=1'); res.end('asset-bytes'); }
  });
  metro.listen(0, '127.0.0.1'); await once(metro, 'listening');
  const address = metro.address(); assert(address && typeof address !== 'string');
  const relay = createServer((_req, res) => { res.writeHead(401); res.end('employee-login'); });
  const upgrade = () => {}; relay.on('upgrade', upgrade);
  installJoinMobilePreview(relay, address.port);
  assert.deepEqual(relay.listeners('upgrade'), [upgrade]);
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  const target = relay.address(); assert(target && typeof target !== 'string');
  const query = (path: string, method = 'GET', host = 'join.woa.com', https = false) => new Promise<{ status: number; body: string; cookie?: string | string[]; protocol?: string; sfv?: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: target.port, path, method, headers: { host, cookie: 'employee-secret', authorization: 'Bearer secret', ...(https ? { 'x-forwarded-proto': 'https' } : {}) } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, body, cookie: res.headers['set-cookie'], ...(res.headers['expo-protocol-version'] ? { protocol: String(res.headers['expo-protocol-version']) } : {}), ...(res.headers['expo-sfv-version'] ? { sfv: String(res.headers['expo-sfv-version']) } : {}) }));
    }); req.on('error', reject); req.end();
  });
  try {
    const manifest = await query('/mobile/?platform=ios');
    assert.equal(manifest.status, 200);
    assert.equal(manifest.protocol, '0');
    assert.equal(manifest.sfv, '0');
    const parsed = JSON.parse(manifest.body);
    assert.equal(parsed.launchAsset.url, 'http://join.woa.com/mobile/apps/mobile/index.ts.bundle?platform=ios');
    assert.equal(parsed.assets[0].url, 'http://join.woa.com/mobile/assets/icon.png');
    assert.equal(parsed.extra.expoClient.extra.apiBase, 'https://join.woa.com/api');
    assert.equal(parsed.extra.expoClient.hostUri, 'join.woa.com/mobile/');
    const tls = await query('/mobile/?platform=ios', 'GET', 'join.woa.com', true);
    assert.equal(JSON.parse(tls.body).launchAsset.url, 'https://join.woa.com/mobile/apps/mobile/index.ts.bundle?platform=ios');
    assert.deepEqual(seen[0], { path: '/?platform=ios', accept: 'application/expo+json', cookie: undefined, authorization: undefined });
    assert.equal((await query('/mobile/apps/mobile/index.ts.bundle?platform=ios')).status, 200);
    assert.deepEqual(await query('/mobile/assets/icon.png'), { status: 200, body: 'asset-bytes', cookie: undefined });
    assert.equal((await query('/mobile/?platform=ios', 'POST')).status, 405);
    assert.equal((await query('/mobile/?platform=ios', 'GET', 'unrelated.example')).status, 404);
    assert.equal((await query('/mobile/%2e%2e/.env')).status, 400);
    assert.equal((await query('/mobile/.env')).status, 404);
    assert.equal((await query('/settings')).status, 401);
    await new Promise<void>(resolve => metro.close(() => resolve()));
    assert.equal((await query('/mobile/?platform=ios')).status, 503);
  } finally { relay.closeAllConnections(); metro.closeAllConnections(); await Promise.all([new Promise<void>(resolve => relay.close(() => resolve())), new Promise<void>(resolve => metro.close(() => resolve()))]); }
});

test('Safari receives an Expo Go launcher while native and headerless manifest clients receive JSON', async () => {
  const platforms: string[] = [];
  const metro = createServer((req, res) => {
    if (!req.headers['expo-platform']) { res.setHeader('content-type', 'text/html'); res.end('<html>Metro landing page</html>'); return; }
    platforms.push(String(req.headers['expo-platform']));
    res.setHeader('expo-protocol-version', '0'); res.setHeader('expo-sfv-version', '0');
    res.setHeader('content-type', 'application/expo+json');
    res.end(JSON.stringify({ platform: req.headers['expo-platform'], launchAsset: { url: 'http://join.woa.com/apps/mobile/index.ts.bundle' } }));
  });
  metro.listen(0, '127.0.0.1'); await once(metro, 'listening');
  const address = metro.address(); assert(address && typeof address !== 'string');
  const relay = createServer((_req, res) => { res.writeHead(401); res.end(); });
  installJoinMobilePreview(relay, address.port);
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  const target = relay.address(); assert(target && typeof target !== 'string');
  const query = (headers: Record<string, string | undefined> = {}, path = '/mobile/', method = 'GET') => new Promise<{ status: number; body: string; type?: string; protocol?: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: target.port, path, method, headers: { host: 'join.woa.com', ...headers } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body, type: res.headers['content-type'], protocol: String(res.headers['expo-protocol-version'] ?? '') }));
    }); req.on('error', reject); req.end();
  });
  try {
    for (const headers of [{}, { accept: 'text/html', 'user-agent': 'Mobile Safari' }]) {
      const browser = await query(headers);
      assert.equal(browser.status, 200); assert.match(browser.type!, /^text\/html/);
      assert.match(browser.body, /href="exp:\/\/join\.woa\.com\/mobile\/"/);
      assert.doesNotMatch(browser.body, /<script/);
    }
    assert.deepEqual(platforms, []);
    const head = await query({ accept: 'text/html' }, '/mobile/', 'HEAD'); assert.equal(head.status, 200); assert.equal(head.body, '');
    for (const headers of [
      { accept: 'application/expo+json' },
      { accept: 'multipart/mixed', 'expo-platform': 'ios' },
      { 'expo-protocol-version': '0' },
    ]) {
      const native = await query(headers); assert.equal(native.status, 200); assert.equal(native.protocol, '0');
      assert.equal(JSON.parse(native.body).platform, 'ios');
    }
    assert.equal(JSON.parse((await query({ 'expo-platform': 'android' })).body).platform, 'android');
    assert.equal(JSON.parse((await query({}, '/mobile/?platform=android')).body).platform, 'android');
    assert.equal((await query({ 'expo-platform': 'web' })).status, 400);
    assert.equal((await query({}, '/mobile/?platform=web')).status, 400);
  } finally {
    relay.closeAllConnections(); metro.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => relay.close(() => resolve())), new Promise<void>(resolve => metro.close(() => resolve()))]);
  }
});
