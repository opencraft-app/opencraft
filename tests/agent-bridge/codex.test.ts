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
