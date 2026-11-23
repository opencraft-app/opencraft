import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseHeadlessArguments, startHeadlessServer } from '../../apps/headless-server/src/headless-server.mjs';
import { createWorkbenchWebServer } from '../../apps/headless-server/src/serve-workbench-web.mjs';
import { buildHeadlessBundle } from '../../scripts/packaging/package-headless-linux.mjs';
import { loadLocalMachineAccess } from '../../apps/headless-server/src/local-machine-access.mjs';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { generateKeyPairSync } from 'node:crypto';
import { publishEnvironmentIssuer } from '@opencraft/execution-environment/environment-launch-owner';
import { deploymentPaths } from '../../scripts/container-deployment/paths.mjs';
import { executionHostIssuer } from '../../scripts/container-deployment/execution-hosts.mjs';

async function fixture(t) {
  const runtime = fileURLToPath(new URL('../../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, 'headless-composition-'));
  // node:test runs t.after hooks in registration order and skips the rest once one
  // throws. Resources a test starts must therefore be closed (newest first, each
  // awaited even if another fails) before the shared root is removed; otherwise rm
  // races the still-running server's lazily opened remote-browser store and a
  // failing rm leaves the server alive so the file never exits.
  const cleanups = [];
  t.after(async () => {
    const errors = [];
    for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch (error) { errors.push(error); } }
    try { await rm(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'fixture cleanup failed');
  });
  const own = cleanup => { cleanups.push(cleanup); };
  const webRoot = join(root, 'web'); await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Public workbench</title>');
  await writeFile(join(webRoot, 'version.json'), JSON.stringify({ schemaVersion: 1, buildId: 'composition-test', headlessServer: true, headlessHostId: 'opencraft-server' }));
  let starts = 0;
  const options = { root, webRoot, dataDirectory: join(root, 'data'), port: 0,
    startAgentHost: async () => { starts++; return { websocketUrl: 'ws://127.0.0.1:9/rpc', close: async () => {} }; } };
  return { root, options, own, starts: () => starts };
}

test('public Headless artifact has no enterprise implementation and its CLI rejects private configuration', async t => {
  const f = await fixture(t), bundle = join(f.root, 'server.mjs');
  const result = await buildHeadlessBundle(bundle);
  const workerPath = join(f.root, 'connected-agent-history-worker.mjs');
  assert.equal((await stat(workerPath)).isFile(), true, 'the packaged Host ships its native history worker');
  assert.ok(!(await readFile(workerPath, 'utf8')).includes('tsx/esm/api'), 'the packaged worker must not require a TypeScript loader');
  const worker = new Worker(workerPath, { workerData: { provider: 'codex', home: join(f.root, 'native-home') } });
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('native history worker did not start')), 5_000);
    worker.once('message', message => { clearTimeout(timer); resolve(message); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.postMessage({ id: 1, nativeId: '11111111-2222-3333-4444-555555555555', params: {}, kind: 'turns' });
  });
  await worker.terminate();
  assert.deepEqual(reply, { id: 1, error: 'Could not read the saved agent conversation' });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.length > 100, 'inspect the real transitive graph');
  assert.deepEqual(inputs.filter(path => path.includes('/enterprise-identity/') || path.includes('products/join/')), []);
  const source = await readFile(bundle, 'utf8');
  assert.ok(!source.includes('TencentOaServerPlugin'));
  const run = promisify(execFile);
  // Run packaged JavaScript like the installed CLI, not through source-test
  // TypeScript hooks. Keep the original deadlines and all behavior assertions.
  const artifactEnvironment = { ...process.env };
  delete artifactEnvironment.NODE_OPTIONS;
  const help = await run(process.execPath, [bundle, '--help'], { timeout: 10_000, env: artifactEnvironment });
  assert.match(help.stdout, /human-auth-config/); assert.ok(!help.stdout.includes('enterprise-identity'));
  await assert.rejects(run(process.execPath, [bundle, '--enterprise-identity-token-file', '/not-loaded'], { timeout: 10_000, env: artifactEnvironment }), /Unknown option/);
  const api = await import(pathToFileURL(bundle).href);
  const browserWorker = join(f.root, 'browser-state-worker.mjs');
  assert.equal((await stat(browserWorker)).isFile(), true);
  assert.ok(!(await readFile(browserWorker, 'utf8')).includes('tsx/esm/api'));
  const app = await api.startHeadlessServer({ ...f.options, createWebServer: async input => {
    await input.remoteBrowserService.load();
    return createWorkbenchWebServer(input);
  } }); f.own(() => app.close());
  const health = await fetch(app.url + '/__opencraft_health').then(response => response.json());
  const storage = health.storage.find(row => row.name === 'remote-browser');
  assert.equal(storage.appliedVersion, 4);
  assert.equal(storage.movedAside, false);
  assert.equal((await fetch(app.url)).status, 200);
  assert.equal((await fetch(app.url + '/__opencraft_actors/me')).status, 401);
  // Reopen the packaged application with its real default Human composition.
  // No source loader or injected storage factory may supply the execution Worker.
  await app.close();
  const proof = randomBytes(32).toString('base64url');
  const proofPath = join(f.root, 'packaged-setup-token'), configPath = join(f.root, 'packaged-human-auth.json');
  await writeFile(proofPath, JSON.stringify({ token: proof }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ origin: app.url, local: true, oidc: [], setupTokenFile: proofPath }), { mode: 0o600 });
  const human = await api.startHeadlessServer({ ...f.options, port: Number(new URL(app.url).port), humanAuthConfig: configPath });
  f.own(() => human.close());
  assert.equal((await stat(join(f.root, 'assets-runtime-worker.mjs'))).isFile(), true);
  const setup = await fetch(human.url + '/__opencraft_account/setup', { method: 'POST',
    headers: { origin: human.url, 'content-type': 'application/json' },
    body: JSON.stringify({ proof, mode: 'web', username: 'owner', password: 'Synthetic-packaged-password-42' }) });
  assert.equal(setup.status, 200, await setup.text());
  const cookie = setup.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const status = await fetch(human.url + '/__opencraft_account/status', { headers: { cookie } }).then(r => r.json());
  assert.match(status.actor.id, /^human:\/\//);
  const git = await fetch(human.url + '/__opencraft_assets/git-connections', { headers: { cookie, 'x-opencraft-account-scope': 'actor:' + status.actor.id } });
  assert.equal(git.status, 200, await git.clone().text());
  assert.deepEqual(Object.keys((await git.json()).hosts), ['github.com']);
  assert.equal((await fetch(human.url + '/__opencraft_assets/executionGitGrant', { method: 'POST',
    headers: { cookie, origin: human.url, 'content-type': 'application/json' }, body: '{}' })).status, 404);
});

test('verified external human identity does not require an enterprise provider name or numeric identifier', async t => {
  const f = await fixture(t);
  let current = true;
  const principal = { provider: 'fixture-directory', subject: 'opaque-human-id', displayName: 'Fixture Human', expiresAt: Date.now() + 60_000 };
  const app = await startHeadlessServer({ ...f.options, accessMemberProviders: [principal.provider] }, {
    createIdentity: async () => ({ providers: [{ authenticate: request => current && request.headers['x-fixture-proof'] === 'verified' ? principal : null }], close() {} }),
  }); f.own(() => app.close());
  const headers = { 'x-fixture-proof': 'verified' };
  const connectorOwner = await (await fetch(app.url + '/__opencraft_connectors')).json();
  assert.deepEqual(Object.keys(connectorOwner.hosts).sort(), ['local-codex', 'opencraft-server']);
  const connectorState = await fetch(app.url + '/__opencraft_connectors', {method:'POST',
    headers:{...headers,origin:app.url,'content-type':'application/json'},body:JSON.stringify({hostId:'local-codex',method:'state',params:{}})});
  assert.equal(connectorState.status,200);assert.deepEqual((await connectorState.json()).instances,[]);

  assert.equal((await fetch(app.url)).status, 401);
  const response = await fetch(app.url + '/__opencraft_actors/me', { headers });
  assert.equal(response.status, 200); const first = await response.json(); assert.equal(first.actor.kind, 'human');
  // Exercise the actual assembly: conversation menus use the public Host,
  // which must match the IM list/link and source-query boundary.
  const im = await fetch(app.url + '/__opencraft_im', {method:'POST',
    headers:{...headers,origin:app.url,'content-type':'application/json'},body:JSON.stringify({action:'list'})});
  assert.equal(im.status,200);assert.equal((await im.json()).workbenchHostId,'local-codex');
  const foreignSources = await fetch(app.url + '/__opencraft_im', {method:'POST',
    headers:{...headers,origin:app.url,'content-type':'application/json'},body:JSON.stringify({action:'sources',hostId:'other-host',threadId:'thread'})});
  assert.equal(foreignSources.status,400);assert.equal((await foreignSources.json()).error,'unsupported_host');
  current = false;
  assert.equal((await fetch(app.url + '/__opencraft_actors/me', { headers })).status, 401);
  assert.equal((await fetch(app.url, { headers })).status, 401);
});

test('missing or malformed identity fails before execution and rollback releases the data lock', async t => {
  const f = await fixture(t);
  await assert.rejects(startHeadlessServer({ ...f.options, accessMemberProviders: ['fixture'] }), /identity provider/);
  let closed = 0;
  await assert.rejects(startHeadlessServer(f.options, { createIdentity: async () => ({ providers: [{}], close() { closed++; } }) }), /identity adapter/);
  assert.equal(closed, 1); assert.equal(f.starts(), 0);
  const app = await startHeadlessServer(f.options); f.own(() => app.close());
  assert.equal((await fetch(app.url)).status, 200);
});

test('core ENV delivery has one owner and fails at startup without execution admission', async t => {
  const f = await fixture(t);
  await assert.rejects(startHeadlessServer({ ...f.options, environmentDelivery: 'synchronous' }), /Invalid environment delivery/);
  let closed = 0;
  await assert.rejects(startHeadlessServer({ ...f.options, environmentDelivery: 'vault-owner' },
    { createIdentity: async () => ({ providers: [], executionEnvironment: { close() {} }, close() { closed++; } }) }), /two owners/);
  assert.equal(closed, 1);
  // The vault Worker starts its issuer, but no Human execution admission exists.
  await assert.rejects(startHeadlessServer({ ...f.options, environmentDelivery: 'vault-owner' }), /requires execution admission/);
  // Pi inside Main cannot host a receiver; it is refused instead of running without ENV.
  for (const engines of [['pi'], ['dsh', 'pi']])
    await assert.rejects(startHeadlessServer({ ...f.options, engines, defaultEngine: engines[0], environmentDelivery: 'vault-owner' }),
      /independent Pi engine host/);
  // Independent engine hosts pin the issuer only from the published key; a
  // Gateway that would not publish it is refused before the vault owner starts.
  await assert.rejects(startHeadlessServer({ ...f.options, engines: ['dsh', 'pi'], defaultEngine: 'dsh', environmentDelivery: 'vault-owner',
    engineHostDescriptor: join(f.root, 'engine-host.json') }), /requires a published issuer/);
  await assert.rejects(startHeadlessServer({ ...f.options, environmentIssuer: { publish: join(f.root, 'issuer.json') } }), /requires environment delivery/);
  assert.equal(f.starts(), 0);
  // Deployment configuration: unset changes nothing; set values are validated.
  const parse = env => parseHeadlessArguments(['--data-dir', f.options.dataDirectory], env);
  for (const key of ['environmentDelivery', 'environmentIssuer']) assert.ok(!(key in parse({})));
  assert.deepEqual(parse({ OPENCRAFT_ENVIRONMENT_DELIVERY: '' }).environmentDelivery, undefined);
  const configured = parse({ OPENCRAFT_ENVIRONMENT_DELIVERY: 'vault-owner', OPENCRAFT_ENVIRONMENT_ISSUER_FILE: '/run/issuer.json',
    OPENCRAFT_ENVIRONMENT_ISSUER_GENERATION: '2026-11' });
  // The earlier spelling stays accepted with the same meaning.
  assert.equal(configured.environmentDelivery, 'opaque');
  assert.deepEqual(configured.environmentIssuer, { publish: '/run/issuer.json', generation: '2026-11' });
  assert.equal(parse({ OPENCRAFT_ENVIRONMENT_DELIVERY: 'opaque' }).environmentDelivery, 'opaque');
  for (const env of [{ OPENCRAFT_ENVIRONMENT_DELIVERY: 'sync' }, { OPENCRAFT_ENVIRONMENT_ISSUER_FILE: '/run/issuer.json' },
    { OPENCRAFT_ENVIRONMENT_DELIVERY: 'vault-owner', OPENCRAFT_ENVIRONMENT_ISSUER_FILE: 'relative.json' },
    { OPENCRAFT_ENVIRONMENT_DELIVERY: 'vault-owner', OPENCRAFT_ENVIRONMENT_ISSUER_GENERATION: 'a b' }])
    assert.throws(() => parse(env), JSON.stringify(env));
  const app = await startHeadlessServer(f.options); f.own(() => app.close());
  assert.equal((await fetch(app.url)).status, 200);
});

test('an identity-owned vault port brings its own admission and metadata; missing parts fail at startup', async t => {
  const f = await fixture(t);
  const principal = { provider: 'fixture-directory', subject: 'opaque-human-id', displayName: 'Fixture Human', expiresAt: Date.now() + 60_000 };
  const calls = [];
  const metadata = Object.fromEntries(['admit', 'project', 'bind', 'bindCreator', 'rememberProjects']
    .map(method => [method, async () => { calls.push(method); return null; }]));
  const port = { issuer: 'a'.repeat(43), seal: async () => { throw Error('not sealed in this test'); } };
  let closed = 0;
  const identity = environmentLaunch => async () => ({ assistantEnvironmentConfigurationManaged: true,
    providers: [{ authenticate: () => principal }], environmentLaunch, close() { closed++; } });
  const options = { ...f.options, accessMemberProviders: [principal.provider] };
  // An admission without its metadata port would lose new Threads' Project ENV.
  await assert.rejects(startHeadlessServer(options, { createIdentity: identity({ ...port, admission: async () => null }) }),
    /identity adapter/);
  // Core does not own this vault's admission: a port without one has no handoff.
  await assert.rejects(startHeadlessServer(options, { createIdentity: identity({ ...port, metadata }) }),
    /requires execution admission/);
  // Live Actor checks need Human instance authority.
  await assert.rejects(startHeadlessServer(f.options, { createIdentity: identity({ ...port, admission: async () => null, metadata }) }),
    /Human instance authority/);
  // Never beside the synchronous runtime.
  await assert.rejects(startHeadlessServer(options, { createIdentity: async () => ({ ...(await identity({ ...port, admission: async () => null, metadata })()),
    executionEnvironment: { close() {} } }) }), /identity adapter/);
  // Where core owns the Actor/lease handoff, a second admission source is refused.
  const humanAuthConfig = join(f.root, 'human-auth.json');
  await writeFile(humanAuthConfig, JSON.stringify({ origin: 'http://127.0.0.1', local: true, oidc: [] }), { mode: 0o600 });
  await assert.rejects(startHeadlessServer({ ...f.options, humanAuthConfig, accessControl: true },
    { createIdentity: async () => ({ ...(await identity({ ...port, admission: async () => null, metadata })()),
      assistantEnvironmentConfigurationManaged: false }) }), /admission cannot have two owners/);
  assert.equal(closed, 5);
  assert.equal(f.starts(), 0);
  const app = await startHeadlessServer(options, { createIdentity: identity({ ...port, admission: async () => null, metadata }) });
  f.own(() => app.close());
  assert.equal((await fetch(app.url + '/__opencraft_actors/me')).status, 200);
  assert.deepEqual(calls, [], 'no metadata is written before a Host request');
});

test('with ENV delivery an identity-owned vault is the only owner, publishes the issuer Brain pins, and never runs beside core', async t => {
  const f = await fixture(t);
  const principal = { provider: 'fixture-directory', subject: 'opaque-human-id', displayName: 'Fixture Human', expiresAt: Date.now() + 60_000 };
  const metadata = Object.fromEntries(['admit', 'project', 'bind', 'bindCreator', 'rememberProjects'].map(method => [method, async () => null]));
  const x25519 = () => generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const issuer = x25519();
  const port = { issuer, seal: async () => { throw Error('not sealed in this test'); }, admission: async () => null, metadata };
  const env = { OPENCRAFT_DATA_DIR: f.options.dataDirectory, OPENCRAFT_WORKSPACE_DIR: join(f.root, 'work') };
  const paths = deploymentPaths({ ...env, OPENCRAFT_ENVIRONMENT_DELIVERY: 'opaque' });
  const contexts = [];
  let closed = 0;
  // The composition publishes like its vault Worker does (createAssetsStorage's
  // environmentIssuer.publish), at the path and generation core hands it.
  const identity = (launch, publishKey = launch?.issuer) => async context => {
    contexts.push(context.environmentIssuer);
    if (publishKey && context.environmentIssuer?.publish) await publishEnvironmentIssuer(context.environmentIssuer.publish, publishKey);
    return { assistantEnvironmentConfigurationManaged: true, providers: [{ authenticate: () => principal }],
      environmentLaunch: launch, close() { closed++; } };
  };
  const options = { ...f.options, accessMemberProviders: [principal.provider], environmentDelivery: 'opaque',
    environmentIssuer: { publish: paths.environmentIssuerFile, generation: '2026-11' } };
  // Never two owners: the synchronous runtime beside delivery, or beside the port.
  await assert.rejects(startHeadlessServer(options, { createIdentity: async () => ({ providers: [], executionEnvironment: { close() {} },
    close() { closed++; } }) }), /two owners/);
  await assert.rejects(startHeadlessServer(options, { createIdentity: async () => ({ ...(await identity(port)({})),
    executionEnvironment: { close() {} } }) }), /identity adapter/);
  // An independent engine host needs the publication before any owner starts.
  contexts.length = 0;
  await assert.rejects(startHeadlessServer({ ...options, environmentIssuer: undefined, engines: ['dsh', 'pi'], defaultEngine: 'dsh',
    engineHostDescriptor: join(f.root, 'engine-host.json') }, { createIdentity: identity(port) }), /requires a published issuer/);
  assert.deepEqual(contexts, []);
  // A publication that is missing or names another key is refused: no silent fallback.
  await assert.rejects(startHeadlessServer(options, { createIdentity: identity(port, null) }), /identity vault owner to publish its issuer/);
  await assert.rejects(startHeadlessServer(options, { createIdentity: identity(port, x25519()) }), /identity vault owner to publish its issuer/);
  assert.equal(closed, 4);
  assert.equal(f.starts(), 0);
  // Delivery on with the port: the port is the only owner, core opens no vault Worker.
  const app = await startHeadlessServer(options, { createIdentity: identity(port) });
  f.own(() => app.close());
  assert.equal((await fetch(app.url + '/__opencraft_actors/me')).status, 200);
  assert.deepEqual(contexts.at(-1), { publish: paths.environmentIssuerFile, generation: '2026-11' });
  assert.ok(Object.isFrozen(contexts.at(-1)));
  await assert.rejects(stat(join(f.options.dataDirectory, 'employee-git-vault.sqlite')), { code: 'ENOENT' }, 'core opens no vault Worker');
  // Brain pins exactly the key the identity owner published.
  assert.equal(await executionHostIssuer(paths, () => {}), issuer);
});

test('an identity vault port wires Codex ENV and Git delivery or startup fails closed', async t => {
  const f = await fixture(t);
  const principal = { provider: 'fixture-directory', subject: 'opaque-human-id', displayName: 'Fixture Human', expiresAt: Date.now() + 60_000 };
  const metadata = Object.fromEntries(['admit', 'project', 'bind', 'bindCreator', 'rememberProjects'].map(method => [method, async () => null]));
  const port = { issuer: 'a'.repeat(43), seal: async () => { throw Error('not sealed in this test'); }, admission: async () => null, metadata };
  const calls = [];
  const codex = {
    launch: async () => { calls.push('launch'); return { context: null }; },
    admitCreation: async () => { calls.push('admitCreation'); throw Error('not admitted in this test'); },
  };
  const git = { hosts: ['github.com'], authority: 'b'.repeat(64),
    grant: async () => { calls.push('grant'); return null; }, reservation: async () => { calls.push('reservation'); return null; } };
  let closed = 0;
  const identity = environmentLaunch => async () => ({ assistantEnvironmentConfigurationManaged: true,
    providers: [{ authenticate: () => principal }], environmentLaunch, close() { closed++; } });
  const options = { ...f.options, accessMemberProviders: [principal.provider] };
  const split = { ...options, codexCoreEndpoint: join(f.root, 'nonexistent-core.sock'), codexCoreAuthToken: 'synthetic-token' };
  // Malformed parts are refused before anything starts.
  for (const malformed of [{ launch: codex.launch }, { admitCreation: codex.admitCreation }, { ...codex, launch: 'launch' },
    { git: { ...git, authority: 'not-hex' } }, { git: { ...git, hosts: [] } }, { git: { ...git, hosts: ['github.com', 'github.com'] } },
    { git: { ...git, hosts: ['HTTPS://github.com'] } }, { git: { ...git, grant: undefined } }, { git: { ...git, reservation: null } }, { git: null }])
    await assert.rejects(startHeadlessServer(split, { createIdentity: identity({ ...port, ...malformed }) }), /identity adapter/);
  // With a split Codex Core, a missing record reader or Git owner fails closed
  // instead of running human Codex Turns without personal ENV or Git.
  for (const partial of [{}, { ...codex }, { git }])
    await assert.rejects(startHeadlessServer(split, { createIdentity: identity({ ...port, ...partial }) }),
      /Codex environment delivery requires launch, creation admission and a personal Git owner/);
  // The Git owner's live Actor checks need Human instance authority.
  await assert.rejects(startHeadlessServer({ ...split, accessMemberProviders: undefined },
    { createIdentity: identity({ ...port, ...codex, git }) }), /Human instance authority/);
  // Where core's assets vault owns personal Git, a second Git owner is refused.
  const humanAuthConfig = join(f.root, 'human-auth.json');
  await writeFile(humanAuthConfig, JSON.stringify({ origin: 'http://127.0.0.1', local: true, oidc: [] }), { mode: 0o600 });
  await assert.rejects(startHeadlessServer({ ...f.options, humanAuthConfig, accessControl: true },
    { createIdentity: async () => ({ ...(await identity({ issuer: port.issuer, seal: port.seal, git })()),
      assistantEnvironmentConfigurationManaged: false }) }), /Personal Git execution cannot have two owners/);
  assert.equal(closed, 15);
  assert.equal(f.starts(), 0);
  // Without a split Core, a port without them is unchanged (covered above); a
  // complete port starts and nothing is sealed or granted before a request.
  const dataDirectory = join(f.root, 'identity-vault-data');
  const app = await startHeadlessServer({ ...split, dataDirectory }, { createIdentity: identity({ ...port, ...codex, git }) });
  f.own(() => app.close());
  assert.equal((await fetch(app.url + '/__opencraft_actors/me')).status, 200);
  assert.deepEqual(calls, []);
  await assert.rejects(stat(join(dataDirectory, 'employee-git-vault.sqlite')), { code: 'ENOENT' },
    'Main opens no vault for an identity-owned vault');
});

test('public listener accepts explicit membership protection without requiring an anonymous-access acknowledgement', async t => {
  const f = await fixture(t);
  await assert.rejects(startHeadlessServer({ ...f.options, host: '0.0.0.0' }), /unauthenticated-public/);
  assert.equal(f.starts(), 0);
  const app = await startHeadlessServer({ ...f.options, host: '0.0.0.0', accessControl: true }); f.own(() => app.close());
  assert.equal((await fetch(app.url)).status, 401, 'no identity provider or member cannot downgrade to anonymous admission');
  assert.equal((await fetch(app.url + '/__opencraft_actors/me')).status, 401);
});

test('local machine ingress proves the socket source and preserves remote and Actor admission', { timeout: 20_000 }, async t => {
  const f = await fixture(t), path = join(f.root, 'local-access');
  await writeFile(path, randomBytes(32).toString('hex'), { mode: 0o600 });
  const access = await loadLocalMachineAccess(path);
  const request = (host = '127.0.0.1:80', peer = '127.0.0.1', target = '127.0.0.1', extra = {}) => ({
    method: 'GET', url: '/', headers: { host, ...extra }, socket: { remoteAddress: peer, localAddress: target, localPort: 80 },
  });
  const good = request(); assert.equal(access.forward(good), true);
  assert.equal(access.origin(good), 'http://127.0.0.1');
  for (const rejected of [request('127.0.0.1:80', '198.51.100.2'), request('evil.test'),
    request('127.0.0.1:81'), request('127.0.0.1:80', '127.0.0.1', '127.0.0.1', { origin: 'https://evil.test' }),
    request('127.0.0.1:80', '127.0.0.1', '127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }),
    request('127.0.0.1:80', '127.0.0.1', '127.0.0.1', { 'sec-fetch-site': 'cross-site' })]) {
    rejected.headers['x-opencraft-local-machine-proof'] = good.headers['x-opencraft-local-machine-proof'];
    assert.equal(access.forward(rejected), false); assert.equal(rejected.headers['x-opencraft-local-machine-proof'], undefined);
  }
  const address = Object.values(networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal)?.address;
  if (address) { const ip = request(address, address, address); assert.equal(access.forward(ip), true);
    ip.socket.remoteAddress = '127.0.0.1'; assert.equal(access.origin(ip), 'http://' + address); }
  assert.equal(access.origin({ ...good, url: '/different' }), null);
  assert.equal(access.origin({ ...good, socket: { remoteAddress: '198.51.100.2' } }), null);
  await writeFile(path, randomBytes(32).toString('hex'), { mode: 0o600 });
  assert.equal((await loadLocalMachineAccess(path)).origin(good), null, 'a replacement key retires old proofs');

  const backend = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(backend, 'listening');
  f.own(() => new Promise(resolve => backend.close(resolve)));
  backend.on('connection', socket => socket.on('message', data => {
    const request = JSON.parse(data.toString());
    socket.send(JSON.stringify({ id: request.id, result: 'local-proof-echo' }));
  }));
  const app = await startHeadlessServer({ ...f.options, localAccessFile: path, accessControl: true,
    startAgentHost: async () => ({ websocketUrl: 'ws://127.0.0.1:' + backend.address().port, close: async () => {} }),
  }); f.own(() => app.close());
  const current = await loadLocalMachineAccess(path);
  const proofFor = (url, method = 'GET') => { const parsed = new URL(app.url), req = { method, url, headers: { host: parsed.host },
    socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1', localPort: Number(parsed.port) } };
    assert.equal(current.forward(req), true); return req.headers; };
  assert.equal((await fetch(app.url)).status, 401);
  assert.equal((await fetch(app.url, { headers: proofFor('/') })).status, 200);
  assert.equal((await fetch(app.url + '/__opencraft_actors/me', { headers: proofFor('/__opencraft_actors/me') })).status, 401, 'anonymous workspace is not a human Actor');
  const probe = proofFor('/assets/lazy.js');
  assert.equal((await fetch(app.url + '/__opencraft_access/admission', { headers: { ...probe, 'x-opencraft-relay-probe-method': 'GET', 'x-opencraft-relay-probe-path': '/assets/lazy.js' } })).status, 204);
  assert.equal((await fetch(app.url + '/__opencraft_access/admission', { headers: { ...probe, 'x-opencraft-relay-probe-method': 'POST', 'x-opencraft-relay-probe-path': '/assets/lazy.js' } })).status, 401);
  const socket = new WebSocket(app.url.replace('http:', 'ws:') + '/appserver', { headers: { ...proofFor('/appserver'), origin: app.url } });
  await once(socket, 'open');
  const reply = once(socket, 'message', { signal: AbortSignal.timeout(5_000) });
  socket.send(JSON.stringify({ id: 1, method: 'fixture/echo', params: {} }));
  assert.deepEqual(JSON.parse((await reply)[0].toString()), { id: 1, result: 'local-proof-echo' });
  socket.close(); await once(socket, 'close');
});

test('a disposal failure settles other resources but retains the writer until process exit', async t => {
  const f = await fixture(t); let closes = 0;
  const app = await startHeadlessServer(f.options, { createIdentity: async () => ({ providers: [], close() { closes++; throw new Error('fixture disposal failure'); } }) });
  const first = app.close(), second = app.close(); assert.equal(first, second);
  await assert.rejects(first, AggregateError); assert.equal(closes, 1);
  await assert.rejects(startHeadlessServer(f.options), { code: 'ELOCKED' });
});

test('anonymous handoff is selected by deployment configuration on both real RPC ingress paths', async t => {
  for (const identityConfigured of [false,true]) {
    await t.test(identityConfigured ? 'identity adapter with anonymous request' : 'anonymous installation', async t => {
      const f = await fixture(t), sourceId='pi_source';
      const backend = new WebSocketServer({host:'127.0.0.1',port:0});await once(backend,'listening');
      backend.on('connection',socket=>socket.on('message',raw=>{
        const message = JSON.parse(String(raw));
        socket.send(JSON.stringify({id:message.id,...(message.__opencraftClient===undefined?{}:{__opencraftClient:message.__opencraftClient}),result:message.method==='initialize'?{capabilities:{}}:{thread:{id:message.method==='thread/read'?message.params.threadId:'target',cwd:f.root,status:{type:'idle'}}}}));
      }));
      const app = await startHeadlessServer({...f.options,
        startAgentHost:async()=>({websocketUrl:`ws://127.0.0.1:${backend.address().port}`,close:async()=>{}}),
      },identityConfigured ? {createIdentity:async()=>({providers:[],close(){}})} : {});
      f.own(()=>new Promise(resolve=>backend.close(resolve)));f.own(()=>app.close());
      assert.equal((await fetch(app.url+'/__opencraft_actors/me')).status,401);
      for (const path of ['/appserver','/apphost']) {
        const socket = new WebSocket(app.url.replace('http:','ws:')+path,{origin:app.url});await once(socket,'open');
        let generation;
        const exchange = async frame => {
          const response = once(socket,'message',{signal:AbortSignal.timeout(5000)});socket.send(JSON.stringify(frame));
          return JSON.parse(String((await response)[0]));
        };
        if(path==='/apphost') {
          await exchange({type:'hello',protocolVersion:2,rendererId:'fixture'});
          generation=(await exchange({type:'host/connect',requestId:'connect',hostId:'opencraft-server',leaseId:'lease'})).result.generation;
        }
        const frames=[];socket.on('message',raw=>frames.push(JSON.parse(String(raw))));
        const rpc = async (id,method,params={}) => {
          const frame={id,method,params};
          socket.send(JSON.stringify(path==='/appserver'?frame:{type:'host/send',requestId:'send-'+id,hostId:'opencraft-server',leaseId:'lease',generation,frame:JSON.stringify(frame)}));
          const until=Date.now()+5000;
          while(Date.now()<until){for(const row of frames){const reply=path==='/appserver'?row:row.type==='host/frame'?JSON.parse(row.frame):{};if(reply.id===id)return reply;}await new Promise(resolve=>setTimeout(resolve,5));}
          throw Error('RPC timed out');
        };
        const initialized=await rpc(1,'initialize');
        assert.equal(initialized.result.capabilities.extensions['opencraft/thread-access'].agentHandoff,!identityConfigured);
        const reference=await rpc(2,'opencraft/collaboration',{action:'reference',threadId:sourceId});
        if(identityConfigured)assert.equal(reference.error.data.code,'actor_authentication_required');
        else assert.match(reference.result.reference,/pi_source$/);
        const metadata=await rpc(4,'opencraft/collaboration',{action:'metadata',reference:identityConfigured?{serverId:'server',threadId:sourceId}:reference.result.ref});
        if(identityConfigured)assert.equal(metadata.error.data.code,'actor_authentication_required');
        else assert.equal(metadata.result?.cwd,f.root,JSON.stringify(metadata));
        const start=await rpc(3,'thread/start',{handoffSource:{threadId:sourceId}});
        if(identityConfigured)assert.equal(start.error.code,-32004);
        else assert.equal(start.result.thread.id,'target');
        socket.close();await once(socket,'close');
      }
    });
  }
});

test('anonymous installation can subsequently initialize its first real administrator', async t => {
  const f = await fixture(t);
  const anonymous = await startHeadlessServer(f.options);await anonymous.close();
  const proof=randomBytes(32).toString('base64url');
  const proofPath=join(f.root,'setup-token'),configPath=join(f.root,'human-auth.json');
  await writeFile(proofPath,JSON.stringify({token:proof}),{mode:0o600});
  await writeFile(configPath,JSON.stringify({origin:anonymous.url,local:true,oidc:[],setupTokenFile:proofPath}),{mode:0o600});
  const app=await startHeadlessServer({...f.options,port:Number(new URL(anonymous.url).port),humanAuthConfig:configPath});f.own(()=>app.close());
  assert.equal((await fetch(app.url+'/setup')).status,200);
  const setup=await fetch(app.url+'/__opencraft_account/setup',{method:'POST',headers:{origin:anonymous.url,'content-type':'application/json'},body:JSON.stringify({proof,mode:'web',username:'owner',password:'Fixture-account-password-42'})});
  assert.equal(setup.status,200,await setup.text());
});


test('an explicitly anonymous native installation declares no personal Git authority rather than failing every shell',async t=>{
 const {RemoteSessionCapabilities}=await import('../../packages/session-capabilities/src/remote.ts');
 const f=await fixture(t);
 const app=await startHeadlessServer({...f.options,engines:['pi'],defaultEngine:'pi'});f.own(()=>app.close());
 const machineId=(await readFile(join(f.options.dataDirectory,'machine-id'),'utf8')).trim();
 const remote=new RemoteSessionCapabilities(f.options.dataDirectory,`server:${machineId}:pi`);
 assert.deepEqual(await remote.hostGit('pi_synthetic',{inputId:'unowned-input'}),{mode:'anonymous'});
});

test('personal model defaults follow the signed-in Actor and instance admission on a real Headless server', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const probe = await startHeadlessServer(f.options); await probe.close();
  const proof = randomBytes(32).toString('base64url');
  const proofPath = join(f.root, 'setup-token'), configPath = join(f.root, 'human-auth.json');
  await writeFile(proofPath, JSON.stringify({ token: proof }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ origin: probe.url, local: true, oidc: [], setupTokenFile: proofPath }), { mode: 0o600 });
  const app = await startHeadlessServer({ ...f.options, port: Number(new URL(probe.url).port), humanAuthConfig: configPath }); f.own(() => app.close());
  const path = app.url + '/__opencraft_model_defaults';
  const json = { origin: app.url, 'content-type': 'application/json' };
  assert.equal((await fetch(path)).status, 401);
  const setup = await fetch(app.url + '/__opencraft_account/setup', { method: 'POST', headers: json,
    body: JSON.stringify({ proof, mode: 'web', username: 'owner', password: 'Fixture-account-password-42' }) });
  assert.equal(setup.status, 200, await setup.text());
  const owner = setup.headers.get('set-cookie')?.split(';')[0];
  const ownerId = (await fetch(app.url + '/__opencraft_account/status', { headers: { cookie: owner } }).then(r => r.json())).actor.id;
  assert.deepEqual(await fetch(path, { headers: { cookie: owner } }).then(r => r.json()), { actorId: ownerId });
  const selection = { model: 'provider/model', effort: 'high' };
  const saved = await fetch(path, { method: 'POST', headers: { ...json, cookie: owner },
    body: JSON.stringify({ hostId: 'opencraft-server', revision: 0, selection, expectedActorId: ownerId }) });
  assert.equal(saved.status, 200, await saved.clone().text());
  const query = new URLSearchParams({ hostId: 'opencraft-server', expectedActorId: ownerId });
  assert.deepEqual(await fetch(path + '?' + query, { headers: { cookie: owner } }).then(r => r.json()), { actorId: ownerId, revision: 1, selection });

  // An invited member reads only their own empty record; revoking membership refuses them.
  const invitation = await fetch(app.url + '/__opencraft_account/invitations', { method: 'POST', headers: { ...json, cookie: owner }, body: '{}' }).then(r => r.json());
  const accepted = await fetch(app.url + '/__opencraft_account/accept', { method: 'POST', headers: json,
    body: JSON.stringify({ code: invitation.code, username: 'member', password: 'Fixture-member-password-42' }) });
  assert.equal(accepted.status, 201, await accepted.clone().text());
  const member = accepted.headers.get('set-cookie')?.split(';')[0];
  const memberId = (await fetch(path, { headers: { cookie: member } }).then(r => r.json())).actorId;
  assert.notEqual(memberId, ownerId);
  assert.equal((await fetch(path + '?' + query, { headers: { cookie: member } })).status, 409);
  assert.deepEqual(await fetch(path + '?' + new URLSearchParams({ hostId: 'opencraft-server', expectedActorId: memberId }), { headers: { cookie: member } }).then(r => r.json()),
    { actorId: memberId, revision: 0, selection: null });
  const revoked = await fetch(app.url + '/__opencraft_account/members', { method: 'POST', headers: { ...json, cookie: owner },
    body: JSON.stringify({ actorId: memberId, role: 'member', enabled: false }) });
  assert.equal(revoked.status, 200, await revoked.clone().text());
  assert.equal((await fetch(path, { headers: { cookie: member } })).status, 403);
});
