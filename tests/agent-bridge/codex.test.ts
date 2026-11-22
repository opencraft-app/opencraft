import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexBridge, CodexBridgeError } from '../../apps/agent-bridge-host/src/codex.js';
import type { BridgeDelta } from '../../packages/agent-bridge-protocol/src/index.js';

test('Codex steer admission does not manufacture input evidence and stale never dispatches', async () => {
  const calls: unknown[] = [], events: BridgeDelta[] = [];
  const bridge = new CodexBridge({ async request(method, params) { calls.push({ method, params }); return { turnId: 'turn' }; } }, (_, deltas) => events.push(...deltas));
  bridge.bind('route', 'native');
  bridge.notification('turn/started', { threadId: 'native', turn: { id: 'turn' } });
  const input = { inputId: 'input', clientRequestId: 'client', expectedTurnId: 'turn', input: [{ type: 'text', text: 'hello' }] };
  await bridge.steer('route', input);
  assert.equal(events.filter(e => e.op === 'input.evidence').length, 0);
  assert.equal(bridge.query('route', 'input')?.state, 'accepted');
  bridge.notification('turn/completed', { threadId: 'native', turn: { id: 'turn', status: 'completed' } });
  await assert.rejects(bridge.steer('route', { ...input, inputId: 'stale' }), (e: unknown) => e instanceof CodexBridgeError && e.kind === 'stale-target');
  assert.equal(calls.length, 1);
});

test('native identity event before response preserves independent evidence; text does not join', async () => {
  const events: BridgeDelta[] = [];
  let bridge: CodexBridge;
  bridge = new CodexBridge({ async request() {
    bridge.notification('item/started', { threadId: 'native', turnId: 'turn', item: { type: 'userMessage', id: 'native-input', clientId: 'client', content: [{ type: 'text', text: 'hello' }] } });
    return {};
  } }, (_, deltas) => events.push(...deltas));
  bridge.bind('route', 'native');
  bridge.notification('turn/started', { threadId: 'native', turn: { id: 'turn' } });
  await bridge.steer('route', { inputId: 'input', clientRequestId: 'client', expectedTurnId: 'turn', input: [{ type: 'text', text: 'hello' }] });
  assert.equal(bridge.query('route', 'input')?.evidence, 'native-input');
  assert.equal(events.filter(e => e.op === 'input.evidence').length, 1);
  assert.equal(events.some(e => e.op === 'input.evidence' && e.evidenceKind === 'context-confirmed'), false);
});

test('transport loss stays unknown and repeated input cannot resend', async () => {
  let calls = 0;
  const bridge = new CodexBridge({ async request() { calls++; throw Error('EOF'); } }, () => {});
  bridge.bind('route', 'native');
  bridge.notification('turn/started', { threadId: 'native', turn: { id: 'turn' } });
  const input = { inputId: 'input', clientRequestId: 'client', expectedTurnId: 'turn', input: [{ type: 'text', text: 'hello' }] };
  await assert.rejects(bridge.steer('route', input));
  assert.equal(bridge.query('route', 'input')?.state, 'unknown');
  await assert.rejects(bridge.steer('route', input));
  assert.equal(calls, 1);
});

test('an unconfirmed input retains session custody across turn end and cannot be closed or overtaken', async () => {
  const calls: string[] = [];
  const bridge = new CodexBridge({ async request(method) { calls.push(method); return {}; } }, () => {});
  bridge.bind('route', 'native');
  bridge.notification('turn/started', { threadId: 'native', turn: { id: 'old' } });
  await bridge.steer('route', { inputId: 'input', clientRequestId: 'client', expectedTurnId: 'old', input: [{ type: 'text', text: 'hello' }] });
  bridge.notification('turn/completed', { threadId: 'native', turn: { id: 'old', status: 'completed' } });
  await assert.rejects(bridge.close('route'), /reconciliation/);
  bridge.notification('turn/started', { threadId: 'native', turn: { id: 'new' } });
  await assert.rejects(bridge.steer('route', { inputId: 'other', clientRequestId: 'other', expectedTurnId: 'new', input: [{ type: 'text', text: 'hello' }] }), /pending/);
  assert.deepEqual(calls, ['turn/steer']);
});

test('native start reply before notification opens one canonical turn before returning its identity', async () => {
  const deltas: BridgeDelta[] = [];
  const bridge = new CodexBridge({ async request() { return { turn: { id: 'native-turn' } }; } }, (_, batch) => deltas.push(...batch));
  bridge.bind('route', 'native');
  await bridge.start('route', { input: [{ type: 'text', text: 'hello' }] });
  assert.equal(deltas.filter(d => d.op === 'turn.open').length, 1);
  bridge.notification('turn/started', { threadId: 'native', turn: { id: 'native-turn' } });
  assert.equal(deltas.filter(d => d.op === 'turn.open').length, 1);
});

test('CLI preparation rejection never poisons an unsent native Turn',async()=>{
  for(const fault of [new CodexBridgeError('unsupported','cliUnavailable'),new Error('native retirement pending')]) {
    let prepared=0,starts=0;
    const bridge=new CodexBridge({async configureExecution(){if(++prepared===1)throw fault;},
      async request(method){assert.equal(method,'turn/start');starts++;return {turn:{id:'turn'}};}},()=>{});
    bridge.bind('route','native');
    const input={input:[{type:'text',text:'bounded'}]},environment={OPENCRAFT_THREAD_CLI:'fixture'};
    await assert.rejects(bridge.start('route',input,environment),(e:unknown)=>e instanceof CodexBridgeError&&e.kind==='unsupported');
    assert.equal(starts,0);
    await bridge.start('route',input,environment);assert.equal(starts,1);
  }
});

test('native image, local image and file mention input pass through; anything else is refused before sending', async () => {
  const sent: any[] = [];
  const bridge = new CodexBridge({ async request(method, params) {
    sent.push({ method, params });
    return method === 'turn/start' ? { turn: { id: `turn-${sent.length}` } } : { turnId: 'turn-1' };
  } }, () => {});
  bridge.bind('route', 'native');
  const rich = [{ type: 'text', text: 'look' }, { type: 'image', url: 'data:image/png;base64,AAAA' }, { type: 'localImage', path: '/tmp/a.png' },
    { type: 'mention', name: 'notes.md', path: '/work/notes.md' }];
  await bridge.start('route', { input: rich, clientUserMessageId: 'rich' });
  assert.deepEqual(sent[0].params.input, rich);
  bridge.notification('turn/started', { threadId: 'native', turn: { id: 'turn-1' } });
  await bridge.steer('route', { inputId: 'more', clientRequestId: 'more', expectedTurnId: 'turn-1', input: [{ type: 'localImage', path: '/tmp/b.png' }] });
  assert.equal(sent[1].method, 'turn/steer');
  bridge.notification('turn/completed', { threadId: 'native', turn: { id: 'turn-1', status: 'completed' } });
  for (const input of [[{ type: 'skill', name: 'x', path: '/x' }], [{ type: 'localImage', path: 'relative.png' }], [{ type: 'image', url: 'http://plain/a.png' }],
    [{ type: 'text', text: 'x'.repeat(70_000) }]])
    await assert.rejects(bridge.start('route', { input }), (e: unknown) => e instanceof CodexBridgeError && e.kind === 'unsupported', JSON.stringify(input).slice(0, 60));
  assert.equal(sent.length, 2, 'refused input is never sent');
  // An empty start continues the Thread (Host recovery and retry); a steer needs content.
  await bridge.start('route', { input: [], clientUserMessageId: 'continue' });
  assert.deepEqual(sent[2].params.input, []);
  bridge.notification('turn/started', { threadId: 'native', turn: { id: 'turn-3' } });
  await assert.rejects(bridge.steer('route', { inputId: 'empty', clientRequestId: 'empty', expectedTurnId: 'turn-3', input: [] }),
    (e: unknown) => e instanceof CodexBridgeError && e.kind === 'unsupported');
  assert.equal(sent.length, 3);
});

test('a failed native turn carries its error classification; a completed one carries none', () => {
  const events: BridgeDelta[] = [];
  const bridge = new CodexBridge({ async request() { return {}; } }, (_, deltas) => events.push(...deltas));
  bridge.bind('route', 'native');
  bridge.notification('turn/completed', { threadId: 'native', turn: { id: 'a', status: 'failed', error: { message: 'busy', codexErrorInfo: 'serverOverloaded', additionalDetails: null } } });
  bridge.notification('turn/completed', { threadId: 'native', turn: { id: 'b', status: 'completed', error: null } });
  assert.deepEqual(events.map(e => e.op === 'turn.close' ? [e.status, e.error ?? null] : null), [
    ['failed', { message: 'busy', codexErrorInfo: 'serverOverloaded', additionalDetails: null }], ['completed', null],
  ]);
});

test('a response native abandoned (for a steer) closes with its turn; a completed one is not closed twice', () => {
  const events: BridgeDelta[] = [];
  const bridge = new CodexBridge({ async request() { return {}; } }, (_, deltas) => events.push(...deltas));
  bridge.bind('route', 'native');
  bridge.notification('turn/started', { threadId: 'native', turn: { id: 't1' } });
  bridge.notification('item/agentMessage/delta', { threadId: 'native', turnId: 't1', itemId: 'abandoned', delta: 'partial' });
  bridge.notification('item/agentMessage/delta', { threadId: 'native', turnId: 't1', itemId: 'final', delta: 'done' });
  bridge.notification('item/completed', { threadId: 'native', turnId: 't1', item: { type: 'agentMessage', id: 'final', text: 'done' } });
  bridge.notification('turn/completed', { threadId: 'native', turn: { id: 't1', status: 'completed', error: null } });
  const closes = events.filter(e => e.op === 'item.textClose');
  assert.deepEqual(closes.map(e => (e as any).nativeKey), ['abandoned']);
  assert.ok(events.indexOf(closes[0]!) < events.findIndex(e => e.op === 'turn.close'));
});
