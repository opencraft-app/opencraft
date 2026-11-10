import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createCodexPreview } from './fixtures/codex-preview.js';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';

test('Codex bridge continues one native tool/turn across gateway SIGKILL and durable input evidence replays once', async t => {
  const fixture = await createCodexPreview();
  const seed = fixture.createTransport(), seedFrames: any[] = [];
  await seed.connect(); seed.subscribeMessage(raw => seedFrames.push(JSON.parse(raw)));
  let sequence = 0, child: ChildProcess | undefined;
  const init = { capabilities: { extensions: { 'opencraft/steer-evidence': { version: 1 } } } };
  const seedRequest = async (method: string, params: unknown) => {
    const id = `seed:${++sequence}`; await seed.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: 'seed' }));
    const frame = seedFrames.find(f => f.id === id); assert(frame); assert.equal(frame.error, undefined); return frame.result;
  };
  const stop = async (proc?: ChildProcess) => { if (!proc || proc.exitCode !== null || proc.signalCode !== null) return; const done = once(proc, 'exit'); proc.send('close'); await done; };
  t.after(async () => { await stop(child); await seed.close(); await fixture.close(); });
  await seedRequest('initialize', init);
  await seedRequest('thread/start', { cwd: '/remote', agentBridge: { threadId: 'preview', clientRequestId: 'create' } });
  const started = await seedRequest('turn/start', { threadId: fixture.publicId, clientUserMessageId: 'start', input: [{ type: 'text', text: 'run once' }] });
  const turnId = started.turn.id; await seed.close();
  const frames: any[] = [];
  const open = async () => {
    const proc = fork(resolve('tests/agent-bridge/fixtures/codex-gateway-process.ts'), { execArgv: ['--import', 'tsx'], stdio: ['ignore','ignore','pipe','ipc'], env: { ...process.env, P2A_GATEWAY_CONFIG: JSON.stringify(fixture.gatewayOptions) } });
    proc.on('message', frame => frames.push(frame));
    const [ready] = await once(proc, 'message'); assert(ready.ready); return proc;
  };
  const request = async (method: string, params: unknown) => {
    const id = `gateway:${++sequence}`, deadline = Date.now() + 10000;
    child!.send({ id, method, params });
    while (Date.now() < deadline) { const frame = frames.find(f => f.id === id); if (frame) { assert.equal(frame.error, undefined, JSON.stringify(frame.error)); return frame.result; } await new Promise(r => setTimeout(r, 15)); }
    throw Error('Gateway RPC timed out');
  };
  child = await open(); const beforePid = child.pid;
  await request('initialize', init); await request('thread/resume', { threadId: fixture.publicId });
  await request('turn/steer', { threadId: fixture.publicId, expectedTurnId: turnId, clientUserMessageId: 'steer', input: [{ type: 'text', text: 'finish once' }] });
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  fixture.confirm(); fixture.finish(); // native side progresses with no gateway
  child = await open(); assert.notEqual(child.pid, beforePid);
  await request('initialize', init); await request('thread/resume', { threadId: fixture.publicId });
  const history = await request('thread/read', { threadId: fixture.publicId, includeTurns: true });
  assert.equal(history.thread.turns[0].id, turnId); assert.equal(history.thread.turns[0].status, 'completed');
  assert.equal(history.thread.turns[0].items.filter((item: any) => item.clientId === 'steer').length, 1);
  const status = await request('opencraft/steer/status', { threadId: fixture.publicId });
  assert.equal(status.inputs.length, 1); assert.equal(status.inputs[0].evidence.value, 'context-confirmed');
  assert.deepEqual(fixture.counts(), { starts: 1, steers: 1 });
});
