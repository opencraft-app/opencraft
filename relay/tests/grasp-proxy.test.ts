import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { rewriteGrasp } from '../grasp-rewrite.js';
import { graspHeaders, installGraspProxy } from '../grasp-proxy.js';

test('Vite imports are parsed as modules while route strings and comments remain intact', async () => {
  const js = `import '/src/start.ts';export {x} from '/src/x.ts';const route='/login';const lazy=()=>import('/src/lazy.ts');const literal="import '/ignored'";`;
  const transformed = await rewriteGrasp(js, 'application/javascript', '/src/main.ts');
  assert.match(transformed, /import '\/grasp\/src\/start.ts'/);
  assert.match(transformed, /from '\/grasp\/src\/x.ts'/);
  assert.match(transformed, /import\("\/grasp\/src\/lazy.ts"\)/);
  assert.match(transformed, /route='\/login'/);
  assert.match(transformed, /import '\/ignored'/);
  assert.match(await rewriteGrasp('const base = "/" || "/";', 'application/javascript', '/@vite/client'), /const base = "\/grasp\/"/);
  assert.equal(await rewriteGrasp('export default "/src/logo.svg";', 'application/javascript', '/src/logo.svg?import'), 'export default "/grasp/src/logo.svg";');
  const html = await rewriteGrasp('<head></head><script type="module" src="/src/main.ts"></script>', 'text/html', '/');
  assert.match(html, /<base href="\/grasp\/">/); assert.match(html, /src="\/grasp\/src\/main.ts"/);
  assert.equal(await rewriteGrasp('a{background:url(/font.svg)}', 'text/css', '/a.css'), 'a{background:url(/grasp/font.svg)}');
  assert.equal(await rewriteGrasp('const path = window.location.pathname;window.location.assign(`/login?redirect=${path}`);', 'application/javascript', '/src/lib/api/httpCore.ts'), 'const path = window.__graspLocation.pathname;window.__graspLocation.assign(`/login?redirect=${path}`);');
  assert.equal(await rewriteGrasp('const path = window.location.pathname;', 'application/javascript', '/node_modules/vue-router.js'), 'const path = window.location.pathname;', 'router must see the real pathname and apply the HTML base');
});

test('upstream headers exclude Join identity, credentials, forwarding and hop-by-hop fields', () => {
  const headers = graspHeaders({ cookie: '__Host-opencraft-relay-session=secret; grasp-upstream-' + Buffer.from('app').toString('base64url') + '=own', authorization: 'Bearer secret', signature: 'secret', 'x-tai-identity': 'secret', 'x-forwarded-host': 'attacker', 'x-opencraft-relay-assertion': 'secret', connection: 'x-custom', 'x-custom': 'secret', accept: 'text/html' }, new URL('http://127.0.0.1:1234'));
  assert.equal(headers.cookie, 'app=own'); assert.equal(headers.host, '127.0.0.1:1234'); assert.equal(headers.accept, 'text/html');
  for (const key of ['authorization', 'signature', 'x-tai-identity', 'x-opencraft-relay-assertion', 'x-forwarded-host', 'x-custom']) assert.equal(headers[key], undefined);
});

test('HTTP and WebSocket requests require IOA, enforce origin, preserve scoped APIs and leave Join routes alone', async t => {
  let upstreamRequests = 0, received = '';
  const upstream = createServer((req, res) => {
    upstreamRequests++; received = req.url!;
    res.writeHead(200, { 'content-type': req.url?.endsWith('.ts') ? 'application/javascript' : 'text/html', 'set-cookie': 'app=ok; Path=/; HttpOnly' });
    res.end(req.url?.endsWith('.ts') ? 'export default "/src/icon.svg";' : '<head></head><h1>Grasp</h1>');
  });
  upstream.on('upgrade', (req, socket) => { upstreamRequests++; received = req.url!; socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close());
  const server = createServer((_req, res) => res.end('Join'));
  const principal = { provider: 'fixture', subject: 'synthetic', attributes: {}, expiresAt: Date.now() + 60_000 };
  installGraspProxy(server, `http://127.0.0.1:${(upstream.address() as any).port}`, req => req.headers['x-fixture-identity'] === 'verified' ? principal : null, 'https://join.woa.com', rewriteGrasp);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as any).port;
  const get = (path: string, extra = {}) => new Promise<{status:number; body:string; headers:any}>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers: { host: 'join.woa.com', ...extra } }, res => { let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers })); }); req.on('error', reject); req.end();
  });
  assert.equal((await get('/grasp/')).status, 401); assert.equal(upstreamRequests, 0);
  assert.equal((await get('/grasp/', { 'x-fixture-identity': 'verified', origin: 'https://attacker.test' })).status, 401); assert.equal(upstreamRequests, 0);
  assert.equal((await get('/')).body, 'Join');
  const own = { 'x-fixture-identity': 'verified' };
  const html = await get('/grasp/', own); assert.equal(html.status, 200); assert.match(html.body, /<base href="\/grasp\/">/); assert.match(html.headers['set-cookie'][0], /Path=\/grasp\//);
  const module = await get('/grasp/src/main.ts', own); assert.match(module.body, /\/grasp\/src\/icon.svg/); assert.equal(received, '/src/main.ts');
  assert.equal((await get('/grasp', own)).headers.location, '/grasp/');
  const ws = async (verified: boolean) => {
    const socket = connect(port, '127.0.0.1'); await once(socket, 'connect');
    socket.write('GET /grasp/?token=fixture HTTP/1.1\r\nHost: join.woa.com\r\nOrigin: https://join.woa.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + randomBytes(16).toString('base64') + '\r\n' + (verified ? 'X-Fixture-Identity: verified\r\n' : '') + '\r\n');
    let value = ''; socket.on('data', chunk => value += chunk); await once(socket, 'close'); return value;
  };
  assert.match(await ws(false), /401 Unauthorized/);
  assert.match(await ws(true), /502 Bad Gateway/); assert.equal(received, '/?token=fixture');
});
