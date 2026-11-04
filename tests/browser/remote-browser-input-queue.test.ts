import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteBrowserInputQueue } from '../../apps/workbench-web/src/browser/remote-browser-input-queue';
import { RemoteBrowserSurfaceHost } from '../../apps/workbench-web/src/browser/remote-browser-surface-host';
import { CreditWindow } from '@opencraft/remote-interaction';

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
  const sent: any[] = [], host: any = new RemoteBrowserSurfaceHost('mse', { getItem: () => null, setItem() {} }, 'input-proof');
  const p: any = { closed: false, connection: 1, controlGeneration: 1, control: { controller: true, token: 'grant' }, pending: new Map(), inputAcknowledgements: true,
    inputCredits: new CreditWindow({ maxItems: 2, maxBytes: 65536 }),
    socket: { readyState: 1, send(value: string) { sent.push(JSON.parse(value)); } } };
  const ack = () => { const [id, request] = p.pending.entries().next().value; p.inputCredits.release(id); p.pending.delete(id); clearTimeout(request.timer); request.resolve(); };
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

test('adaptive ACK window keeps 100ms continuous motion flowing while edges stay ordered', async () => {
  const { AdaptiveInputWindow } = await import('@opencraft/remote-interaction');
  const policy = new AdaptiveInputWindow(); let now = 0, produced = 0;
  let due: { at: number; resolve(): void }[] = []; const seen: { at: number; type: string }[] = [];
  const queue = new RemoteBrowserInputQueue(async event => {
    const sent = now; seen.push({ at: now, type: event.type });
    await new Promise<void>(resolve => due.push({ at: now + 100, resolve })); policy.observe(now - sent);
  }, () => assert.fail('overflow'), error => assert.fail(error.message), () => policy.limit);
  queue.push({ type: 'touchStart' });
  for (; now <= 1400; now++) {
    const ready = due.filter(d => d.at <= now); due = due.filter(d => d.at > now); ready.forEach(d => d.resolve());
    for (let i = 0; i < 12; i++) await Promise.resolve();
    if (now < 1000 && now >= produced * 1000 / 60) { queue.push({ type: 'touchMove', x: produced++ }); }
    if (now === 1000) queue.push({ type: 'touchEnd' });
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
  assert(seen.filter(e => e.type === 'touchMove' && e.at < 1000).length >= 50);
  assert.equal(seen[0].type, 'touchStart'); assert.equal(seen.at(-1)!.type, 'touchEnd');
  assert(policy.limit <= 12); assert.equal(await queue.idle(), true);
});

test('client merges keep a tiny timed tail instead of losing fling samples', async () => {
 let release!:()=>void;const gate=new Promise<void>(r=>release=r),seen:any[]=[];
 const queue=new RemoteBrowserInputQueue(async input=>{seen.push(input);await gate},()=>assert.fail('overflow'));
 queue.push({type:'touchStart'});queue.push({type:'keyDown'});
 for(let i=1;i<=1000;i++)queue.push({type:'touchMove',time:i,touchPoints:[{id:1,x:i,y:40}]});
 queue.push({type:'touchEnd',time:1001,touchPoints:[]});await tick();release();await queue.idle();
 const move=seen.find(v=>v.type==='touchMove');assert.equal(move.time,1000);
 assert.deepEqual(move.history.map((v:any)=>v.time),[998,999]);assert.equal(seen.at(-1).time,1001);
});


for (const method of ['wait', 'inspect', 'readContext']) {
  test(`read-only ${method} fences prior input but permits future input before its reply`, async () => {
    const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const oldSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: { OPEN: 1 } });
    const sent: any[] = [], host: any = new RemoteBrowserSurfaceHost('mse', { getItem: () => null, setItem() {} }, 'readonly-fence');
    const p: any = { closed: false, connection: 1, document: 'doc-1', controlGeneration: 1,
      control: { controller: true, token: 'human-grant' }, pending: new Map(), inputAcknowledgements: true,
      inputCredits: new CreditWindow({ maxItems: 12, maxBytes: 65536 }), socket: { readyState: 1, send(v: string) { sent.push(JSON.parse(v)); } } };
    const ack = (index: number) => { const id = sent[index].id, request = p.pending.get(id); assert(request);
      p.inputCredits.release(id); p.pending.delete(id); clearTimeout(request.timer); request.resolve(); };
    try {
      p.inputQueue = new RemoteBrowserInputQueue((input: any) => host.call(p, 'input', input), () => assert.fail('overflow'));
      p.inputQueue.push({ type: 'mouseDown' }); await tick();
      const read = host.call(p, 'automation', { method });
      p.inputQueue.push({ type: 'char', keyCode: 'H' });
      assert.deepEqual(sent.map(m => m.method), ['input'], 'read cannot precede past input ACK');
      ack(0); await tick();
      assert.deepEqual(sent.map(m => m.method), ['input', 'automation', 'input']);
      assert.equal(sent[1].control, undefined, 'resource use cannot grant input authority');
      assert.equal(sent[1].document, 'doc-1');
      assert.equal(sent[2].control, 'human-grant'); assert.equal(sent[2].input.keyCode, 'H');
      ack(2); assert.equal(await p.inputQueue.idle(), true, 'input drains while read is still pending');
      assert.equal(p.pending.size, 1); ack(1); await read;
    } finally {
      p.inputQueue?.reset(); host.rejectPending(p);
      if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else delete (globalThis as any).window;
      if (oldSocket) Object.defineProperty(globalThis, 'WebSocket', oldSocket); else delete (globalThis as any).WebSocket;
    }
  });
}

for (const boundary of ['controlGeneration', 'connection', 'closed', 'reset'] as const) {
  test(`queued read cannot outlive ${boundary}`, async () => {
    const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    const host: any = new RemoteBrowserSurfaceHost('mse', { getItem: () => null, setItem() {} }, 'read-cancel');
    const p: any = { closed: false, connection: 1, controlGeneration: 1, control: { controller: true, token: 'grant' } };
    let release!: () => void, reads = 0;
    p.inputQueue = new RemoteBrowserInputQueue(() => new Promise<void>(r => { release = r; }), () => assert.fail('overflow'));
    host.rawCall = () => { reads++; return Promise.resolve(); };
    try {
      p.inputQueue.push(wheel()); await tick();
      const read = host.call(p, 'automation', { method: 'wait' });
      const rejected = assert.rejects(read, /interaction ended/);
      if (boundary === 'reset') p.inputQueue.reset();
      else if (boundary === 'closed') p.closed = true;
      else ++p[boundary];
      release(); await rejected; assert.equal(reads, 0);
    } finally {
      p.inputQueue.reset();
      if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else delete (globalThis as any).window;
    }
  });
}

test('same-transaction barriers share a bounded ACK window behind prior input and fence later keys', async () => {
  const seen: string[] = [], acknowledgements: (() => void)[] = [];
  let pointerAck!: () => void;
  const queue = new RemoteBrowserInputQueue(input => {
    seen.push(input.type);
    return input.type === 'mouseDown' ? new Promise<void>(r => pointerAck = r) : Promise.resolve();
  }, () => assert.fail('overflow'));
  queue.push({type:'mouseDown'});
  const phases=Array.from({length:10},(_,i)=>queue.barrier(async current=>{
    assert(current());seen.push('phase'+i);await new Promise<void>(r=>acknowledgements.push(r));
  },'one-composition'));
  queue.push({type:'keyDown'});await tick();assert.deepEqual(seen,['mouseDown']);
  pointerAck();await tick();assert.deepEqual(seen,['mouseDown','phase0','phase1']);
  for(let i=0;i<10;i++){
    assert(acknowledgements[i]);acknowledgements[i]();await tick();
    if(i<9)assert(!seen.includes('keyDown'));
    assert(acknowledgements.length<=Math.min(10,i+3),'default window cannot admit more than two phases');
  }
  await Promise.all(phases);await queue.idle();
  assert.deepEqual(seen,['mouseDown',...Array.from({length:10},(_,i)=>'phase'+i),'keyDown']);
});

test('late old composition ACKs cannot release a replacement group after reset', async () => {
  const release: (()=>void)[]=[],seen:string[]=[];
  const queue=new RemoteBrowserInputQueue(async input=>{seen.push(input.type);},()=>assert.fail('overflow'));
  const phase=(group:string)=>queue.barrier(async()=>{seen.push(group);await new Promise<void>(r=>release.push(r));},group);
  const old=[phase('old'),phase('old')];await tick();queue.reset();
  const current=[phase('current'),phase('current')];queue.push({type:'keyDown'});await tick();
  release[0]();release[1]();await Promise.all(old);await tick();assert(!seen.includes('keyDown'));
  release[2]();await tick();assert(!seen.includes('keyDown'));release[3]();await Promise.all(current);await queue.idle();
  assert.deepEqual(seen,['old','old','current','current','keyDown']);
});
