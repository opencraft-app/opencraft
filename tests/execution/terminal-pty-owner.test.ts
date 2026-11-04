import assert from 'node:assert/strict';
import test from 'node:test';
import { fork, type ChildProcess } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DurableHostProcessService } from '../../apps/local-agent-host/src/durable-process-service.js';
import { startTerminalPtyOwner } from '../../apps/local-agent-host/src/terminal-pty-owner.js';
import { terminalOwnerLocation } from '../../apps/local-agent-host/src/terminal-owner-runtime.js';
import { readOwnerFrames, sendOwnerFrame, TERMINAL_OWNER_PROTOCOL } from '../../apps/local-agent-host/src/terminal-owner-wire.js';

const scope = { account: 'alice', hostId: 'host', projectId: 'project', threadId: 'thread' };
const spawnParams = (id: string, command = ['/bin/bash', '--noprofile', '--norc']) => ({ processHandle: id, tty: true,
  command, cwd: '/tmp', size: { cols: 80, rows: 24 }, resourceOwnerId: 'conversation' });
const decode = (snapshot: any) => snapshot.output.map((chunk: any) => Buffer.from(chunk.deltaBase64, 'base64').toString()).join('');
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 15_000;
  for (;;) { const value = await read(); if (predicate(value)) return value; if (Date.now() > end) throw new Error('Terminal owner test timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function ownerPid(endpoint: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint), timer = setTimeout(() => { socket.destroy(); reject(new Error('Greeting timed out')); }, 5000);
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once('connect', () => sendOwnerFrame(socket, { type: 'attach', protocol: TERMINAL_OWNER_PROTOCOL }));
    readOwnerFrames(socket, message => { clearTimeout(timer); socket.destroy(); assert.equal(message.type, 'attached'); resolve(message.pid); });
  });
}
async function peer(directory: string) {
  const child = fork(new URL('./fixtures/terminal-host-peer.ts', import.meta.url), [directory], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { ...process.env, INVOCATION_ID: '' },
  });
  let id = 0;
  await new Promise<void>((resolve, reject) => { child.once('message', message => (message as any).ready ? resolve() : reject(new Error('Peer failed'))); child.once('error', reject); });
  return { child, call(method: string, params: unknown = {}, identity = scope): Promise<any> {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const receive = (message: any) => {
        if (message.id !== requestId) return;
        clearTimeout(timer); child.off('message', receive);
        if (message.error) reject(new Error(message.error)); else resolve(message.result);
      };
      const timer = setTimeout(() => { child.off('message', receive); reject(new Error('Peer request timeout')); }, 20_000);
      child.on('message', receive); child.send({ id: requestId, method, params, scope: identity });
    });
  } };
}
async function stopPeer(child: ChildProcess) { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }

test('real Host process restart preserves shell PID, environment, detached output, resize and explicit termination', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pty-host-restart-')), location = await terminalOwnerLocation(directory);
  const first = await peer(directory); let second: Awaited<ReturnType<typeof peer>> | undefined, pid: number | undefined;
  t.after(async () => { await stopPeer(first.child); if (second) await stopPeer(second.child); if (pid) process.kill(pid, 'SIGTERM'); await rm(directory, { recursive: true, force: true }); await rm(join(location.endpoint, '..'), { recursive: true, force: true }); });
  await first.call('process/spawn', spawnParams('kept'));
  pid = await ownerPid(location.endpoint);
  assert.notEqual(pid, first.child.pid);
  await first.call('process/writeStdin', { processHandle: 'kept', deltaBase64: Buffer.from("export KEPT=survives; printf 'ORIGINAL_PID=%s VALUE=%s\\n' $$ \"$TERMINAL_TEST_VALUE\"; (sleep 0.3; printf 'WHILE_HOST_ABSENT\\n') &\n").toString('base64') });
  const original = await until(() => first.call('process/attach', { processHandle: 'kept', afterSequence: 0 }), snap => /ORIGINAL_PID=\d+ VALUE=alice:project/.test(decode(snap)));
  const shellPid = decode(original).match(/ORIGINAL_PID=(\d+) VALUE=alice:project/)![1];
  await stopPeer(first.child);
  await new Promise(resolve => setTimeout(resolve, 500));
  second = await peer(directory);
  const listed = await second.call('process/list'); assert.equal(listed.processes[0].context.resourceOwnerId, 'conversation');
  assert.equal(await ownerPid(location.endpoint), pid);
  const recovered = await second.call('process/attach', { processHandle: 'kept', afterSequence: original.nextSequence });
  assert.match(decode(recovered), /WHILE_HOST_ABSENT/);
  await second.call('process/resizePty', { processHandle: 'kept', size: { cols: 101, rows: 33 } });
  await second.call('process/writeStdin', { processHandle: 'kept', deltaBase64: Buffer.from("printf 'RESTORED_PID=%s KEPT=%s\\n' $$ \"$KEPT\"; stty size\n").toString('base64') });
  const checked = await until(() => second!.call('process/attach', { processHandle: 'kept', afterSequence: recovered.nextSequence }), snap => decode(snap).includes('33 101'));
  assert.match(decode(checked), new RegExp(`RESTORED_PID=${shellPid} KEPT=survives`));
  await assert.rejects(second.call('process/attach', { processHandle: 'kept', afterSequence: 0 }, { ...scope, account: 'bob' }));
  await assert.rejects(second.call('process/kill', { processHandle: 'kept' }, { ...scope, projectId: 'other' }));
  await second.call('process/kill', { processHandle: 'kept' });
  await until(() => second!.call('process/attach', { processHandle: 'kept', afterSequence: 0 }), snap => snap.phase === 'exited');
});

test('concurrent Host adapters share one owner and account quota; disconnect does not free capacity', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pty-owner-quota-')), location = await terminalOwnerLocation(directory);
  const stop = await startTerminalPtyOwner(location.directory, location.endpoint);
  const env = { snapshot: (scope: any) => ({ owner: JSON.stringify([scope.account, scope.hostId, scope.projectId]), apply: (values: any) => values, overlay: () => ({}) }) } as any;
  const a = new DurableHostProcessService(directory, env), b = new DurableHostProcessService(directory, env);
  t.after(async () => { a.close(); b.close(); await stop(); await rm(directory, { recursive: true, force: true }); await rm(join(location.endpoint, '..'), { recursive: true, force: true }); });
  await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? a : b).dispatch('process/spawn', spawnParams('p-' + i), scope)));
  assert.equal((await a.dispatch('process/list', {}, scope) as any).processes.length, 16);
  a.close();
  await assert.rejects(b.dispatch('process/spawn', spawnParams('over'), { ...scope, projectId: 'another' }), /limit reached/);
  await assert.rejects(b.dispatch('process/spawn', { ...spawnParams('override'), env: { X: true } }, { ...scope, account: 'bob' }));
  assert.equal((await b.dispatch('process/list', {}, { ...scope, account: 'bob' }) as any).processes.length, 0);
  const info = await stat(location.endpoint); assert.equal(info.mode & 0o077, 0);
  await assert.rejects(startTerminalPtyOwner(location.directory, location.endpoint), /lock/i);
});

test('closing during lazy owner attachment cannot revive Host; stale authority cannot send after connection setup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pty-owner-close-')), location = await terminalOwnerLocation(directory);
  const stop = await startTerminalPtyOwner(location.directory, location.endpoint);
  const service = new DurableHostProcessService(directory);
  t.after(async () => { service.close(); await stop(); await rm(directory, { recursive: true, force: true }); await rm(join(location.endpoint, '..'), { recursive: true, force: true }); });
  await assert.rejects(service.dispatch('process/spawn', spawnParams('stale'), undefined, () => { throw new Error('retired authority'); }), /retired authority/);
  assert.equal((await service.dispatch('process/list', {}) as any).processes.length, 0);
  service.close(); await assert.rejects(service.dispatch('process/list', {}), /closed/);
});


test('explicit kill reclaims a shell that ignores HUP while Host detach never escalates', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pty-owner-hup-')), location = await terminalOwnerLocation(directory);
  const stop = await startTerminalPtyOwner(location.directory, location.endpoint);
  let service = new DurableHostProcessService(directory);
  t.after(async () => { service.close(); await stop(); await rm(directory, { recursive: true, force: true }); await rm(join(location.endpoint, '..'), { recursive: true, force: true }); });
  await service.dispatch('process/spawn', spawnParams('hup', ['/bin/sh', '-c', "trap '' HUP; printf READY; while :; do sleep 0.1; done"]));
  const attach = async () => await service.dispatch('process/attach', { processHandle: 'hup', afterSequence: 0 }) as any;
  await until(attach, snap => decode(snap).includes('READY'));
  service.close(); service = new DurableHostProcessService(directory);
  assert.equal((await attach()).phase, 'running');
  await service.dispatch('process/kill', { processHandle: 'hup' });
  await until(attach, snap => snap.phase === 'exited');
});


test('authorization forwarding is installed before output coalesced with an attach reply', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pty-owner-order-')), location = await terminalOwnerLocation(directory);
  const peers = new Set<any>();
  const server = createServer(socket => {
    peers.add(socket); socket.on('close', () => peers.delete(socket));
    readOwnerFrames(socket, message => {
      if (message.type === 'attach') sendOwnerFrame(socket, { type: 'attached', protocol: TERMINAL_OWNER_PROTOCOL });
      else socket.write(JSON.stringify({ id: message.id, result: { phase: 'running' } }) + '\n' +
        JSON.stringify({ method: 'process/outputDelta', params: { processHandle: 'ordered', sequence: 1, deltaBase64: 'b2s=' } }) + '\n');
    });
  });
  await new Promise<void>(resolve => server.listen(location.endpoint, resolve));
  const service = new DurableHostProcessService(directory);
  t.after(async () => { service.close(); for (const peer of peers) peer.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  let accepted = false; const observed: boolean[] = [];
  service.subscribe(() => observed.push(accepted));
  await service.dispatch('process/attach', { processHandle: 'ordered', afterSequence: 0 }, undefined, undefined, () => { accepted = true; });
  assert.deepEqual(observed, [true]);
});
