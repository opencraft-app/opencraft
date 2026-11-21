import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { APP_HOST_PROTOCOL_VERSION } from '@opencraft/app-host-protocol/version';
import { createWorkbenchWebServer } from '../../apps/headless-server/src/serve-workbench-web.mjs';

const until = async (ready: () => boolean, label = 'condition') => {
  const deadline = Date.now() + 3_000;
  while (!ready() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(ready(), label);
};

async function fixture(t: test.TestContext, options: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'oc-resume-server-'));
  const contexts: any[] = [], connections: any[] = [], logs: any[] = [], peers: WebSocket[] = [];
  const appHostServer = { accept(port: any, renderer: string, context: any) {
    const connection = { port, renderer, context, received: [] as any[], closes: 0, close() {
      if (connection.closes) return;
      connection.closes++; unsubscribe(); port.close();
    } };
    const unsubscribe = port.subscribe((message: any) => {
      connection.received.push(message);
      if (message.type === 'host/connect' || message.type === 'host/send' || message.type === 'connection/probe') {
        port.postMessage({ type: 'response', requestId: message.requestId, ok: true, result: { hostId: message.hostId, generation: 1 } });
      }
    });
    connections.push(connection); contexts.push(context);
    port.postMessage({ type: 'ready', protocolVersion: APP_HOST_PROTOCOL_VERSION, services: ['appserver'], capabilities: { connectionProbe: true } });
    return connection;
  } };
  const server = await createWorkbenchWebServer({ root, appServerTarget: null, appHostServer,
    webSocketHeartbeatIntervalMs: 0, appHostResumeEnabled: true, onAppHostDiagnostic: (entry: any) => logs.push(entry), ...options });
  const address = await server.listen({ host: '127.0.0.1', port: 0 }) as { port: number };
  let closing: Promise<void> | undefined;
  const close = (update?: unknown) => closing ??= server.close(update);
  t.after(async () => { for (const peer of peers) peer.terminate(); await close(); await rm(root, { recursive: true, force: true }); });
  async function connect(resume: unknown = { v: 1 }, renderer = 'renderer-one', headers?: Record<string, string>, hello: Record<string, unknown> = {}, path = "/apphost") {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, { headers });
    peers.push(socket); const messages: any[] = [];
    socket.on('message', raw => messages.push(JSON.parse(String(raw))));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: renderer, ...(resume === null ? {} : { resume }), ...hello }));
    await until(() => messages.length > 0, 'handshake response');
    return { socket, messages, send(message: unknown) { socket.send(JSON.stringify(message)); } };
  }
  return { connect, connections, contexts, logs, server, address, close };
}
const request = (id: string, seq?: number) => ({ type: 'host/connect', requestId: id, hostId: 'local-codex', leaseId: 'lease-one', ...(seq === undefined ? {} : { seq }) });

test('actual WebSocket route resumes the same Host connection and replays only unseen output without repeating input', async t => {
  const f = await fixture(t), first = await f.connect();
  const grant = first.messages[0].capabilities.resume;
  assert.equal(grant.v, 1); assert.equal(f.connections.length, 1);
  first.send(request('first', 1)); await until(() => first.messages.some(message => message.requestId === 'first'));
  assert.equal(first.messages.find(message => message.requestId === 'first').seq, 1);
  first.socket.terminate(); await until(() => f.logs.some(entry => entry.event === 'resume-detached'));
  assert.equal(f.connections[0].closes, 0);
  f.connections[0].port.postMessage({ type: 'host/status', hostId: 'local-codex', generation: 1, status: { state: 'open' } });
  const next = await f.connect({ ...grant, received: 0, detachMs: undefined });
  assert.equal(next.messages[0].type, 'connection/resumed'); assert.equal(next.messages[0].received, 1);
  await until(() => next.messages.some(message => message.seq === 2));
  assert.deepEqual(next.messages.filter(message => message.seq).map(message => message.seq), [1, 2]);
  assert.equal(f.connections.length, 1);
  next.send(request('first', 1));
  next.send(request('second', 2)); await until(() => next.messages.some(message => message.requestId === 'second'));
  assert.equal(f.connections[0].received.filter((message: any) => message.requestId === 'first').length, 1);
  assert.equal(f.connections[0].received.filter((message: any) => message.requestId === 'second').length, 1);
  assert.doesNotThrow(() => f.contexts[0].resourceOwner.assertCurrent(), 'authority follows the new carrier socket');
  next.send({ type: 'connection/end' }); await until(() => f.connections[0].closes === 1);
  // A retired backend cannot refill a forgotten replay owner.
  assert.doesNotThrow(() => f.connections[0].port.postMessage({ type: 'late-output' }));
});

test('legacy clients remain connection-scoped and registry capacity falls back without evicting an owner', async t => {
  const f = await fixture(t, { appHostResumeOptions: { maxSessions: 1 } });
  const resumable = await f.connect(); assert.ok(resumable.messages[0].capabilities.resume);
  const saturated = await f.connect({ v: 1 }, 'renderer-two'); assert.equal(saturated.messages[0].capabilities.resume, undefined);
  assert.equal(f.connections[0].closes, 0); saturated.send(request('legacy'));
  await until(() => saturated.messages.some(message => message.requestId === 'legacy'));
  saturated.socket.terminate(); await until(() => f.connections[1].closes === 1);
  assert.equal(f.connections[0].closes, 0);
  const legacy = await f.connect(null, 'renderer-three'); assert.equal(legacy.messages[0].capabilities.resume, undefined);
  legacy.socket.terminate(); await until(() => f.connections[2].closes === 1);
});

test('a valid resume token cannot move a session to a different renderer identity', async t => {
  const f = await fixture(t), first = await f.connect(), grant = first.messages[0].capabilities.resume;
  first.socket.terminate(); await until(() => f.logs.some(entry => entry.event === 'resume-detached'));
  const wrong = await f.connect({ v: 1, sessionId: grant.sessionId, token: grant.token, received: 0 }, 'another-renderer');
  assert.equal(wrong.messages[0].type, 'connection/resume-failed'); assert.equal(wrong.messages[0].reason, 'identity');
  assert.equal(f.connections[0].closes, 0);
  const right = await f.connect({ v: 1, sessionId: grant.sessionId, token: grant.token, received: 0 });
  assert.equal(right.messages[0].type, 'connection/resumed'); assert.equal(f.connections.length, 1);
});

test('negotiated numbered data cannot bypass sequencing and policy closure does not leave a resumable session', async t => {
  const f = await fixture(t), first = await f.connect(), grant = first.messages[0].capabilities.resume;
  first.send(request('missing-sequence'));
  await until(() => first.socket.readyState === WebSocket.CLOSED);
  assert.equal(f.connections[0].closes, 1);
  assert.equal(f.connections[0].received.some((message: any) => message.requestId === 'missing-sequence'), false);
  const next = await f.connect({ v: 1, sessionId: grant.sessionId, token: grant.token, received: 0 });
  assert.equal(next.messages[0].type, 'connection/resume-failed'); assert.equal(next.messages[0].reason, 'unknown-session');
});

test('trusted identity and credential-expiry snapshots fence a token across identity changes', async t => {
  let expiry = Date.now() + 60_000;
  const identityService = {
    admissionStatus: () => 204, handle: async () => false,
    connectionContext(request: any) {
      return { sender: { kind: 'employee', loginName: request.headers['x-test-identity'] ?? 'one' },
        executionPrincipal: { provider: 'fixture', subject: request.headers['x-test-identity'] ?? 'one' }, validUntil: expiry };
    },
  };
  const f = await fixture(t, { identityService }), first = await f.connect();
  const grant = first.messages[0].capabilities.resume;
  first.socket.terminate(); await until(() => f.logs.some(entry => entry.event === 'resume-detached'));
  const attempt = { v: 1, sessionId: grant.sessionId, token: grant.token, received: 0 };
  const other = await f.connect(attempt, 'renderer-one', { 'x-test-identity': 'two' });
  assert.equal(other.messages[0].reason, 'identity'); assert.equal(f.connections.length, 1);
  expiry += 10_000;
  const renewed = await f.connect(attempt);
  assert.equal(renewed.messages[0].reason, 'identity', 'fresh credential lifetime requires a fresh connection context');
  const fresh = await f.connect(); assert.equal(f.connections.length, 2); assert.equal(fresh.messages[0].type, 'ready');
  assert.equal(JSON.stringify(f.logs).includes(grant.token), false, 'bearer grants never enter diagnostics');
});

test('a resume token never bypasses the next HTTP admission decision', async t => {
  let admitted = true;
  const identityService = { admissionStatus: () => admitted ? 204 : 403, connectionContext: () => ({ sender: null }), handle: async () => false };
  const f = await fixture(t, { identityService }), first = await f.connect();
  first.socket.terminate(); await until(() => f.logs.some(entry => entry.event === 'resume-detached'));
  admitted = false;
  const rejected = new WebSocket(`ws://127.0.0.1:${f.address.port}/apphost`);
  const status = await new Promise<number>((resolve, reject) => {
    rejected.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); rejected.terminate(); });
    rejected.once('open', () => reject(Error('Admission unexpectedly opened')));
    rejected.once('error', () => {});
  });
  assert.equal(status, 403); assert.equal(f.connections.length, 1);
  assert.equal(f.connections[0].closes, 0, 'a denied fresh peer does not steal or destroy another session');
});

test('detached lifetime cannot extend the original trusted identity deadline', async t => {
  const expiresAt = Date.now() + 1_500;
  const identityService = { admissionStatus: () => 204, connectionContext: () => ({ sender: null, validUntil: expiresAt }), handle: async () => false };
  const f = await fixture(t, { identityService }), first = await f.connect();
  first.socket.terminate(); await until(() => f.logs.some(entry => entry.event === 'resume-detached'));
  assert.equal(f.connections[0].closes, 0);
  await until(() => f.connections[0].closes === 1, 'identity deadline retires the detached Host connection');
  assert.ok(f.logs.some(entry => entry.event === 'resume-ended' && ['detach-expired', 'access-expired'].includes(entry.reason)));
});

test('overflow while detached releases the Host owner and falls back rather than replaying a gap', async t => {
  const f = await fixture(t, { appHostResumeOptions: { sessionMaxBytes: 100 } }), first = await f.connect();
  const grant = first.messages[0].capabilities.resume;
  first.socket.terminate(); await until(() => f.logs.some(entry => entry.event === 'resume-detached'));
  f.connections[0].port.postMessage({ type: 'host/status', hostId: 'local-codex', generation: 1, status: { state: 'open', reason: 'x'.repeat(500) } });
  await until(() => f.connections[0].closes === 1);
  const next = await f.connect({ v: 1, sessionId: grant.sessionId, token: grant.token, received: 0 });
  assert.equal(next.messages[0].reason, 'unknown-session');
});

test('release shutdown preserves restart close code and ends both live and detached session owners', async t => {
  const f = await fixture(t), detached = await f.connect(), live = await f.connect({ v: 1 }, 'second-renderer');
  detached.socket.terminate(); await until(() => f.logs.some(entry => entry.event === 'resume-detached'));
  const code = new Promise<number>(resolve => live.socket.once('close', resolve));
  await f.close({ kind: 'fixture-update' });
  assert.equal(await code, 1012);
  assert.deepEqual(f.connections.map(connection => connection.closes), [1, 1]);
});

test('explicitly disabled resumption preserves legacy framing even when a client asks for a grant', async t => {
  const f = await fixture(t, { appHostResumeEnabled: false }), peer = await f.connect();
  assert.equal(peer.messages[0].capabilities.resume, undefined);
  peer.send(request('legacy'));
  await until(() => peer.messages.some(message => message.requestId === 'legacy'));
  assert.equal(peer.messages.find(message => message.requestId === 'legacy').seq, undefined);
  peer.socket.terminate(); await until(() => f.connections[0].closes === 1);
});

test('opt-in heartbeat frames stay outside the sequenced application stream', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t), peer = await f.connect({ v: 1 }, 'renderer-one', undefined, { heartbeat: true });
  assert.equal(peer.messages[0].capabilities.heartbeatMs, 10_000);
  t.mock.timers.tick(10_000);
  await until(() => peer.messages.some(message => message.type === 'connection/heartbeat'));
  assert.equal(peer.messages.find(message => message.type === 'connection/heartbeat').seq, undefined);
  peer.send(request('first', 1));
  await until(() => peer.messages.some(message => message.requestId === 'first'));
  assert.equal(peer.messages.find(message => message.requestId === 'first').seq, 1);
});

test('authority watches follow the logical session while detached and stale watches cannot retire its successor', async t => {
  let allowed = true, proof: string | null = null;
  const watches = new Set<() => void>();
  const actor = { actorId: 'fixture-human', credentialId: null, generation: 1, expiresAt: Date.now() + 60_000 };
  const actorService = {
    isSessionRequest: () => false, legacyAdmissionStatus: (request: any) => allowed && (request.headers['x-fixture-proof'] ?? null) === proof ? 204 : 403,
    authenticate: () => actor, usageAuthority: () => ({ actorId: actor.actorId, administrator: false }),
    watch(_request: unknown, listener: () => void) { watches.add(listener); return () => watches.delete(listener); },
  };
  const f = await fixture(t, { actorService }), first = await f.connect(), grant = first.messages[0].capabilities.resume;
  const oldWatch = [...watches][0];
  first.socket.terminate(); await until(() => f.logs.some(entry => entry.event === 'resume-detached'));
  assert.equal(watches.size, 1, 'physical detach does not abandon revocation responsibility');
  proof = 'fresh';
  const next = await f.connect({ v: 1, sessionId: grant.sessionId, token: grant.token, received: 0 }, 'renderer-one', { 'x-fixture-proof': proof });
  assert.equal(next.messages[0].type, 'connection/resumed'); assert.equal(watches.size, 1);
  oldWatch(); assert.equal(f.connections[0].closes, 0, 'late old watch has lost retirement authority');
  assert.doesNotThrow(() => f.contexts[0].resourceOwner.assertCurrent(), 'resource context checks the fresh request, not its superseded credential proof');
  next.send(request('after-resume', 1)); await until(() => next.messages.some(message => message.requestId === 'after-resume'));
  allowed = false; for (const watch of [...watches]) watch();
  await until(() => f.connections[0].closes === 1);
  assert.equal(watches.size, 0); await until(() => next.socket.readyState === WebSocket.CLOSED);
});

test('private SSH revocation also retires a detached session with no intervening output', async t => {
  let allowed = true;
  const watches = new Set<() => void>();
  const sshManagement = { options: {}, sameOrigin: () => true, authorized: () => allowed,
    onRevocation(listener: () => void) { watches.add(listener); return () => watches.delete(listener); } };
  const f = await fixture(t, { sshManagement }), first = await f.connect({ v: 1 }, 'renderer-one', undefined, {}, '/ssh-apphost');
  first.socket.terminate(); await until(() => f.logs.some(entry => entry.event === 'resume-detached'));
  assert.equal(f.connections[0].closes, 0);
  allowed = false; for (const watch of [...watches]) watch();
  await until(() => f.connections[0].closes === 1, 'revocation reaches a detached logical owner immediately');
});

test('half-open physical takeover cannot let the old close retire the adopted logical connection', async t => {
  const f = await fixture(t), first = await f.connect(), grant = first.messages[0].capabilities.resume;
  first.send(request('first', 1)); await until(() => first.messages.some(message => message.requestId === 'first'));
  const next = await f.connect({ v: 1, sessionId: grant.sessionId, token: grant.token, received: 1 });
  await until(() => first.socket.readyState === WebSocket.CLOSED);
  assert.equal(next.messages[0].type, 'connection/resumed'); assert.equal(f.connections.length, 1);
  assert.equal(f.connections[0].closes, 0);
  assert.doesNotThrow(() => f.contexts[0].resourceOwner.assertCurrent());
  next.send(request('next', 2)); await until(() => next.messages.some(message => message.requestId === 'next'));
  assert.equal(f.connections[0].received.filter((message: any) => message.requestId === 'first').length, 1);
});

for (const frame of [{ type: 'connection/ack', received: 99 }, request('gap', 2), request('invalid', 0)]) {
  test(`invalid negotiated sequence/control closes the logical session before Host admission: ${JSON.stringify(frame)}`, async t => {
    const f = await fixture(t), peer = await f.connect();
    peer.send(frame); await until(() => peer.socket.readyState === WebSocket.CLOSED);
    assert.equal(f.connections[0].closes, 1);
    assert.equal(f.connections[0].received.some((message: any) => message.type === 'host/connect'), false);
  });
}
