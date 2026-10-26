import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, readlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import nodeTest from 'node:test';
import { createGitOriginResolver, readCodexGitNatives } from '../../scripts/git-identity-origin';
import { readGitProcess } from '../../scripts/git-identity-broker';
const test = process.platform === 'linux' ? nodeTest : nodeTest.skip;

test('native origin is attested against registry PID, start, executable and hash', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE generations(id TEXT,incarnation INTEGER,state TEXT,definition TEXT); CREATE TABLE routing_metadata(key TEXT,value TEXT)');
  const processInfo = await readGitProcess(process.pid), owner = await readGitProcess(processInfo.parent);
  const executable = await readlink(`/proc/${process.pid}/exe`), cliSha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
  db.prepare('INSERT INTO generations VALUES(?,?,?,?)').run('synthetic-generation', 3, 'active', JSON.stringify({ executable, executionUid: process.getuid!() }));
  const identity = { nativePid: process.pid, nativeStart: processInfo.startTicks, ownerPid: owner.pid, ownerStart: owner.startTicks, cliSha256 };
  const write = (value: unknown) => db.prepare('INSERT OR REPLACE INTO routing_metadata(rowid,key,value) VALUES(1,?,?)').run('runtime:synthetic-generation', JSON.stringify(value));
  write(identity);
  assert.deepEqual(await readCodexGitNatives(db), [{ pid: process.pid, startTicks: processInfo.startTicks, incarnation: '["synthetic-generation",3]' }]);
  write({ ...identity, nativeStart: 'wrong' }); assert.deepEqual(await readCodexGitNatives(db), []);
  write({ ...identity, cliSha256: 'wrong' }); assert.deepEqual(await readCodexGitNatives(db), []);
});
test('claimed thread/incarnation alone cannot authorize a job', async () => {
  let called = false;
  const resolve = createGitOriginResolver({ natives: async () => [], reader: { originClock: 'boot-monotonic-v1', resolveJobOrigin() { called = true; return { status: 'unknown' }; } }, account: p => p.subject });
  assert.deepEqual(await resolve({ pid: process.pid, uid: process.getuid!() }, 'another-employee-thread'), { status: 'unknown' });
  assert.equal(called, false);
});

test('a real peer uses boot time across wall-clock jumps and rejects epoch-only readers', async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  t.after(async () => { const closed = once(child, 'close'); child.kill(); await closed; });
  const native = await readGitProcess(process.pid), inputs: Array<{ bootId?: string; startedAtBootMs?: number; startedAtMs: number }> = [];
  const natives = async () => [{ pid: native.pid, startTicks: native.startTicks, incarnation: 'synthetic-native' }];
  const resolve = createGitOriginResolver({ natives, reader: { originClock: 'boot-monotonic-v1', resolveJobOrigin(input) {
    inputs.push(input);
    return { status: 'active', lease: { executionId: 'synthetic-original-turn', principal: { provider: 'synthetic', subject: '1' } } };
  } }, account: p => p.subject });
  const peer = { pid: child.pid!, uid: process.getuid!() };
  assert.deepEqual(await resolve(peer, 'synthetic-thread'), { status: 'active', account: '1', executionId: 'synthetic-original-turn' });
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 86_400_000;
    assert.equal((await resolve(peer, 'synthetic-thread')).status, 'active');
  } finally { Date.now = originalNow; }
  assert.equal(inputs.length, 2);
  assert.match(inputs[0]!.bootId!, /^[0-9a-f-]{36}$/u);
  assert.equal(inputs[0]!.bootId, inputs[1]!.bootId);
  assert.ok(inputs[0]!.startedAtBootMs! > 0);
  assert.equal(inputs[0]!.startedAtBootMs, inputs[1]!.startedAtBootMs);
  assert.ok(inputs[1]!.startedAtMs - inputs[0]!.startedAtMs > 86_399_000);
  let called = false;
  const old = createGitOriginResolver({ natives, reader: { resolveJobOrigin() { called = true; return { status: 'unowned' }; } }, account: () => null });
  assert.deepEqual(await old(peer, 'synthetic-thread'), { status: 'unknown' });
  assert.equal(called, false, 'an epoch-only reader cannot grant personal or server fallback authority');
});
