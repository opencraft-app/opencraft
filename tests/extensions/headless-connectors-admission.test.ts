import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { ActorStore } from '../../packages/access-control/src/actors';
import { ActorAccess } from '../../packages/access-control/src/actor-access';
import { HeadlessConnectors } from '../../packages/connector-host/src/headless';
import { SessionCapabilities } from '../../packages/session-capabilities/src/index';
import { AssertionSigner, AssertionProvider, ASSERTION_HEADER } from '../../packages/identity-core/src/node';
import { createManagedWebServer as currentSupervisor } from '../../scripts/web-deployment/server.mjs';
test('managed connector requests consume a relay assertion once and reject replay', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-connector-audit-'));
  const actors = new ActorStore(join(root, 'actors.sqlite'));
  const pair = generateKeyPairSync('ed25519'), scope = { issuer: 'audit-fixture', instanceId: 'audit', origin: 'http://fixture.test' };
  const signer = new AssertionSigner(scope, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const provider = new AssertionProvider(scope, pair.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const access = new ActorAccess(actors, { authenticateHuman: r => provider.authenticate(r), admitted: () => true, administrator: () => false, trustedOrigin: () => scope.origin });
  const service = new HeadlessConnectors(join(root, 'connectors'), access, { first: 'server:fixture:dsh' }, new SessionCapabilities());
  const paths: string[] = [];
  const backend = createServer(async (req, res) => {
    paths.push(`${req.method} ${req.url}`);
    if (req.url === '/__opencraft_access/admission') { res.writeHead(provider.authenticate(req) ? 204 : 401); res.end(); return; }
    if (req.url === '/__opencraft_future') { res.writeHead(provider.authenticate(req) ? 200 : 401); res.end('{}'); return; }
    if (!await service.handle(req, res)) { res.writeHead(404); res.end(); }
  });
  backend.on('clientError', (error, socket) => { console.error('SYNTHETIC BACKEND PARSER', error.code, error.message); socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const target = `http://127.0.0.1:${(backend.address() as any).port}`;
  const priorBackendEnv = process.env.OPENCRAFT_HEADLESS_BACKEND_URL;
  process.env.OPENCRAFT_HEADLESS_BACKEND_URL = target;
  t.after(() => { if (priorBackendEnv === undefined) delete process.env.OPENCRAFT_HEADLESS_BACKEND_URL; else process.env.OPENCRAFT_HEADLESS_BACKEND_URL = priorBackendEnv; });
  t.after(async () => { await service.close(); backend.closeAllConnections(); await new Promise<void>(r => backend.close(() => r())); actors.close(); await rm(root, { recursive: true }); });
  // Isolated static worker; no execution engine, credentials or business data.
  const release = join(root, 'fixture-package');
  await mkdir(join(release, 'web'), { recursive: true }); await mkdir(join(release, 'runtime'));
  await writeFile(join(release, 'package.json'), JSON.stringify({ name: '@opencraft-app/opencraft', version: '0.0.0-audit', opencraftWeb: { schemaVersion: 1, workerProtocol: 1, buildId: 'audit' }, opencraftExecution: { profile: 'headless' } }));
  await writeFile(join(release, 'web/version.json'), JSON.stringify({ schemaVersion: 1, buildId: 'audit', headlessServer: true }));
  await writeFile(join(release, 'web/index.html'), '<html><head><meta name="opencraft-build-id" content="audit"></head><body>Audit</body></html>');
  const workerSource = (await readFile('scripts/web-deployment/worker.mjs', 'utf8')).replace('headlessBackendRoutes });', "headlessBackendRoutes: { ...headlessBackendRoutes, prefixes: [...headlessBackendRoutes.prefixes, '/__opencraft_future'] } });");
  await build({ stdin: { contents: workerSource, resolveDir: new URL('../../scripts/web-deployment', import.meta.url).pathname }, outfile: join(release, 'runtime/worker.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['bufferutil', 'utf-8-validate'], banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
  const principal = { provider: 'fixture', subject: 'synthetic-human', displayName: 'Synthetic', expiresAt: Date.now() + 60000 };
  const app = await currentSupervisor({ initialRelease: release, stateDirectory: join(root, 'managed'), headlessBackendTarget: target, relayIngressTarget: 'http://127.0.0.1:9', relayInternalPort: 0 });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = app.internalAddress().port;
    const proof = signer.issue(principal, 'POST', '/__opencraft_connectors');
    const body = JSON.stringify({ hostId: 'first', method: 'state', params: {} });
    const call = (path = '/__opencraft_connectors', assertion = proof) => new Promise<{ status: number; value: any }>((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: {
        host: 'fixture.test', origin: scope.origin, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), [ASSERTION_HEADER]: assertion,
      } }, res => {
        let text = ''; res.on('data', part => { text += part; });
        res.on('end', () => { try { resolve({ status: res.statusCode!, value: JSON.parse(text) }); } catch (error) { reject(error); } });
      }); req.on('error', reject); req.end(body);
    });
    paths.length = 0;
    assert.equal((await call()).status, 200);
    assert.deepEqual(paths, ['POST /__opencraft_connectors']);
    const replay = await call();
    assert.equal(replay.status, 401); assert.equal(replay.value.error, 'human_authentication_required');
    assert.deepEqual(paths, Array(2).fill('POST /__opencraft_connectors'));
    const future = await call('/__opencraft_future', signer.issue(principal, 'POST', '/__opencraft_future'));
    assert.equal(future.status, 200);
    assert.equal(paths.at(-1), 'POST /__opencraft_future');
    assert.ok(!paths.some(path => path.includes('/admission')));
  } finally { await app.close(); }

});
