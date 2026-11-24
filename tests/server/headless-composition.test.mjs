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
import { networkInterfaces, tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { connect } from 'node:net';
import { Worker } from 'node:worker_threads';
import { generateKeyPairSync } from 'node:crypto';
import { publishEnvironmentIssuer } from '@opencraft/execution-environment/environment-launch-owner';
import { deploymentPaths } from '../../scripts/container-deployment/paths.mjs';
import { executionHostIssuer } from '../../scripts/container-deployment/execution-hosts.mjs';
import { ownedCleanup } from '../support/owned-cleanup.mjs';
import { ActorSshKeys } from '../../apps/headless-server/src/actor-ssh-keys.ts';
import { createHeadlessLifecycle, createLateBinding } from '../../apps/headless-server/src/assembly/lifecycle.mjs';
import { startObserve } from '../../apps/observability-service/service.mjs';
import { fakeOwnerWake, fakeWakeClock } from '../support/fake-wake-clock.ts';

async function fixture(t) {
  const runtime = fileURLToPath(new URL('../../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, 'headless-composition-'));
  // Servers a test starts close before the shared root is removed (tests/support/owned-cleanup.mjs).
  const cleanup = ownedCleanup(t);
  cleanup.last(() => rm(root, { recursive: true, force: true }));
  const own = cleanup.own;
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

test('composition loginAdmission enables the core policy on the Hub admission path', async t => {
  const f = await fixture(t);
  await mkdir(f.options.dataDirectory, { recursive: true });
  // A policy published earlier (e.g. by an administrator before a restart).
  const { LoginAdmissionStore } = await import('../../plugins/login-admission/src/store.ts');
  const store = new LoginAdmissionStore(join(f.options.dataDirectory, 'login-admission.sqlite'));
  store.publish(JSON.stringify(['fixture-directory', 'login']), 0, JSON.stringify({ enabled: true, allowlist: ['alice'], patterns: [], conditions: [], admitFunction: null }), 'fixture', 1, '{}');
  store.close();
  const principal = login => ({ provider: 'fixture-directory', subject: 'id-' + login, displayName: login, expiresAt: Date.now() + 60_000, attributes: { login } });
  const createIdentity = async () => ({ providers: [{ authenticate: request => request.headers['x-fixture-login'] ? principal(request.headers['x-fixture-login']) : null }], close() {} });
  await assert.rejects(startHeadlessServer({ ...f.options, accessMemberProviders: ['fixture-directory'] }, { createIdentity, loginAdmission: { provider: 'fixture-directory' } }), /login admission/);
  await assert.rejects(startHeadlessServer({ ...f.options, accessMemberProviders: ['fixture-directory'] }, {
    createIdentity: async () => ({ ...(await createIdentity()), admissionPolicy: { prepare: async () => {}, allows: () => true, allowsBinding: () => true } }),
    loginAdmission: { provider: 'fixture-directory', attribute: 'login' } }), /two owners/);
  const app = await startHeadlessServer({ ...f.options, accessMemberProviders: ['fixture-directory'] },
    { createIdentity, loginAdmission: { provider: 'fixture-directory', attribute: 'login' } }); f.own(() => app.close());
  assert.equal((await fetch(app.url + '/__opencraft_actors/me', { headers: { 'x-fixture-login': 'alice' } })).status, 200);
  assert.equal((await fetch(app.url, { headers: { 'x-fixture-login': 'alice' } })).status, 200);
  assert.equal((await fetch(app.url, { headers: { 'x-fixture-login': 'Mallory' } })).status, 403, 'a verified login outside the policy is refused');
  assert.equal((await fetch(app.url + '/__opencraft_actors/me', { headers: { 'x-fixture-login': 'Mallory' } })).status, 401);
  const administration = await fetch(app.url + '/__opencraft_access/login-admission', { headers: { 'x-fixture-login': 'alice' } });
  assert.deepEqual([administration.status, (await administration.json()).error], [403, 'administrator_required']);
  const health = await fetch(app.url + '/__opencraft_health').then(response => response.json());
  assert.equal(health.storage.find(row => row.name === 'login-admission')?.appliedVersion, 1);
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

test('composition-root ports: closing flips when shutdown starts, late bindings bind once', async () => {
  const lifecycle = createHeadlessLifecycle();
  let runs = 0, seen;
  assert.equal(lifecycle.closing(), false);
  const first = lifecycle.shutdown(async () => { runs++; seen = lifecycle.closing(); });
  assert.equal(lifecycle.closing(), true, 'closing is published before the disposer runs');
  assert.equal(runs, 0);
  assert.equal(lifecycle.shutdown(async () => { runs++; }), first);
  await first;
  assert.deepEqual({ runs, seen }, { runs: 1, seen: true });

  const late = createLateBinding('Fixture port');
  assert.equal(late.current(), undefined);
  assert.throws(() => late.get(), /Fixture port is not available yet/);
  const value = { id: 1 };
  assert.equal(late.bind(value), value);
  assert.equal(late.get(), value);
  assert.equal(late.current(), value);
  assert.throws(() => late.bind({ id: 2 }), /Fixture port is already bound/);
  const absent = createLateBinding('Absent port');
  absent.bind(undefined);
  assert.equal(absent.get(), undefined, 'an intentionally absent service is bound as undefined');
});

test('a throwing personal SSH key disposer is settled and every later close step still runs', async t => {
  const f = await fixture(t);
  // Force the one synchronous disposer to throw on this server only; the prototype is restored before cleanup.
  const close = ActorSshKeys.prototype.close;
  t.after(() => { ActorSshKeys.prototype.close = close; });
  let thrown = 0;
  ActorSshKeys.prototype.close = function () { thrown++; close.call(this); throw new Error('fixture SSH key disposal failure'); };
  let identityCloses = 0, compositionCloses = 0;
  const app = await startHeadlessServer(f.options, {
    createIdentity: async () => ({ providers: [], close() { identityCloses++; } }),
    close() { compositionCloses++; },
  });
  const policyWal = join(f.options.dataDirectory, 'model-usage-policy.sqlite-wal');
  assert.equal((await stat(policyWal)).isFile(), true, 'the open policy writer keeps a WAL');
  // The failure is collected with the others instead of skipping the remaining steps.
  const failure = await app.close().then(() => null, error => error);
  assert.ok(failure instanceof AggregateError, `close rejects with the collected failures, not ${failure}`);
  assert.deepEqual(failure.errors.map(error => error.message), ['fixture SSH key disposal failure']);
  assert.equal(thrown, 1);
  // Steps after the SSH keys ran: writers flushed and the identity and composition closed.
  await assert.rejects(stat(policyWal), { code: 'ENOENT' });
  assert.equal(identityCloses, 1);
  assert.equal(compositionCloses, 1);
  // A rejected flush is not a release receipt: the writer lock stays held until process exit.
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

test('deployment-level periodic owners run on the injected owner wake-up and shutdown disarms all of them', async t => {
  const f = await fixture(t), clock = fakeWakeClock(0), periods = [];
  const wake = fakeOwnerWake(clock);
  const ownerWake = { now: wake.now, timer: callback => { const timer = wake.timer(callback); return { arm(at) { periods.push(at - clock.now); timer.arm(at); }, cancel: () => timer.cancel() }; } };
  const app = await startHeadlessServer({ ...f.options, ownerWake }); f.own(() => app.close());
  // Conversation resource retries (5 s) and resource reconciliation (60 s) are armed; nothing runs on a global interval.
  assert.ok(periods.includes(5_000) && periods.includes(60_000), JSON.stringify(periods));
  assert.ok(clock.pending >= 2);
  clock.elapse(60_000);
  assert.ok(periods.filter(period => period === 60_000).length >= 2, 'reconciliation re-arms one period after it ran');
  await app.close();
  assert.equal(clock.pending, 0, 'closing the deployment leaves no owner wake-up armed');
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

test('thread read receipts follow the signed-in Actor and instance admission on a real Headless server', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const probe = await startHeadlessServer(f.options);
  // Without human logins nobody is signed in; the Web keeps this browser's own read state.
  const anonymous = await fetch(probe.url + '/__opencraft_thread_reads');
  await probe.close();
  assert.equal(anonymous.status, 401);
  const proof = randomBytes(32).toString('base64url');
  const proofPath = join(f.root, 'setup-token'), configPath = join(f.root, 'human-auth.json');
  await writeFile(proofPath, JSON.stringify({ token: proof }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ origin: probe.url, local: true, oidc: [], setupTokenFile: proofPath }), { mode: 0o600 });
  const app = await startHeadlessServer({ ...f.options, port: Number(new URL(probe.url).port), humanAuthConfig: configPath }); f.own(() => app.close());
  const path = app.url + '/__opencraft_thread_reads';
  const json = { origin: app.url, 'content-type': 'application/json' };
  assert.equal((await fetch(path)).status, 401);
  const setup = await fetch(app.url + '/__opencraft_account/setup', { method: 'POST', headers: json,
    body: JSON.stringify({ proof, mode: 'web', username: 'owner', password: 'Fixture-account-password-42' }) });
  assert.equal(setup.status, 200, await setup.text());
  const owner = setup.headers.get('set-cookie')?.split(';')[0];
  const ownerId = (await fetch(app.url + '/__opencraft_account/status', { headers: { cookie: owner } }).then(r => r.json())).actor.id;
  assert.deepEqual(await fetch(path, { headers: { cookie: owner } }).then(r => r.json()), { actorId: ownerId });
  const receipt = JSON.stringify(['opencraft-server', 'thread', 'turn']);
  const saved = await fetch(path, { method: 'POST', headers: { ...json, cookie: owner }, body: JSON.stringify({ receipts: [receipt], expectedActorId: ownerId }) });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal((await fetch(path, { method: 'POST', headers: { ...json, origin: 'https://elsewhere.example', cookie: owner },
    body: JSON.stringify({ receipts: [receipt], expectedActorId: ownerId }) })).status, 403);
  const query = new URLSearchParams({ expectedActorId: ownerId, after: '0' });
  assert.deepEqual(await fetch(path + '?' + query, { headers: { cookie: owner } }).then(r => r.json()), { actorId: ownerId, cursor: 1, receipts: [receipt] });

  // An invited member reads only their own receipts; revoking membership refuses them.
  const invitation = await fetch(app.url + '/__opencraft_account/invitations', { method: 'POST', headers: { ...json, cookie: owner }, body: '{}' }).then(r => r.json());
  const accepted = await fetch(app.url + '/__opencraft_account/accept', { method: 'POST', headers: json,
    body: JSON.stringify({ code: invitation.code, username: 'member', password: 'Fixture-member-password-42' }) });
  assert.equal(accepted.status, 201, await accepted.clone().text());
  const member = accepted.headers.get('set-cookie')?.split(';')[0];
  const memberId = (await fetch(path, { headers: { cookie: member } }).then(r => r.json())).actorId;
  assert.notEqual(memberId, ownerId);
  assert.equal((await fetch(path + '?' + query, { headers: { cookie: member } })).status, 409);
  assert.deepEqual(await fetch(path + '?' + new URLSearchParams({ expectedActorId: memberId }), { headers: { cookie: member } }).then(r => r.json()),
    { actorId: memberId, cursor: 0, receipts: [] });
  const revoked = await fetch(app.url + '/__opencraft_account/members', { method: 'POST', headers: { ...json, cookie: owner },
    body: JSON.stringify({ actorId: memberId, role: 'member', enabled: false }) });
  assert.equal(revoked.status, 200, await revoked.clone().text());
  assert.equal((await fetch(path, { headers: { cookie: member } })).status, 403);
});

test('personal SSH keys sign people in over the real SSH ingress and follow membership revocation', { timeout: 60_000 }, async t => {
  const { default: ssh2 } = await import('ssh2');
  const { generateEd25519KeyPair } = await import('../support/ssh-ed25519.mjs');
  const f = await fixture(t);
  const host = generateEd25519KeyPair(), operator = generateEd25519KeyPair(), personal = generateEd25519KeyPair();
  const hostKeyFile = join(f.root, 'ssh-host-key'), sshConfig = join(f.root, 'ssh.json');
  await writeFile(hostKeyFile, host.private, { mode: 0o600 });
  await writeFile(sshConfig, JSON.stringify({ hostKeyFile, authorizedKeys: { operator: [operator.public] } }), { mode: 0o600 });
  const probe = await startHeadlessServer(f.options); await probe.close();
  const proof = randomBytes(32).toString('base64url');
  const proofPath = join(f.root, 'setup-token'), configPath = join(f.root, 'human-auth.json');
  await writeFile(proofPath, JSON.stringify({ token: proof }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ origin: probe.url, local: true, oidc: [], setupTokenFile: proofPath }), { mode: 0o600 });
  const app = await startHeadlessServer({ ...f.options, port: Number(new URL(probe.url).port), humanAuthConfig: configPath, sshConfig }); f.own(() => app.close());
  const path = app.url + '/__opencraft_ssh_keys';
  const json = { origin: app.url, 'content-type': 'application/json' };
  assert.equal((await fetch(path)).status, 401);
  const setup = await fetch(app.url + '/__opencraft_account/setup', { method: 'POST', headers: json,
    body: JSON.stringify({ proof, mode: 'web', username: 'owner', password: 'Fixture-account-password-42' }) });
  assert.equal(setup.status, 200, await setup.text());
  const owner = setup.headers.get('set-cookie')?.split(';')[0];
  const invitation = await fetch(app.url + '/__opencraft_account/invitations', { method: 'POST', headers: { ...json, cookie: owner }, body: '{}' }).then(r => r.json());
  const accepted = await fetch(app.url + '/__opencraft_account/accept', { method: 'POST', headers: json,
    body: JSON.stringify({ code: invitation.code, username: 'member', password: 'Fixture-member-password-42' }) });
  assert.equal(accepted.status, 201, await accepted.clone().text());
  const member = accepted.headers.get('set-cookie')?.split(';')[0];
  const listed = await fetch(path, { headers: { cookie: member } }).then(r => r.json());
  assert.deepEqual({ sshLogin: listed.sshLogin, keys: listed.keys, administrator: listed.administrator }, { sshLogin: true, keys: [], administrator: false });
  const memberId = listed.actorId;
  const added = await fetch(path, { method: 'POST', headers: { ...json, cookie: member }, body: JSON.stringify({ publicKey: personal.public + ' member@laptop', expectedActorId: memberId }) });
  assert.equal(added.status, 201, await added.clone().text());
  const ownerView = await fetch(path + '?' + new URLSearchParams({ actorId: memberId }), { headers: { cookie: owner } }).then(r => r.json());
  assert.equal(ownerView.administrator, true);
  assert.deepEqual(ownerView.keys.map(key => key.name), ['member@laptop']);

  const clients = [];
  t.after(() => { for (const client of clients) client.destroy(); });
  const connect = privateKey => new Promise((resolve, reject) => {
    const client = new ssh2.Client(); clients.push(client);
    client.once('ready', () => resolve(client)); client.once('error', reject);
    client.connect({ host: '127.0.0.1', port: Number(new URL(app.url).port), username: 'member', privateKey, readyTimeout: 3000 });
  });
  const session = await connect(personal.private);
  await assert.rejects(new Promise((resolve, reject) => session.exec('opencraft app-server proxy', (error, stream) => error ? reject(error) : resolve(stream))),
    /Unable to exec/, 'a personal key never enters the unscoped legacy bridge');
  const closed = once(session, 'close');
  const revoked = await fetch(app.url + '/__opencraft_account/members', { method: 'POST', headers: { ...json, cookie: owner },
    body: JSON.stringify({ actorId: memberId, role: 'member', enabled: false }) });
  assert.equal(revoked.status, 200, await revoked.clone().text());
  await closed;
  await assert.rejects(connect(personal.private), /authentication/);
  assert.deepEqual((await fetch(path + '?' + new URLSearchParams({ actorId: memberId }), { headers: { cookie: owner } }).then(r => r.json())).keys, [],
    'membership revocation durably revokes the key');
});

test('model policy and model gateway routes follow instance admission on a real Headless server, and close releases the policy writer', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  // The gateway route exists only when a deployment names its database; restore it after every server closed.
  const previousGateway = process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE;
  process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE = join(f.root, 'model-gateway.sqlite');
  t.after(() => {
    if (previousGateway === undefined) delete process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE;
    else process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE = previousGateway;
  });
  const probe = await startHeadlessServer(f.options); await probe.close();
  const proof = randomBytes(32).toString('base64url');
  const proofPath = join(f.root, 'setup-token'), configPath = join(f.root, 'human-auth.json');
  await writeFile(proofPath, JSON.stringify({ token: proof }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ origin: probe.url, local: true, oidc: [], setupTokenFile: proofPath }), { mode: 0o600 });
  const options = { ...f.options, port: Number(new URL(probe.url).port), humanAuthConfig: configPath };
  const app = await startHeadlessServer(options); f.own(() => app.close());
  const policyPath = app.url + '/__opencraft_model_policy', gatewayPath = app.url + '/__opencraft_model_gateway';
  const json = { origin: app.url, 'content-type': 'application/json' };
  const read = async (url, headers = {}) => { const response = await fetch(url, { headers }); return { status: response.status, body: await response.json() }; };

  // Unauthenticated requests are refused before either route runs.
  assert.deepEqual(await read(policyPath), { status: 401, body: { error: 'authentication_required' } });
  assert.deepEqual(await read(gatewayPath), { status: 401, body: { error: 'authentication_required' } });

  const setup = await fetch(app.url + '/__opencraft_account/setup', { method: 'POST', headers: json,
    body: JSON.stringify({ proof, mode: 'web', username: 'owner', password: 'Fixture-account-password-42' }) });
  assert.equal(setup.status, 200, await setup.text());
  const owner = setup.headers.get('set-cookie')?.split(';')[0];
  const ownerId = (await fetch(app.url + '/__opencraft_account/status', { headers: { cookie: owner } }).then(r => r.json())).actor.id;

  // The administrator reads and writes the policy and manages the gateway.
  const initial = await read(policyPath, { cookie: owner });
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.deepEqual({ canManage: initial.body.canManage, revision: initial.body.revision, rules: initial.body.rules }, { canManage: true, revision: 0, rules: [] });
  const rules = [{ engine: 'codex', model: 'fixture-blocked-model' }];
  const written = await fetch(policyPath, { method: 'POST', headers: { ...json, cookie: owner }, body: JSON.stringify({ revision: 0, rules }) });
  assert.equal(written.status, 200, await written.clone().text());
  assert.deepEqual((await written.json()).rules, rules);
  const ownerGateway = await read(gatewayPath, { cookie: owner });
  assert.equal(ownerGateway.status, 200, JSON.stringify(ownerGateway.body));
  assert.equal(ownerGateway.body.canManage, true);
  assert.equal(ownerGateway.body.subscriptionAvailable, false, 'no Core endpoint, so no personal subscription');

  // An admitted member reads without management rights and cannot write or read another Actor.
  const invitation = await fetch(app.url + '/__opencraft_account/invitations', { method: 'POST', headers: { ...json, cookie: owner }, body: '{}' }).then(r => r.json());
  const accepted = await fetch(app.url + '/__opencraft_account/accept', { method: 'POST', headers: json,
    body: JSON.stringify({ code: invitation.code, username: 'member', password: 'Fixture-member-password-42' }) });
  assert.equal(accepted.status, 201, await accepted.clone().text());
  const member = accepted.headers.get('set-cookie')?.split(';')[0];
  assert.deepEqual(await read(policyPath, { cookie: member }), { status: 200, body: { canManage: false } });
  const refused = await fetch(policyPath, { method: 'POST', headers: { ...json, cookie: member }, body: JSON.stringify({ revision: 1, rules: [] }) });
  assert.deepEqual({ status: refused.status, body: await refused.json() }, { status: 403, body: { error: 'administrator_required' } });
  const memberGateway = await read(gatewayPath, { cookie: member });
  assert.equal(memberGateway.status, 200, JSON.stringify(memberGateway.body));
  assert.equal(memberGateway.body.canManage, false);
  assert.deepEqual(await read(gatewayPath + '?' + new URLSearchParams({ actor: ownerId }), { cookie: member }), { status: 403, body: { error: 'gateway_forbidden' } });
  const configure = await fetch(gatewayPath, { method: 'POST', headers: { ...json, cookie: member },
    body: JSON.stringify({ action: 'configure', actor: ownerId, monthlyTokens: 1, requestTokens: 1, concurrency: 1, revision: 0 }) });
  assert.deepEqual({ status: configure.status, body: await configure.json() }, { status: 403, body: { error: 'gateway_operation_forbidden' } });
  const memberId = (await fetch(app.url + '/__opencraft_account/status', { headers: { cookie: member } }).then(r => r.json())).actor.id;
  const revoked = await fetch(app.url + '/__opencraft_account/members', { method: 'POST', headers: { ...json, cookie: owner },
    body: JSON.stringify({ actorId: memberId, role: 'member', enabled: false }) });
  assert.equal(revoked.status, 200, await revoked.clone().text());
  assert.equal((await fetch(policyPath, { headers: { cookie: member } })).status, 403, 'a revoked member is no longer admitted');
  assert.equal((await fetch(gatewayPath, { headers: { cookie: member } })).status, 403, 'a revoked member is no longer admitted');

  // Close releases the policy database: its WAL is checkpointed away, and the
  // same data directory reopens with the written policy.
  const policyWal = join(f.options.dataDirectory, 'model-usage-policy.sqlite-wal');
  assert.equal((await stat(policyWal)).isFile(), true, 'the open policy writer keeps a WAL');
  await app.close();
  await assert.rejects(stat(policyWal), { code: 'ENOENT' });
  const reopened = await startHeadlessServer(options); f.own(() => reopened.close());
  const persisted = await read(reopened.url + '/__opencraft_model_policy', { cookie: owner });
  assert.equal(persisted.status, 200, JSON.stringify(persisted.body));
  assert.deepEqual({ revision: persisted.body.revision, rules: persisted.body.rules }, { revision: 1, rules });
});

// Node-local services (gateway-split §4.1.1): each is wired from its deployment
// configuration on a real Headless server and released by `close`.
async function withEnvironment(name, value, operation) {
  const previous = process.env[name];
  process.env[name] = value;
  try { return await operation(); } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
}

test('node-local observation ingress is mounted from its private configuration and reports a planned restart', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  // Unix socket paths stay short; the private directory closes after the server.
  const sockets = await mkdtemp(join(tmpdir(), 'oc-node-local-observe-')), cleanup = ownedCleanup(t);
  cleanup.last(() => rm(sockets, { recursive: true, force: true }));
  const observe = await startObserve({ directory: sockets, deploymentId: 'node-local', metricsPort: 0 }); cleanup.own(() => observe.close());
  const capabilities = url => fetch(url + '/__opencraft_observe/capabilities').then(response => response.json());

  // A configuration that is not owner-only is refused; the workbench starts without the ingress.
  const shared = join(sockets, 'shared.json');
  await writeFile(shared, JSON.stringify({ socketPath: observe.socketPath, grafanaSocket: join(sockets, 'grafana.sock'), pseudonymKey: '1'.repeat(64) }), { mode: 0o644 });
  const written = [], write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) { written.push(String(chunk)); return write.call(this, chunk, ...rest); };
  let degraded;
  try { degraded = await withEnvironment('OPENCRAFT_OBSERVE_INGRESS_CONFIG', shared, () => startHeadlessServer(f.options)); }
  finally { process.stderr.write = write; }
  assert.ok(written.some(line => line.includes('Observability configuration unavailable')));
  assert.deepEqual(await capabilities(degraded.url), { available: false, telemetry: false }, 'the Web fallback answers without the ingress');
  await degraded.close();

  const config = join(sockets, 'observe.json');
  await writeFile(config, JSON.stringify({ socketPath: observe.socketPath, grafanaSocket: join(sockets, 'grafana.sock'), pseudonymKey: '1'.repeat(64) }), { mode: 0o600 });
  const app = await withEnvironment('OPENCRAFT_OBSERVE_INGRESS_CONFIG', config, () => startHeadlessServer(f.options));
  f.own(() => app.close());
  assert.deepEqual(await capabilities(app.url), { available: false, telemetry: false, entry: null }, 'the configured ingress answers anonymous requests');
  const since = Date.now();
  // The Web close reports the update through the still-open ingress before it is retired.
  await app.close({ updateId: 'node-local-update', buildId: 'node-local-build' });
  const receipt = observe.store.events(since - 1, Date.now() + 1, Date.now()).find(row => row.kind === 'lifecycle' && row.producerId === 'node-local-update');
  assert.equal(receipt?.lifecycle, 'deployment');
  // Closing released the data directory.
  const reopened = await startHeadlessServer(f.options); f.own(() => reopened.close());
});

test('node-local availability notification listens on its private socket and close removes it', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const sockets = await mkdtemp(join(tmpdir(), 'oc-node-local-notify-')), cleanup = ownedCleanup(t);
  cleanup.last(() => rm(sockets, { recursive: true, force: true }));
  const token = 'n'.repeat(40), tokenFile = join(sockets, 'token');
  await writeFile(tokenFile, token, { mode: 0o600 });
  const settings = { socketPath: join(sockets, 'notify.sock'), tokenFile, receiptsFile: join(sockets, 'receipts'), channelId: 'wecom', senderId: 'operator', actorId: 'human' };
  const notify = authorization => new Promise((resolve, reject) => {
    const outgoing = httpRequest({ socketPath: settings.socketPath, path: '/notify', method: 'POST', headers: { authorization } }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    outgoing.on('error', reject);
    outgoing.end(JSON.stringify({ incidentId: 'incident', kind: 'alert', site: 'local', hostId: 'local-codex', engine: 'codex', errorCode: 'initialize' }));
  });

  // An unreadable configuration is reported and the server starts without the listener.
  const warnings = [], warn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  let degraded;
  try { degraded = await withEnvironment('OPENCRAFT_AVAILABILITY_NOTIFICATION_CONFIG', join(sockets, 'missing.json'), () => startHeadlessServer(f.options)); }
  finally { console.warn = warn; }
  assert.ok(warnings.includes('[availability-notification] startup-unavailable'));
  await degraded.close();

  const config = join(sockets, 'notify.json');
  await writeFile(config, JSON.stringify(settings), { mode: 0o600 });
  const app = await withEnvironment('OPENCRAFT_AVAILABILITY_NOTIFICATION_CONFIG', config, () => startHeadlessServer(f.options));
  f.own(() => app.close());
  assert.equal((await notify('Bearer wrong')).status, 401);
  // The IM service is read through its late port: without a bound operator channel nothing is sent.
  assert.deepEqual(await notify('Bearer ' + token), { status: 503, body: { error: 'notification_unavailable' } });
  await app.close();
  await assert.rejects(stat(settings.socketPath), { code: 'ENOENT' }, 'close retires the notification socket');
});

test('local desktop without a verified observer fails startup and rollback releases the data lock', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(startHeadlessServer({ ...f.options, localDesktop: true }));
  const app = await startHeadlessServer(f.options); f.own(() => app.close());
  assert.equal((await fetch(app.url + '/')).status, 200);
});

test('installation identity: the identity composition receives its inputs, isHuman filters external principals, and its disposers keep their shutdown order', { timeout: 30_000 }, async t => {
  const f = await fixture(t), order = [];
  const principal = subject => ({ provider: 'fixture-directory', subject, displayName: subject, expiresAt: Date.now() + 60_000 });
  let inputs;
  const app = await startHeadlessServer({ ...f.options, accessMemberProviders: ['fixture-directory'] }, {
    createIdentity: async input => {
      inputs = input;
      return { providers: [{ authenticate: request => request.headers['x-fixture-subject'] ? principal(request.headers['x-fixture-subject']) : null }],
        executionEnvironment: { close() { order.push('execution-environment'); } },
        close() { order.push('identity'); } };
    },
    isHuman: candidate => candidate.subject !== 'service-account',
    close() { order.push('composition'); },
  }); f.own(() => app.close());
  assert.deepEqual(Object.keys(inputs), ['dataDirectory', 'membership', 'relayConfiguration', 'workspaceExecution', 'hubAuthority',
    'resolveIdentity', 'getInstanceAccess', 'machineIdentity', 'actors', 'sshIngressEnabled']);
  assert.equal(inputs.dataDirectory, f.options.dataDirectory);
  assert.equal(typeof inputs.membership?.actorMembership, 'function', 'accepted member providers enable instance membership');
  assert.deepEqual([inputs.relayConfiguration, inputs.workspaceExecution, inputs.hubAuthority, inputs.sshIngressEnabled], [null, undefined, null, false]);
  assert.equal(typeof inputs.machineIdentity.machineId, 'string');
  assert.equal(typeof inputs.actors.findHuman, 'function');
  // Instance access is constructed after the identity composition; its late reads see it.
  assert.equal(typeof inputs.getInstanceAccess()?.authenticate, 'function');
  assert.equal(inputs.resolveIdentity({ headers: { 'x-fixture-subject': 'alice' } })?.subject, 'alice');
  assert.equal(inputs.resolveIdentity({ headers: {} }), null);
  // The composition's qualification decides which verified principals are people.
  const me = await fetch(app.url + '/__opencraft_actors/me', { headers: { 'x-fixture-subject': 'alice' } });
  assert.equal(me.status, 200); assert.equal((await me.json()).actor.kind, 'human');
  assert.equal((await fetch(app.url + '/__opencraft_actors/me', { headers: { 'x-fixture-subject': 'service-account' } })).status, 401);
  await app.close();
  assert.deepEqual(order, ['execution-environment', 'identity', 'composition']);
});

test('installation admission: a malformed setup token or login admission without membership fails startup and rollback releases the data lock', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const tokenPath = join(f.root, 'malformed-setup-token'), configPath = join(f.root, 'human-auth.json');
  await writeFile(tokenPath, JSON.stringify({ token: 'too-short' }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ origin: 'http://127.0.0.1:1', local: true, oidc: [], setupTokenFile: tokenPath }), { mode: 0o600 });
  await assert.rejects(startHeadlessServer({ ...f.options, humanAuthConfig: configPath }), /Invalid private setup token file/);
  await assert.rejects(startHeadlessServer(f.options, { loginAdmission: { provider: 'fixture-directory', attribute: 'login' } }),
    /Login admission requires instance access/);
  assert.equal(f.starts(), 0, 'admission fails before any execution host starts');
  const app = await startHeadlessServer(f.options); f.own(() => app.close());
  assert.equal((await fetch(app.url)).status, 200);
});

test('installation services: collaboration, connectors, server information and push follow the signed-in Human and persist across a restart', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const probe = await startHeadlessServer(f.options); await probe.close();
  const proof = randomBytes(32).toString('base64url');
  const proofPath = join(f.root, 'setup-token'), configPath = join(f.root, 'human-auth.json');
  await writeFile(proofPath, JSON.stringify({ token: proof }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ origin: probe.url, local: true, oidc: [], setupTokenFile: proofPath }), { mode: 0o600 });
  const options = { ...f.options, port: Number(new URL(probe.url).port), humanAuthConfig: configPath };
  let app = await startHeadlessServer(options); f.own(() => app.close());
  const json = { origin: app.url, 'content-type': 'application/json' };
  const setup = await fetch(app.url + '/__opencraft_account/setup', { method: 'POST', headers: json,
    body: JSON.stringify({ proof, mode: 'web', username: 'owner', password: 'Fixture-account-password-42' }) });
  assert.equal(setup.status, 200, await setup.text());
  const owner = setup.headers.get('set-cookie')?.split(';')[0];
  const ownerId = (await fetch(app.url + '/__opencraft_account/status', { headers: { cookie: owner } }).then(r => r.json())).actor.id;

  // Collaboration answers the signed-in Actor only.
  assert.equal((await fetch(app.url + '/__opencraft_actors/collaboration/inbox')).status, 401);
  const inbox = await fetch(app.url + '/__opencraft_actors/collaboration/inbox', { headers: { cookie: owner } });
  assert.equal(inbox.status, 200, await inbox.clone().text());
  assert.deepEqual(await inbox.json(), { messages: [] });
  // Connectors publish the installation's execution servers for both local hosts.
  const connectors = await fetch(app.url + '/__opencraft_connectors', { headers: { cookie: owner } }).then(r => r.json());
  assert.equal(connectors.protocolVersion, 1);
  assert.deepEqual(Object.keys(connectors.hosts).sort(), ['local-codex', 'opencraft-server']);
  assert.match(connectors.hosts['local-codex'], /^server:[^:]+:codex$/u);
  assert.equal(connectors.hosts['opencraft-server'], connectors.hosts['local-codex'].replace(/:codex$/u, ':dsh'));
  // Server information: anonymous refused, the administrator manages it.
  const information = app.url + '/__opencraft_server_information';
  assert.equal((await fetch(information)).status, 401);
  assert.deepEqual(await fetch(information, { headers: { cookie: owner } }).then(r => r.json()),
    { revision: 0, publicUrl: '', actorId: ownerId, canManage: true });
  const saved = await fetch(information, { method: 'POST', headers: { ...json, cookie: owner },
    body: JSON.stringify({ revision: 0, publicUrl: 'https://opencraft.example/team', expectedActorId: ownerId }) });
  assert.equal(saved.status, 200, await saved.clone().text());
  // Push subscriptions answer the signed-in Human for both local hosts.
  assert.equal((await fetch(app.url + '/__opencraft_push')).status, 401);
  const push = await fetch(app.url + '/__opencraft_push', { headers: { cookie: owner } }).then(r => r.json());
  assert.equal(push.available, true); assert.equal(push.actorId, ownerId);
  assert.deepEqual(push.hosts, ['local-codex', 'opencraft-server']);
  // Each deployment-level store reports its storage outcome.
  const storage = (await fetch(app.url + '/__opencraft_health').then(r => r.json())).storage.map(row => row.name);
  for (const name of ['server-core', 'web-push', 'mcp-apps']) assert.ok(storage.includes(name), name);

  // Close releases every writer before the lock; a restart reads the same state.
  await app.close();
  app = await startHeadlessServer(options);
  assert.deepEqual(await fetch(information, { headers: { cookie: owner } }).then(r => r.json()),
    { revision: 1, publicUrl: 'https://opencraft.example/team', actorId: ownerId, canManage: true });
  assert.equal((await fetch(app.url + '/__opencraft_push', { headers: { cookie: owner } }).then(r => r.json())).publicKey, push.publicKey);
});

test('installation services: a startup failure after they opened closes every installation writer and releases the data lock', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  let missing;
  await assert.rejects(startHeadlessServer({ ...f.options, createWebServer: async options => {
    missing = ['actorCollaborationService', 'connectorService', 'serverInformationService', 'turnPushService', 'mcpAppsService',
      'accountModelDefaultsService', 'actorSshKeysService'].filter(key => !options[key]);
    throw new Error('fixture web failure');
  } }), /fixture web failure/);
  // Every installation service is open by the time the Web server is created.
  assert.deepEqual(missing, []);
  const app = await startHeadlessServer(f.options); f.own(() => app.close());
  assert.equal((await fetch(app.url)).status, 200);
});

test('root inputs: the Hub node state, machine identity and relay configuration reach the installation from their files, unchanged across a restart', { timeout: 60_000 }, async t => {
  const f = await fixture(t), dataDirectory = f.options.dataDirectory;
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const { openLocalHubNetwork } = await import('../../packages/hub-network/src/store-file.ts');
  const { AssertionSigner, ASSERTION_HEADER } = await import('../../packages/identity-core/src/node.ts');
  const pem = () => { const pair = generateKeyPairSync('ed25519');
    return { publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(), privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }; };
  // A Hub node that accepted an identity authority and published an origin before this start.
  const hubKeys = pem(), authority = { issuer: 'hub-login', publicKey: hubKeys.publicKey, providers: ['hub-directory'] };
  const statePath = join(dataDirectory, 'hub-network.json');
  const hub = await openLocalHubNetwork(statePath, { authority });
  await hub.apply({ revision: hub.store.state.revision, action: 'configure', name: 'Fixture Hub', endpoint: '', origin: 'https://hub-origin.test', accepting: false, forwarding: false }, 'fixture');
  const hubId = hub.store.id; hub.close();
  const storedHub = await readFile(statePath, 'utf8');
  const relayKeys = pem(), relayPath = join(f.root, 'relay-connect.json');
  await writeFile(relayPath, JSON.stringify({ schemaVersion: 1, relay: 'http://127.0.0.1:9', credential: 'c'.repeat(43), allowLoopbackInsecure: true,
    issuer: 'relay-login', instanceId: 'relay-instance', origin: 'https://relay-origin.test', publicKey: relayKeys.publicKey }), { mode: 0o600 });
  let inputs;
  const options = { ...f.options, machineName: '  Fixture machine  ', relayConnectFile: relayPath };
  const composition = { createIdentity: async input => { inputs = input; return { providers: [], close() {} }; } };
  let app = await startHeadlessServer(options, composition); f.own(() => app?.close());
  const machineId = (await readFile(join(dataDirectory, 'machine-id'), 'utf8')).trim();
  assert.deepEqual({ ...inputs.machineIdentity }, { machineId, name: 'Fixture machine', platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux' });
  assert.deepEqual(inputs.hubAuthority, authority);
  assert.equal(typeof inputs.membership?.actorMembership, 'function', 'a published Hub origin enables instance membership');
  assert.deepEqual([inputs.relayConfiguration.options.relay, inputs.relayConfiguration.options.allowLoopbackInsecure], ['http://127.0.0.1:9', true]);
  // Both external providers verify assertions for their own scope only.
  const principal = { provider: 'hub-directory', subject: 'alice', displayName: 'Alice', expiresAt: Date.now() + 60_000 };
  const asserted = (signer, host) => ({ method: 'GET', url: '/__opencraft_actors/me',
    headers: { host, [ASSERTION_HEADER]: signer.issue(principal, 'GET', '/__opencraft_actors/me') } });
  const hubSigner = new AssertionSigner({ issuer: 'hub-login', instanceId: hubId, origin: 'https://hub-origin.test' }, hubKeys.privateKey);
  const relaySigner = new AssertionSigner({ issuer: 'relay-login', instanceId: 'relay-instance', origin: 'https://relay-origin.test' }, relayKeys.privateKey);
  assert.equal(inputs.resolveIdentity(asserted(hubSigner, 'hub-origin.test'))?.subject, 'alice');
  assert.equal(inputs.resolveIdentity(asserted(relaySigner, 'relay-origin.test'))?.subject, 'alice');
  assert.equal(inputs.resolveIdentity(asserted(hubSigner, 'relay-origin.test')), null);
  await app.close(); app = undefined;
  // Opening the Hub node changed nothing: same bytes, still owner-only; the machine ID file is owner-only too.
  assert.equal(await readFile(statePath, 'utf8'), storedHub);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(dataDirectory, 'machine-id'))).mode & 0o777, 0o600);
  app = await startHeadlessServer(options, composition);
  assert.equal(inputs.machineIdentity.machineId, machineId, 'a restart reads the same machine identity');
  assert.deepEqual(inputs.hubAuthority, authority);
  await app.close(); app = undefined;

  // An operator-installed remote Hub controller replaces the local node: no Hub authority, and a malformed one fails startup.
  const controllerPath = join(dataDirectory, 'hub-network-controller.json');
  await writeFile(controllerPath, JSON.stringify({ schemaVersion: 1, endpoint: 'http://127.0.0.1:9', credential: 'h'.repeat(43) }), { mode: 0o600 });
  app = await startHeadlessServer(f.options, composition);
  assert.deepEqual([inputs.hubAuthority, inputs.membership], [null, undefined]);
  await app.close(); app = undefined;
  const started = f.starts();
  await writeFile(controllerPath, JSON.stringify({ schemaVersion: 1, endpoint: 'https://hub.example', credential: 'h'.repeat(43) }), { mode: 0o600 });
  await assert.rejects(startHeadlessServer(f.options, composition), /Hub controller requires loopback/);
  await writeFile(controllerPath, JSON.stringify({ schemaVersion: 2, endpoint: 'http://127.0.0.1:9', credential: 'h'.repeat(43) }), { mode: 0o600 });
  await assert.rejects(startHeadlessServer(f.options, composition), /Invalid Hub controller configuration/);
  assert.equal(f.starts(), started, 'no execution host started');
  await rm(controllerPath);
  app = await startHeadlessServer(f.options, composition);
  assert.deepEqual(inputs.hubAuthority, authority, 'the local Hub node state is still there');
});

test('installation routes: the shared route table and admission gate keep their wire bytes on a real Headless server', { timeout: 60_000 }, async t => {
  // Raw HTTP/1.1 bytes (Date removed): the installation route definitions and the
  // admission refusals are shared with the InstallationCore front door, so the
  // Node gateway must answer exactly as before they were shared.
  const raw = async (url, path, headers = {}) => {
    const { hostname, port } = new URL(url);
    const socket = connect(Number(port), hostname);
    await once(socket, 'connect');
    socket.end(`GET ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}Connection: close\r\n\r\n`);
    const chunks = [];
    for await (const chunk of socket) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').replace(/\r\nDate: [^\r]+/u, '');
  };
  const json = body => `cache-control: no-store\r\ncontent-type: application/json; charset=utf-8\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  const f = await fixture(t);
  let app = await startHeadlessServer(f.options); f.own(() => app?.close());
  // Without Human login the login and account routes are owned but absent.
  for (const path of ['/__opencraft_auth/', '/__opencraft_auth/session', '/setup', '/__opencraft_account/status'])
    assert.equal(await raw(app.url, path), `HTTP/1.1 404 Not Found\r\n${json('{"error":"missing"}\n')}`, path);
  const origin = app.url;
  await app.close(); app = undefined;
  const proofPath = join(f.root, 'setup-token'), configPath = join(f.root, 'human-auth.json');
  await writeFile(proofPath, JSON.stringify({ token: randomBytes(32).toString('base64url') }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ origin, local: true, oidc: [], setupTokenFile: proofPath }), { mode: 0o600 });
  app = await startHeadlessServer({ ...f.options, port: Number(new URL(origin).port), humanAuthConfig: configPath });
  const unauthenticated = '{"error":"authentication_required"}\n';
  assert.equal(await raw(app.url, '/anything', { accept: 'application/json' }), `HTTP/1.1 401 Unauthorized\r\n${json(unauthenticated)}`);
  assert.equal(await raw(app.url, '/anything'), `HTTP/1.1 401 Unauthorized\r\n${json(unauthenticated)}`);
  const page = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>访问受限</title><style>:root{color-scheme:light dark}a{color:inherit}a:focus-visible{outline:2px solid currentColor;outline-offset:4px}</style><body style="font:16px system-ui;margin:12vh auto;padding:24px;max-width:480px"><h1>暂时无法访问</h1><p>请登录后继续。</p><a href="/__opencraft_auth/">登录与账号</a> · <a href="">重新检查</a></body></html>';
  assert.equal(await raw(app.url, '/anything', { accept: 'text/html' }), 'HTTP/1.1 401 Unauthorized\r\ncache-control: private, no-store\r\ncontent-type: text/html; charset=utf-8\r\nx-content-type-options: nosniff\r\n'
    + `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n${Buffer.byteLength(page).toString(16)}\r\n${page}\r\n0\r\n\r\n`);
  assert.equal(await raw(app.url, '/anything', { authorization: 'Bearer oc_actor_fixture' }),
    `HTTP/1.1 403 Forbidden\r\n${json('{"error":"actor_resource_interface_required"}\n')}`);
  // Owned routes still reach their service after the route table moved.
  assert.match(await raw(app.url, '/__opencraft_auth/session'), /^HTTP\/1\.1 200 OK\r\n/u);
  assert.equal(await raw(app.url, '/__opencraft_access/session'), `HTTP/1.1 401 Unauthorized\r\n${json(unauthenticated)}`);
});
