import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chromium } from '@playwright/test';
import WebSocket from 'ws';
import { HubNetwork } from "../../../packages/hub-network/src/node";
import { MembershipStore, InstanceAccess } from "../../../packages/access-control/src";
import { createWorkbenchWebServer } from "../../serve-workbench-web.mjs";
import { AssertionSigner } from "../../../packages/identity-core/src/node";
import { packageRelay } from "../../package-relay.mjs";

const output = resolve(process.env.OPENCRAFT_HUB_SMOKE_DIRECTORY ?? '.local/hub-network-transport'); await mkdir(output, { recursive: true });
const privateRoot = await mkdtemp(join(output, 'private-')), cleanup: (() => unknown)[] = [];
const artifact = resolve(process.env.OPENCRAFT_HUB_RELAY_ARTIFACT ?? 'dist/relay/relay.mjs');
const save = async (file: string, value: unknown) => writeFile(join(privateRoot, file), JSON.stringify(value), { mode: 0o600 });
async function freePort() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as { port: number }).port; await new Promise<void>(r => server.close(() => r())); return port; }
async function waitFor(check: () => Promise<boolean> | boolean) { const until = Date.now() + 20_000; while (!await check()) { if (Date.now() > until) throw new Error('Transport condition timeout'); await new Promise(r => setTimeout(r, 30)); } }
try {
  const command = (args: string[]) => execFileSync('openssl', args, { cwd: privateRoot, stdio: 'pipe' });
  command(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Isolated Hub Test CA', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1']);
  command(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1', '-keyout', 'server.key', '-out', 'server.csr']);
  await writeFile(join(privateRoot, 'ext'), 'subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
  command(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '1', '-extfile', 'ext']);
  const pair = generateKeyPairSync('ed25519'), privateKey = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const entryPort = await freePort(), tlsPort = await freePort(), bPort = await freePort(), publicBase = `http://127.0.0.1:${entryPort}`;
  const origin = `http://team.hub.test:${entryPort}`, login = `http://login.hub.test:${entryPort}`, credential = randomBytes(32).toString('base64url');
  const fixtureCredential = randomBytes(32).toString('base64url');
  await save('identity.json', { credential: fixtureCredential }); await save('operator.json', { credential });
  // The public transit Relay stays unmodified. Only this isolated gateway adds
  // a trusted local identity adapter through the same composition port.
  const gateway = await packageRelay({ output: join(privateRoot, 'gateway'), relayEntry: resolve('tests/fixtures/hub-relay-entry.ts') });
  await save('relay.json', { schemaVersion: 1, authentication: { issuer: 'smoke-auth', privateKey, origin: login, providers: ['fixture'] }, host: '127.0.0.1', port: entryPort,
    serverSelection: true, routes: [{ instanceId: 'entry', origin: login, credential: randomBytes(32).toString('base64url') }],
    hubNetwork: { stateFile: join(privateRoot, 'a.json'), operatorCredentialFile: join(privateRoot, 'operator.json'), caFile: join(privateRoot, 'ca.crt'),
      tlsCertFile: join(privateRoot, 'server.crt'), tlsKeyFile: join(privateRoot, 'server.key'), port: tlsPort } });
  const child = spawn(process.execPath, [join(gateway.output, 'relay.mjs'), join(privateRoot, 'relay.json')], {
    env: { ...process.env, OPENCRAFT_HUB_FIXTURE_CREDENTIAL_FILE: join(privateRoot, 'identity.json') }, stdio: ['ignore', 'pipe', 'pipe'],
  }); let childLog = '';
  child.stdout!.on('data', b => childLog += b); child.stderr!.on('data', b => childLog += b);
  cleanup.unshift(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } await writeFile(join(output, 'relay-process.log'), childLog); });
  await waitFor(async () => { if (child.exitCode !== null) throw new Error('Relay artifact failed to start'); try { return (await fetch(publicBase + '/__opencraft_relay/health')).ok; } catch { return false; } });
  const operator = async (input?: Record<string, unknown>) => {
    const res = await fetch(publicBase + '/__opencraft_hub/operator', { method: input ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' }, body: input ? JSON.stringify(input) : undefined });
    assert.equal(res.status, 200); return await res.json();
  };
  let a = await operator(); await operator({ revision: a.revision, action: 'configure', name: 'Entry A', endpoint: `https://127.0.0.1:${tlsPort}`, origin: '', accepting: true, forwarding: true });
  a = await operator(); const ab = await operator({ revision: a.revision, action: 'invite', origins: [origin], allowTransit: true });
  const b = new HubNetwork(join(privateRoot, 'b.json'), { ca: await readFile(join(privateRoot, 'ca.crt'), 'utf8') }), c = new HubNetwork(join(privateRoot, 'c.json')); cleanup.push(() => b.close(), () => c.close());
  const mutate = (node: HubNetwork, input: Record<string, unknown>) => node.command({ revision: node.store.state.revision, ...input }, 'fixture-administrator');
  mutate(b, { action: 'connect', invitation: ab.invitation, trustIdentity: true });
  // The department uses a normal certificate trusted through an explicit invitation CA.
  mutate(b, { action: 'configure', name: 'Department B', endpoint: `https://127.0.0.1:${bPort}`, origin: '', accepting: true, forwarding: true });
  const bc = mutate(b, { action: 'invite', origins: [origin], allowTransit: false }) as { invitation: string };
  b.close();
  const bAdminPort = await freePort();
  await save('department.json', { schemaVersion: 1, host: '127.0.0.1', port: bAdminPort, routes: [],
    hubNetwork: { stateFile: join(privateRoot, 'b.json'), operatorCredentialFile: join(privateRoot, 'operator.json'), caFile: join(privateRoot, 'ca.crt'),
      tlsCertFile: join(privateRoot, 'server.crt'), tlsKeyFile: join(privateRoot, 'server.key'), port: bPort } });
  const department = spawn(process.execPath, [artifact, join(privateRoot, 'department.json')], { stdio: ['ignore', 'pipe', 'pipe'] }); let departmentLog = '';
  department.stdout!.on('data', chunk => departmentLog += chunk); department.stderr!.on('data', chunk => departmentLog += chunk);
  cleanup.unshift(async () => { if (department.exitCode === null) { department.kill('SIGTERM'); await once(department, 'exit'); } await writeFile(join(output, 'department-process.log'), departmentLog); });
  await waitFor(async () => { if (department.exitCode !== null) throw new Error('Department relay failed'); try { return (await fetch(`http://127.0.0.1:${bAdminPort}/__opencraft_relay/health`)).ok; } catch { return false; } });
  mutate(c, { action: 'connect', invitation: bc.invitation, trustIdentity: true, publishOrigin: origin });
  const store = new MembershipStore(join(privateRoot, 'members.sqlite')); cleanup.push(() => store.close());
  const principal = { provider: 'fixture', subject: '123', displayName: 'Network member', expiresAt: Date.now() + 3600_000 }; store.set(principal, 'member', true, 'fixture');
  const root = join(privateRoot, 'web'); await mkdir(root); await writeFile(join(root, 'index.html'), '<!doctype html><html><head><title>Team C</title></head><body><h1>Team C through two Hubs</h1></body></html>');
  const core = await createWorkbenchWebServer({ root, accessService: new InstanceAccess(store, [c]), loopbackOnly: false,
    desktopService: { accept(ws: WebSocket) { ws.send('ready'); }, close() {} }, desktopAccess: 'trusted-internal' }); cleanup.push(() => core.close());
  const coreAddress = await core.listen({ host: '127.0.0.1', port: 0 }); c.start(coreAddress.port);
  await waitFor(async () => (await operator()).routes.some((r: any) => r.hubId === c.store.id));
  await assert.rejects(new Promise<void>((resolve, reject) => { const ws = new WebSocket(`wss://127.0.0.1:${tlsPort}/__opencraft_hub/control`, 'opencraft-hub.v1'); ws.once('open', () => { ws.terminate(); resolve(); }); ws.once('error', reject); }), /certificate|issuer|self.signed/iu);
  const browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--no-proxy-server', '--host-resolver-rules=MAP *.hub.test 127.0.0.1'] }); cleanup.push(() => browser.close());
  const anonymous = await browser.newContext();
  try { assert.equal((await (await anonymous.newPage()).goto(origin))?.status(), 401, 'the gateway must reject unverified browser identity'); }
  finally { await anonymous.close(); }
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-fixture-credential': fixtureCredential } }), page = await context.newPage(), errors: string[] = [], navigations: string[] = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (r.isNavigationRequest()) navigations.push(new URL(r.url()).hostname); });
  const response = await page.goto(origin); assert.equal(response?.status(), 200); assert.equal(await page.title(), 'Team C'); assert.ok(navigations.includes('login.hub.test'));
  const session = await page.evaluate(() => fetch('/__opencraft_access/session').then(r => r.json())); assert.equal(session.role, 'member'); assert.equal(session.principal.subject, '123');
  await page.screenshot({ path: join(output, 'team-c.png') });
  // The same enrolled virtual origin is reachable through the approved entry without its own DNS.
  const chooser = await context.newPage(); await chooser.goto(login);
  await chooser.getByRole('heading', {name:'选择服务器',exact:true}).waitFor();
  await chooser.locator(`[data-server="${c.store.id}"]`).click();
  await chooser.getByRole('heading',{name:'Team C through two Hubs'}).waitFor();
  assert.equal(new URL(chooser.url()).origin,login);
  assert.equal(await chooser.locator('#opencraft-server-context').count(),1);
  const selectedSession = await chooser.evaluate(id=>fetch(`/servers/${id}/__opencraft_access/session`).then(r=>r.json()),c.store.id);
  assert.equal(selectedSession.role,'member');
  await chooser.screenshot({path:join(output,'same-origin-team-c.png')});

  const closed = page.evaluate(() => new Promise<number>((resolve, reject) => { const ws = new WebSocket(location.origin.replace('http:', 'ws:') + '/desktop/connect');
    ws.onmessage = () => { (window as any).ready = true; }; ws.onclose = e => resolve(e.code); ws.onerror = () => reject(new Error('Target WebSocket failed')); }));
  await page.waitForFunction(() => (window as any).ready); store.set(principal, 'member', false, 'fixture'); assert.ok([1006, 1008].includes(await closed));
  assert.equal(await page.evaluate(() => fetch('/__opencraft_access/session').then(r => r.status)), 403);
  // An intermediate's valid key cannot replace the independently pinned identity issuer.
  const forged = new AssertionSigner({ issuer: 'smoke-auth', instanceId: c.store.id, origin }, b.store.state.privateKey).issue(principal, 'GET', '/__opencraft_access/session');
  assert.equal(c.authenticate({ method: 'GET', url: '/__opencraft_access/session', headers: { host: new URL(origin).host, 'x-opencraft-relay-assertion': forged } }), null);
  const route = (await operator()).routes.find((r: any) => r.hubId === c.store.id); assert.equal(route.path.length, 3); assert.deepEqual(errors, []);
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ artifact, route, tokenFreeDepartmentRelay: true, nodeTlsBothHops: true, normalCertificateVerification: true, untrustedCaRejected: true,
    browserLoginHandoff: true, sameOriginSelectionOverTwoHubs: true, targetRole: session.role, memberRevocation: true, intermediateCannotResignIdentity: true, errors,
    unverifiedIdentityRejected: true,
    boundary: 'Actual bundled generic identity gateway and token-free public department Relay child processes, HTTPS peer transport, real Chromium and core target membership. Gateway identity adapter and target page are isolated fixtures; no private product, employee or model calls.' }, null, 2));
  console.log(JSON.stringify({ output, nodeTlsBothHops: true, browserLoginHandoff: true, memberRevocation: true }));
} finally { for (const close of cleanup.reverse()) await close(); await rm(privateRoot, { recursive: true, force: true }); }
