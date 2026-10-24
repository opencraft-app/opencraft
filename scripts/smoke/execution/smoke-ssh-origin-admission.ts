import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { SshManagement } from "../../../apps/opencraft-daemon/src/ssh-management.js";
// Entirely isolated state and TLS fixture, with no live SSH/model execution.
const directory = await mkdtemp(join(tmpdir(), 'opencraft-origin-smoke-'));
let management = new SshManagement({ directory: join(directory, 'ssh'), publicAccess: true, resetConnection: async () => {}, connectConnection: async () => {} });
let originFreeStatus = 0, grants = 0, accepted = 0, rejected = 0;
let saturationReady = false;
const bundled = await build({ stdin: { contents: 'export { SshConnectionsController } from "./plugins/builtin-agents/src/ssh-connections/controller.ts"; export { connectWebSocketAppHost } from "./apps/workbench-web/src/runtime/websocket-app-host.ts";', resolveDir: resolve('.') }, bundle: true, format: 'esm', platform: 'browser', write: false });
const handler = async (req: any, res: any) => {
  if (req.url === '/controller.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundled.outputFiles[0]!.text); return; }
  if (req.url === '/__opencraft_ssh/session') {
    if (req.method === 'GET' && !req.headers.origin && !req.headers.referer) originFreeStatus++;
    if (req.method === 'POST') grants++;
  }
  if (await management.handle(req, res)) return;
  res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta name="referrer" content="no-referrer"><title>SSH origin smoke</title>');
};
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', join(directory, 'key'), '-out', join(directory, 'cert')], { stdio: 'ignore' });
const plain = httpServer(handler), secure = httpsServer({ key: await readFile(join(directory, 'key')), cert: await readFile(join(directory, 'cert')) }, handler);
const sockets = new WebSocketServer({ noServer: true });
let heldClaim: { leaseId: string; grant(): void } | null = null;
const releasedClaims = new Set<string>();
secure.on('upgrade', (req, socket, head) => {
  if (!management.sameOrigin(req, true) || !management.authorized(req)) { rejected++; socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
  accepted++; sockets.handleUpgrade(req, socket, head, ws => {
    if (req.url?.startsWith('/raw')) { ws.send('admitted'); return; }
    ws.on('message', raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello') ws.send(JSON.stringify({ type: 'ready', protocolVersion: 2, services: ['appserver'] }));
      if (message.type === 'host/send') ws.send(JSON.stringify({ type: 'response', requestId: message.requestId, ok: true, result: null }));
      if (message.type === 'host/disconnect') {
        releasedClaims.add(message.leaseId);
        ws.send(JSON.stringify({ type: 'response', requestId: message.requestId, ok: true, result: null }));
      }
      if (message.type === 'host/connect') {
        const grant = () => ws.send(JSON.stringify({ type: 'response', requestId: message.requestId, ok: true, result: { hostId: message.hostId, generation: 1 } }));
        if (message.hostId === 'ssh:held') heldClaim = { leaseId: message.leaseId, grant };
        else if (message.hostId !== 'ssh:saturated' || saturationReady) grant();
      }
    });
  });
});
plain.listen(0, '127.0.0.1'); secure.listen(0, '127.0.0.1');
await Promise.all([once(plain, 'listening'), once(secure, 'listening')]);
const plainOrigin = `http://localhost:${(plain.address() as any).port}`, secureOrigin = `https://localhost:${(secure.address() as any).port}`;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); // ephemeral fixture certificate only
  const page = await context.newPage();
  await page.addInitScript('globalThis.__name = (fn) => fn');
  await page.goto(plainOrigin);
  assert.equal(await page.evaluate(async () => (await fetch('/__opencraft_ssh/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status), 200);
  const httpGrant = (await context.cookies()).find(cookie => cookie.name === 'opencraft_ssh_session_http')!;
  await context.addCookies([{ ...httpGrant, name: 'opencraft_ssh_session' }]);
  await page.goto(secureOrigin);
  const before = await page.evaluate(async () => (await fetch('/__opencraft_ssh/session')).json());
  assert.equal(before.authenticatedOrigin, plainOrigin);
  const socketResult = () => page.evaluate(() => new Promise<string>(resolve => {
    const ws = new WebSocket(`${location.origin.replace('https:', 'wss:')}/raw`);
    ws.onmessage = () => { resolve('admitted'); ws.close(); }; ws.onerror = () => resolve('rejected');
  }));
  assert.equal(await socketResult(), 'rejected');
  const result = await page.evaluate(async () => {
    const { SshConnectionsController } = await import(/* @vite-ignore */ `${location.origin}/controller.js`);
    const controller = new SshConnectionsController(undefined, location.origin);
    await controller.refresh(); const snapshot = controller.getSnapshot(), epoch = controller.getAuthorizationEpoch();
    await controller.refresh(); const stable = epoch === controller.getAuthorizationEpoch();
    controller.dispose(); return { authenticated: snapshot.authenticated, error: snapshot.error, stable };
  });
  assert.deepEqual(result, { authenticated: true, error: null, stable: true });
  assert.equal(await socketResult(), 'admitted');
  assert.equal(grants, 2); assert.ok(originFreeStatus >= 3); assert.equal(rejected, 1); assert.equal(accepted, 1);
  // Keep the same page, controller, transport and draft across a backend restart.
  await page.evaluate(async () => {
    const { SshConnectionsController, connectWebSocketAppHost } = await import(/* @vite-ignore */ `${location.origin}/controller.js`);
    const controller = new SshConnectionsController(undefined, location.origin);
    const client = connectWebSocketAppHost(undefined, { path: '/ssh-apphost', beforeConnect: () => controller.prepareConnection(), reportFailure: () => {} });
    const transport = client.createTransport('ssh:fixture');
    document.body.innerHTML = '<textarea>retained draft</textarea>';
    const draft = document.querySelector('textarea');
    (window as any).recoveryFixture = { controller, client, transport, draft };
    await transport.connect();
  });
  management.close();
  management = new SshManagement({ directory: join(directory, 'ssh'), publicAccess: true, resetConnection: async () => {}, connectConnection: async () => {} });
  for (const ws of sockets.clients) ws.terminate();
  await page.waitForFunction(() => (window as any).recoveryFixture.transport.status.state === 'failed');
  const recovered = await page.evaluate(async () => {
    const { controller, client, transport, draft } = (window as any).recoveryFixture;
    await transport.connect();
    const result = { state: transport.status.state, authenticated: controller.getSnapshot().authenticated,
      sameDraft: document.querySelector('textarea') === draft && draft.value === 'retained draft' };
    await transport.close(); client.close(); controller.dispose(); return result;
  });
  assert.deepEqual(recovered, { state: 'open', authenticated: true, sameDraft: true });
  assert.equal(grants, 3); assert.equal(rejected, 1); assert.equal(accepted, 3);
  await page.evaluate(() => { document.body.innerHTML = '<textarea>retained draft</textarea>'; });
  // Exhaust the default budget with expired claims while the bridge remains
  // reachable. Only shorten claim deadlines after the peer is connected.
  const saturated = await page.evaluate(async () => {
    const { connectWebSocketAppHost } = await import(/* @vite-ignore */ `${location.origin}/controller.js`);
    const client = connectWebSocketAppHost(undefined, { path: '/ssh-apphost', reportFailure: () => {} });
    const slow = client.createTransport('ssh:saturated'), peer = client.createTransport('ssh:peer');
    await peer.connect();
    const draft = document.querySelector('textarea');
    const originalTimer = window.setTimeout;
    window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => originalTimer(callback, delay === 30000 ? 5 : delay, ...args)) as typeof window.setTimeout;
    try {
      for (let index = 0; index < 256; index++) {
        try { await slow.connect(); throw new Error('stalled claim unexpectedly opened'); }
        catch (cause) { if (!(cause instanceof Error) || !cause.message.includes('host/connect timed out')) throw cause; }
      }
      let failure = '';
      try { await slow.connect(); } catch (cause) { failure = (cause as Error).message; }
      (window as any).saturationFixture = { client, slow, peer, draft };
      return { failure, peerState: peer.status.state, peerFailure: peer.status.failure };
    } finally { window.setTimeout = originalTimer; }
  });
  assert.deepEqual(saturated, { failure: 'App Host pending request limit reached', peerState: 'failed', peerFailure: { code: 'APP_HOST_REQUEST_LIMIT', recovery: 'automatic' } });
  saturationReady = true;
  const saturationRecovered = await page.evaluate(async () => {
    const { client, slow, peer, draft } = (window as any).saturationFixture;
    await Promise.all([slow.connect(), peer.connect()]);
    await peer.send('healthy forwarding after bridge renewal');
    const result = { slow: slow.status.state, peer: peer.status.state, sharedAttempt: slow.status.attemptId === peer.status.attemptId,
      sameDraft: draft === document.querySelector('textarea') && draft.value === 'retained draft' };
    await Promise.all([slow.close(), peer.close()]); client.close(); return result;
  });
  assert.deepEqual(saturationRecovered, { slow: 'open', peer: 'open', sharedAttempt: true, sameDraft: true });
  // Dispose one pending logical channel while its peer uses the same real socket.
  await page.evaluate(async () => {
    const { connectWebSocketAppHost } = await import(/* @vite-ignore */ `${location.origin}/controller.js`);
    const client = connectWebSocketAppHost(undefined, { path: '/ssh-apphost', reportFailure: () => {} });
    const retired = client.createTransport('ssh:held'), peer = client.createTransport('ssh:peer');
    const retiring = retired.connect().then(() => 'opened', () => 'rejected');
    (window as any).lateGrantFixture = { client, retired, peer, retiring };
    await peer.connect();
  });
  assert.ok(heldClaim);
  await page.evaluate(async () => { await (window as any).lateGrantFixture.retired.close(); });
  const claim = heldClaim as { leaseId: string; grant(): void };
  claim.grant();
  const closed = await page.evaluate(async () => {
    const { retired, peer, retiring } = (window as any).lateGrantFixture;
    return { retired: retired.status.state, peer: peer.status.state, result: await retiring };
  });
  assert.deepEqual(closed, { retired: 'closed', peer: 'open', result: 'rejected' });
  const deadline = Date.now() + 5000;
  while (!releasedClaims.has(claim.leaseId) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(releasedClaims.has(claim.leaseId), 'late grant must release the retired channel claim');
  await page.evaluate(async () => {
    const { client, peer } = (window as any).lateGrantFixture; await peer.close(); client.close();
  });
  console.log(JSON.stringify({ browser: 'Chromium', referrerPolicy: 'no-referrer', originalGrantRejected: true, currentOriginRenewed: true, webSocketAdmitted: true, leaseEpochStable: true, legacyCookiePreserved: true, saturationRecovered, lateGrantReleased: true, backendRestartRecoveredWithoutDiscovery: true, sameDraft: true, grants, originFreeStatus }));
  await context.close();
} finally {
  await browser.close(); sockets.close(); plain.closeAllConnections(); secure.closeAllConnections();
  await Promise.all([new Promise<void>(r => plain.close(() => r())), new Promise<void>(r => secure.close(() => r()))]);
  management.close(); await rm(directory, { recursive: true, force: true });
}
