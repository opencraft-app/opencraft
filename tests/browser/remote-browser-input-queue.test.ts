import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteBrowserInputQueue } from '../../apps/workbench-web/src/browser/remote-browser-input-queue';
import { RemoteBrowserSurfaceHost } from '../../apps/workbench-web/src/browser/remote-browser-surface-host';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const wheel = (deltaY = -1, x = 20, modifiers: string[] = []) => ({ type: 'mouseWheel', x, y: 30, deltaX: 0, deltaY, modifiers });

test('slow grant/ACK bounds a thousand wheel samples, preserves distance and release', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: any[] = []; let overflow = 0;
  const queue = new RemoteBrowserInputQueue(async input => { seen.push(input); await gate; }, () => overflow++);
  queue.push({ type: 'mouseDown' });
  for (let i = 0; i < 1000; ++i) queue.push(wheel());
  queue.push({ type: 'mouseUp' });
  await tick();
  assert.equal(seen.length, 2, 'at most two native requests await acknowledgement');
  assert.equal(overflow, 0, 'wheel burst cannot cancel a pending control grant');
  release(); assert.equal(await queue.idle(), true);
  assert.equal(seen.length, 4);
  assert.equal(seen.filter(x => x.type === 'mouseWheel').reduce((sum, x) => sum + x.deltaY, 0), -1000);
  assert.equal(seen.at(-1).type, 'mouseUp');
});

test('moves keep latest position; wheel reversal, hit point, modifiers and editing edges remain ordered', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: any[] = [];
  const queue = new RemoteBrowserInputQueue(async input => { seen.push(input); await gate; }, () => assert.fail('overflow'));
  queue.push({ type: 'mouseDown' }); queue.push({ type: 'keyDown', keyCode: 'Shift' });
  for (let x = 0; x < 1000; ++x) queue.push({ type: 'mouseMove', x, modifiers: ['leftButtonDown'] });
  queue.push(wheel(-5)); queue.push(wheel(-6)); queue.push(wheel(3)); queue.push(wheel(4, 21)); queue.push(wheel(5, 21, ['control']));
  queue.push({ type: 'mouseUp' });
  release(); await queue.idle();
  assert.deepEqual(seen.slice(2).map(x => x.type === 'mouseMove' ? x.x : x.type === 'mouseWheel' ? [x.deltaY, x.x, x.modifiers] : x.type),
    [999, [-11, 20, []], [3, 20, []], [4, 21, []], [5, 21, ['control']], 'mouseUp']);
});

test('reset retires queued work and barriers; late old ACK cannot release a replacement window', async () => {
  const releases: (() => void)[] = [], seen: any[] = [];
  const queue = new RemoteBrowserInputQueue(input => { seen.push(input); return new Promise<void>(resolve => releases.push(resolve)); }, () => {});
  queue.push(wheel()); queue.push(wheel()); queue.push(wheel(-9)); await tick();
  const barrier = queue.idle(); queue.reset(); assert.equal(await barrier, false);
  queue.push({ type: 'touchStart' }); queue.push({ type: 'touchMove' }); queue.push({ type: 'touchEnd' }); await tick();
  releases[0](); releases[1](); await tick(); assert.equal(seen.length, 4);
  releases[2](); await tick(); assert.equal(seen.at(-1).type, 'touchEnd');
  releases[3](); releases[4](); await queue.idle();
  assert(!seen.some(x => x.deltaY === -9));
});

test('negotiated input waits for a real result and editing waits for the input barrier', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const windowOriginal = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: { OPEN: 1 } });
  const sent: any[] = [], host: any = new RemoteBrowserSurfaceHost({ getItem: () => null, setItem() {} }, 'input-proof');
  const p: any = { closed: false, connection: 1, controlGeneration: 1, control: { controller: true, token: 'grant' }, pending: new Map(), inputAcknowledgements: true,
    socket: { readyState: 1, send(value: string) { sent.push(JSON.parse(value)); } } };
  const ack = () => { const [id, request] = p.pending.entries().next().value; p.pending.delete(id); clearTimeout(request.timer); request.resolve(); };
  try {
    p.inputQueue = new RemoteBrowserInputQueue((input: any) => host.call(p, 'input', input), () => {});
    p.inputQueue.push(wheel()); await tick();
    const edit = host.call(p, 'ime', { type: 'commit', text: '你好' });
    assert.deepEqual(sent.map(x => x.method), ['input']); assert.equal(p.pending.size, 1);
    p.inputQueue.push({ type: 'keyDown', keyCode: 'Return' });
    ack(); await tick(); assert.deepEqual(sent.map(x => x.method), ['input', 'ime']); ack(); await edit; await tick();
    assert.equal(sent.at(-1).input.keyCode, 'Return', 'later key cannot overtake the composition commit'); ack(); await p.inputQueue.idle();
    p.inputAcknowledgements = false; await host.rawCall(p, 'input', wheel()); assert.equal(p.pending.size, 0, 'legacy quiet input remains compatible');
  } finally {
    host.rejectPending(p);
    if (windowOriginal) Object.defineProperty(globalThis, 'window', windowOriginal); else delete (globalThis as any).window;
    if (original) Object.defineProperty(globalThis, 'WebSocket', original); else delete (globalThis as any).WebSocket;
  }
});

test('reset cancels samples still waiting for a control grant, without replaying them into its replacement', async () => {
  let grant!: () => void; const gate = new Promise<void>(resolve => { grant = resolve; }), sent: any[] = [];
  const queue = new RemoteBrowserInputQueue(async (input, current) => { await gate; if (current()) sent.push(input); }, () => {});
  queue.push({ type: 'mouseDown' }); await tick(); queue.reset(); queue.push({ type: 'touchStart' });
  grant(); await queue.idle(); assert.deepEqual(sent.map(x => x.type), ['touchStart']);
});

test('failed input retires dependent work, reports once and ignores late old ACKs', async () => {
  const seen: string[] = [], failures: string[] = [];
  let reject!: (error: Error) => void, release!: () => void;
  const queue = new RemoteBrowserInputQueue(input => {
    seen.push(input.type);
    return input.type === 'touchStart' ? new Promise((_r, fail) => { reject = fail; })
      : new Promise<void>(resolve => { release = resolve; });
  }, () => assert.fail('overflow'), error => failures.push(error.message));
  queue.push({type:'touchStart'}); queue.push({type:'touchMove'}); queue.push({type:'touchEnd'}); await tick();
  const drain = queue.idle(); reject(new Error('native rejected input')); await tick();
  assert.equal(await drain, false); assert.deepEqual(failures, ['native rejected input']);
  assert.deepEqual(seen, ['touchStart','touchMove']);
  release(); await tick(); assert.equal(queue.busy, false);
});

test('coalescing cannot replace an event from another document', () => {
  const seen: any[] = [];
  const queue = new RemoteBrowserInputQueue(async event => { seen.push(event); }, () => assert.fail('overflow'));
  queue.push({type:'keyDown'});queue.push({type:'keyUp'});
  queue.push({...wheel(),document:'old'});queue.push({...wheel(),document:'new'});
  return queue.idle().then(() => assert.deepEqual(seen.slice(2).map(e=>[e.document,e.deltaY]),[['old',-1],['new',-1]]));
});
