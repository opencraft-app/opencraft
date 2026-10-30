import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile, readlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  assert.deepEqual(await readCodexGitNatives(db), [{ pid: process.pid, startTicks: processInfo.startTicks, incarnation: '["synthetic-generation",3]', threadEnvironment: 'CODEX_THREAD_ID' }]);
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
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: { ...process.env, OPENCRAFT_THREAD_ID: 'synthetic-thread' }, stdio: 'ignore' });
  await once(child, 'spawn');
  t.after(async () => { const closed = once(child, 'close'); child.kill(); await closed; });
  const native = await readGitProcess(process.pid), inputs: Array<{ bootId?: string; startedAtBootMs?: number; startedAtMs: number }> = [];
  const natives = async () => [{ pid: native.pid, startTicks: native.startTicks, incarnation: 'synthetic-native', threadEnvironment: 'OPENCRAFT_THREAD_ID' as const }];
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

test('parallel Threads in one native cannot claim each other through a wrapper locator', async t => {
  const children = ['thread-A', 'thread-B', undefined].map(threadId => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    env: { ...process.env, OPENCRAFT_THREAD_ID: threadId }, stdio: 'ignore',
  }));
  await Promise.all(children.map(child => once(child, 'spawn')));
  t.after(async () => { await Promise.all(children.map(async child => { const closed = once(child, 'close'); child.kill(); await closed; })); });
  const native = await readGitProcess(process.pid), queried: string[] = [];
  const resolve = createGitOriginResolver({ natives: async () => [{ pid: native.pid, startTicks: native.startTicks, incarnation: 'shared-native', threadEnvironment: 'OPENCRAFT_THREAD_ID' as const }],
    reader: { originClock: 'boot-monotonic-v1', resolveJobOrigin(input) {
      queried.push(input.threadId);
      if (input.threadId === 'unowned-thread') return { status: 'unowned', lease: { executionId: 'system', principal: null } };
      return { status: 'active', lease: { executionId: input.threadId, principal: { provider: 'synthetic', subject: input.threadId } } };
    } }, account: p => p.subject });
  const peer = (i: number) => ({ pid: children[i]!.pid!, uid: process.getuid!() });
  assert.deepEqual(await resolve(peer(0), 'thread-B'), { status: 'unknown' });
  assert.deepEqual(await resolve(peer(1), 'thread-A'), { status: 'unknown' });
  assert.deepEqual(await resolve(peer(0), 'unowned-thread'), { status: 'unknown' });
  assert.deepEqual(await resolve(peer(2), 'thread-A'), { status: 'unknown' });
  assert.deepEqual(queried, [], 'a caller locator or missing native metadata cannot select an employee lease');
  assert.equal((await resolve(peer(0), 'thread-A')).status, 'active');
  assert.equal((await resolve(peer(1), 'thread-B')).status, 'active');
  assert.deepEqual(queried, ['thread-A', 'thread-B']);
});

test('registry npm transport resolves its native child while retaining generation lease identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'registry-git-cli-'));
  const cli = join(root, '@openai/codex/bin/codex.js');
  await mkdir(join(root, '@openai/codex/bin'), { recursive: true });
  await writeFile(join(root, 'app-server'), 'setInterval(()=>{},1000)');
  await writeFile(cli, `const {spawn}=require('node:child_process');const c=spawn(process.execPath,process.argv.slice(2),{stdio:'ignore'});console.log(c.pid);process.on('SIGTERM',()=>{c.kill();process.exit()});setInterval(()=>{},1000)`);
  const child = spawn(process.execPath, [cli, 'app-server'], { cwd: root, stdio: ['ignore','pipe','ignore'] });
  t.after(async () => { const closed = once(child, 'close'); child.kill(); await closed; await rm(root,{recursive:true,force:true}); });
  const [chunk] = await once(child.stdout!, 'data'), nativePid = Number(String(chunk).trim());
  const db = new DatabaseSync(':memory:'); t.after(()=>db.close());
  db.exec('CREATE TABLE generations(id TEXT,incarnation INTEGER,state TEXT,definition TEXT); CREATE TABLE routing_metadata(key TEXT,value TEXT)');
  const native = await readGitProcess(child.pid!), owner = await readGitProcess(process.pid);
  const executable = await readlink(`/proc/${native.pid}/exe`);
  db.prepare('INSERT INTO generations VALUES(?,?,?,?)').run('npm-generation',7,'active',JSON.stringify({executable,executionUid:process.getuid!()}));
  db.prepare('INSERT INTO routing_metadata VALUES(?,?)').run('runtime:npm-generation',JSON.stringify({nativePid:native.pid,nativeStart:native.startTicks,ownerPid:owner.pid,ownerStart:owner.startTicks,cliSha256:createHash('sha256').update(await readFile(executable)).digest('hex')}));
  assert.deepEqual(await readCodexGitNatives(db),[{pid:nativePid,startTicks:(await readGitProcess(nativePid)).startTicks,incarnation:'["npm-generation",7]',threadEnvironment:'CODEX_THREAD_ID'}]);
  process.kill(nativePid); await new Promise(resolve=>setTimeout(resolve,50));
  assert.deepEqual(await readCodexGitNatives(db),[], 'missing native must not authorize npm transport as a tool root');
});
