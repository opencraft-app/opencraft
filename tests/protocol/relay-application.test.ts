import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { parseRelayConfiguration, startRelayApplication, type RelayComposition } from '../../apps/relay-server/src/application';
import { AssertionProvider } from '../../packages/identity-core/src/node';
import { connectRelay } from '../../plugins/relay-connect/src/server';
import { HubNetwork } from '../../packages/hub-network/src/node';
import { selectionIdentity } from '../../apps/relay-server/src/selection';

const token = () => randomBytes(32).toString('base64url');
function authentication() {
  const pair = generateKeyPairSync('ed25519');
  return { issuer: 'application-fixture', privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    origin: 'http://entry.test', providers: ['fixture'] };
}
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port; await new Promise<void>(r => server.close(() => r())); return port;
}
async function config() {
  return { schemaVersion: 1 as const, host: '127.0.0.1' as const, port: await freePort(), authentication: authentication(),
    routes: [{ instanceId: 'team', origin: 'http://team.test', credential: token() }] };
}
function get(port: number, path = '/', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, agent: false, headers: { host: 'team.test', ...headers } }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    }); req.once('error', reject); req.end();
  });
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Fixture tunnel timeout'); await new Promise(r => setTimeout(r, 10)); }
}

test('configured gateway without an adapter and private/partial input fail before listening', async () => {
  const input = await config();
  await assert.rejects(startRelayApplication(input), /requires a server identity adapter/);
  await assert.rejects(get(input.port));
  for (const bad of [{ ...input, tencentOaTokenFile: '/private/token' }, { ...input, authentication: {} },
    { ...input, authentication: { ...input.authentication, providers: [] } }, { ...input, tlsCertFile: '/cert' },
    { ...input, authentication: undefined }, { ...input, tlsTermination: 'anything' },
    { ...input, routes: [{ ...input.routes[0], credential: 'short' }] },
    { ...input, serverSelectionDefaultsFile: '/private/defaults.json' },
    { ...input, serverSelection: true, serverSelectionDefaultsFile: './defaults.json' }]) assert.throws(() => parseRelayConfiguration(bad));
});

test('trusted provider preserves target-scoped assertions and rejects undeclared identity sources', async t => {
  const input = await config(), principal = { provider: 'fixture', subject: 'person', displayName: 'Person', expiresAt: Date.now() + 60_000 };
  let closed = 0, active = true;
  const composition: RelayComposition = { createIdentity: async () => ({
    provider: { authenticate: req => req.headers['x-fixture'] === 'yes' && active ? principal : null }, close: () => { closed++; },
  }), build: { sourceRevision: 'a'.repeat(40), buildId: 'fixture-build' } };
  const app = await startRelayApplication(input, composition); t.after(() => app.close());
  assert.equal((await get(input.port)).status, 401);
  const authority = new AssertionProvider({ issuer: input.authentication.issuer, instanceId: 'team', origin: 'http://team.test' },
    generatePublicKey(input.authentication.privateKey));
  const backend = createServer((req, res) => { const p = authority.authenticate(req); res.writeHead(p ? 200 : 401); res.end(p?.subject ?? 'denied'); });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening'); t.after(() => new Promise<void>(r => backend.close(() => r())));
  const client = connectRelay({ relay: `http://127.0.0.1:${input.port}`, credential: input.routes[0]!.credential,
    targetPort: (backend.address() as { port: number }).port, allowLoopbackInsecure: true }); t.after(() => client.close());
  await waitFor(() => client.connected());
  const login = async (accept?: string) => {
    const start = await get(input.port, '/', { accept: 'text/html' }); assert.equal(start.status, 303);
    const target = new URL(start.headers.location!);
    const verified = await get(input.port, target.pathname + target.search, { host: target.host, 'x-fixture': 'yes' });
    if (verified.status !== 303) return verified;
    const callback = new URL(verified.headers.location!);
    const session = await get(input.port, callback.pathname + callback.search, { cookie: start.headers['set-cookie']![0]!.split(';')[0]! });
    assert.equal(session.status, 303);
    const cookie = session.headers['set-cookie']!.find(c => c.startsWith('opencraft-relay-session='))!.split(';')[0]!;
    return get(input.port, '/', { cookie, ...(accept ? { accept } : {}) });
  };
  const admitted = await login(); assert.equal(admitted.status, 200); assert.equal(admitted.body, 'person');
  principal.provider = 'undeclared'; assert.equal((await login()).status, 401);
  principal.provider = 'fixture'; active = false; assert.equal((await login()).status, 401);
  const health = await get(input.port, '/__opencraft_relay/health');
  assert.equal(JSON.parse(health.body).buildId, 'fixture-build');
  const first = app.close(); assert.equal(first, app.close()); await first; assert.equal(closed, 1);
  const directory = await mkdtemp(join(tmpdir(), 'relay-defaults-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const defaultsFile = join(directory, 'defaults.json');
  await writeFile(defaultsFile, JSON.stringify({ schemaVersion: 1, defaults: { [selectionIdentity(principal)]: 'team' } }), { mode: 0o600 });
  const selected = { ...input, authentication: { ...input.authentication, origin: input.routes[0]!.origin }, serverSelection: true, serverSelectionDefaultsFile: defaultsFile };
  active = true;
  const selector = await startRelayApplication(selected, composition); t.after(() => selector.close());
  const page = await login('text/html'); assert.equal(page.status, 200); assert.match(page.body, /initial="team"/u);
  // The hint is loaded by the generic application, but this target's non-membership
  // response still prevents its appearance. A navigation hint grants no access.
  assert.doesNotMatch(page.body, /data-server="team"/u);
  await selector.close();
  await writeFile(defaultsFile, JSON.stringify({ schemaVersion: 2, defaults: {} }));
  await assert.rejects(startRelayApplication(selected, composition), /Invalid selection defaults/);
  await assert.rejects(get(input.port));
});

function generatePublicKey(privateKey: string) {
  return createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString();
}

test('listen failure retires identity and releases the Hub state lock', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-rollback-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const input = await config(), file = join(dir, 'operator.json'), state = join(dir, 'hub.json');
  await writeFile(file, JSON.stringify({ credential: token() }), { mode: 0o600 });
  const occupied = createServer(); occupied.listen(input.port, '127.0.0.1'); await once(occupied, 'listening');
  t.after(() => new Promise<void>(r => occupied.close(() => r())));
  let closed = 0;
  await assert.rejects(startRelayApplication({ ...input, hubNetwork: { stateFile: state, operatorCredentialFile: file } }, {
    createIdentity: async () => ({ provider: { authenticate: () => null }, close: () => { closed++; } }),
  }), { code: 'EADDRINUSE' });
  assert.equal(closed, 1);
  const reopened = new HubNetwork(state); reopened.close();
});

test('certificate failure after resource acquisition rolls back every owner even if identity close fails', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-cert-rollback-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const input = await config(), file = join(dir, 'operator.json'), state = join(dir, 'hub.json');
  await writeFile(file, JSON.stringify({ credential: token() }), { mode: 0o600 });
  let closed = 0;
  await assert.rejects(startRelayApplication({ ...input, tlsCertFile: join(dir, 'missing.crt'), tlsKeyFile: join(dir, 'missing.key'),
    hubNetwork: { stateFile: state, operatorCredentialFile: file } }, {
    createIdentity: async () => ({ provider: { authenticate: () => null }, close: () => { closed++; throw new Error('Synthetic close failure'); } }),
  }), /startup and rollback failed/);
  assert.equal(closed, 1); const reopened = new HubNetwork(state); reopened.close(); await assert.rejects(get(input.port));
});

test('generic independently bundled application has no enterprise implementation and runs a transit Hub', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-core-bundle-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const bundle = join(dir, 'application.mjs');
  const result = await build({ entryPoints: ['apps/relay-server/src/application.ts'], outfile: bundle, bundle: true, metafile: true,
    platform: 'node', format: 'esm', target: 'node24', banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" } });
  const sourceRoots = ['apps/relay-server/src/', 'packages/', 'node_modules/'];
  assert.deepEqual(Object.keys(result.metafile!.inputs).filter(path => !sourceRoots.some(root => path.startsWith(root))), [],
    'Standalone Relay bundles only its own application, shared packages and dependencies');
  const { startRelayApplication: standalone } = await import(pathToFileURL(bundle).href);
  const operator = join(dir, 'operator.json'); await writeFile(operator, JSON.stringify({ credential: token() }), { mode: 0o600 });
  const port = await freePort();
  const app = await standalone({ schemaVersion: 1, host: '127.0.0.1', port, routes: [], hubNetwork: { stateFile: join(dir, 'hub.json'), operatorCredentialFile: operator } });
  t.after(() => app.close()); assert.equal((await get(port, '/__opencraft_relay/health')).status, 200);
  assert.equal((await get(port)).status, 403); await app.close(); await assert.rejects(get(port));
});
