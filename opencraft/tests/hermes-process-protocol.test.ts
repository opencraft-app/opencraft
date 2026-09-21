import test from 'node:test';
import assert from 'node:assert/strict';
import { HermesTatTerminalService } from '../plugins/lightvela-hermes/src/hermes-appserver-bridge/tat-terminal';
import { HermesProcessService } from '../plugins/lightvela-hermes/src/hermes-appserver-bridge/process-service';
import { BrowserHermesAppServerBridge } from '../plugins/lightvela-hermes/src/hermes-appserver-bridge';
import { JsonRpcAppServerClient } from '@opencraft/appserver-client';
import { MemoryTransport } from '@opencraft/appserver-transport-memory';
import { AppServerTerminalController } from '@opencraft/workbench-runtime';

test('Hermes process protocol acknowledges readiness, forwards IO and survives bridge replacement', async () => {
  let handlers: any;
  let releaseReady!: () => void;
  let closed = 0;
  const input: string[] = [];
  const sizes: number[][] = [];
  const terminal = new HermesTatTerminalService({
    createSession: async () => ({} as any),
    createMultiplexer: () => ({ close() { closed++; }, async openPty(h: any) {
      handlers = h;
      await new Promise<void>(resolve => { releaseReady = resolve; });
      h.onOutput('prompt> ');
      return { sendInput(s: string) { input.push(s); return true; },
        resize(cols: number, rows: number) { sizes.push([cols, rows]); return true; }, release() {} };
    } } as any),
  });
  const processes = new HermesProcessService(terminal);
  const socket = Object.assign(new EventTarget(), { readyState: 1, send() {} });
  let bridge = new BrowserHermesAppServerBridge(socket, { processes });
  const events: any[] = [];
  bridge.onNotification(event => events.push(event));
  try {
    let acknowledged = false;
    const spawn = bridge.request('process/spawn', { processHandle: 'shell', command: ['/bin/bash'],
      tty: true, size: { cols: 80, rows: 24 } }).then(value => { acknowledged = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(acknowledged, false);
    releaseReady();
    assert.deepEqual(await spawn, { processHandle: 'shell' });
    await bridge.request('process/writeStdin', { processHandle: 'shell', deltaBase64: btoa('ls\r') });
    assert.deepEqual(input, ['ls\r']);
    assert.equal(events[0].method, 'process/outputDelta');
    assert.equal(events[0].params.sequence, 1);
    bridge.dispose();
    assert.equal(closed, 0, 'bridge does not own the PTY');
    handlers.onOutput('while disconnected');
    bridge = new BrowserHermesAppServerBridge(socket, { processes });
    const restored: any = await bridge.request('process/attach', { processHandle: 'shell', afterSequence: 1 });
    assert.equal(restored.output.length, 1);
    assert.equal(atob(restored.output[0].deltaBase64), 'while disconnected');
    await bridge.request('process/resizePty', { processHandle: 'shell', size: { cols: 100, rows: 30 } });
    assert.deepEqual(sizes.at(-1), [100, 30]);
    await bridge.request('process/kill', { processHandle: 'shell' });
    const result: any = await bridge.request('process/attach', { processHandle: 'shell', afterSequence: 2 });
    assert.equal(result.phase, 'exited');
    assert.equal(closed, 1);
    await assert.rejects(bridge.request('process/spawn', { processHandle: 'shell' }), /already exists/);
  } finally { bridge.dispose(); processes.dispose(); }
});

test('PTY startup failure rejects spawn instead of reporting a running shell', async () => {
  const processes = new HermesProcessService(new HermesTatTerminalService({ createSession: async () => { throw new Error('denied'); } }));
  try {
    await assert.rejects(processes.dispatch('process/spawn', { processHandle: 'bad', command: ['bash'] }), /denied/);
    assert.deepEqual(await processes.dispatch('process/list', {}), { processes: [] });
  } finally { processes.dispose(); }
});

test('shared terminal controller talks to the actual Hermes dispatcher', async () => {
  const terminal = new HermesTatTerminalService({
    createSession: async () => ({} as any),
    createMultiplexer: () => ({ close() {}, async openPty(h: any) {
      return { release() {}, resize() { return true; }, sendInput(s: string) { h.onOutput(s); return true; } };
    } } as any),
  });
  const processes = new HermesProcessService(terminal);
  const bridge = new BrowserHermesAppServerBridge(Object.assign(new EventTarget(), { readyState: 1, send() {} }), { processes });
  let remove = () => {};
  const client = new JsonRpcAppServerClient({ hostId: 'hermes', transport: new MemoryTransport({
    connected(peer) { remove = bridge.onNotification(event => peer.send(JSON.stringify(event))); },
    async receive(frame, peer) { peer.send(JSON.stringify(await bridge.handle(JSON.parse(frame)))); },
  }) });
  await client.connect({ clientInfo: { name: 'hermes-terminal-test', version: '1' } });
  const controller = new AppServerTerminalController('hermes', client);
  try {
    const session = controller.open({ command: ['/bin/bash'], cols: 80, rows: 24 });
    await session.write(btoa('echo hello\r'));
    assert.equal(session.getSnapshot().phase, 'running');
    assert.equal(atob(session.getSnapshot().output[0]!.deltaBase64), 'echo hello\r');
    await session.resize(100, 30);
    await session.terminate();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(session.getSnapshot().phase, 'exited');
  } finally { await controller.dispose(); remove(); await client.close(); bridge.dispose(); processes.dispose(); }
});
