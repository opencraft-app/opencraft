import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_INPUT_MAX_BYTES, CodexBridge, CodexBridgeError } from '../../apps/agent-bridge-host/src/codex.js';
import { codexDeclaration } from '../../apps/agent-bridge-host/src/codex-declaration.js';
import { BRIDGE_SCHEMA_VERSION, parseDelta, type BridgeDelta } from '@opencraft/agent-bridge-protocol';
import { assemble, createAssemblerState, projectToAppServer } from '@opencraft/agent-bridge-assembler';
import { createAssistantTurnPresentationPlan, createConversationKey, createDefaultTimelineProjectorRegistry,
  projectTimeline, type TimelineSourceItem } from '@opencraft/chat-core';

test('Codex Bridge keeps live commentary below the work clock and preserves final and async roles', () => {
  const deltas: BridgeDelta[] = [];
  const bridge = new CodexBridge({ async request() { throw Error('Unexpected native request'); } },
    (_, batch) => deltas.push(...batch));
  bridge.bind('route', 'native');
  const notify = (method: string, params: Record<string, unknown>) =>
    bridge.notification(method, { threadId: 'native', turnId: 'turn', ...params });
  const items = new Map<string, TimelineSourceItem>();
  let state = createAssemblerState(BRIDGE_SCHEMA_VERSION);
  const project = () => {
    for (const delta of deltas) assert.equal(parseDelta(delta).ok, true);
    const batch = assemble(state, deltas.splice(0), { threadId: 'route', clockSeed: 1000 });
    assert.deepEqual(batch.diagnostics, []);
    state = JSON.parse(JSON.stringify(batch.state)); // The next outbox batch starts from a persisted checkpoint.
    for (const notification of projectToAppServer(batch.events, { schemaVersion: BRIDGE_SCHEMA_VERSION, steerEvidenceDeclared: false })) {
      if (notification.method !== 'item/started' && notification.method !== 'item/completed') continue;
      const { item } = notification.params;
      items.set(item.id, { id: item.id, type: item.type, payload: {
        ...item, startedAtMs: 1200, completed: notification.method === 'item/completed',
      } });
    }
  };
  const message = (id: string, text: string, phase?: string, questions?: unknown) =>
    ({ item: { id, type: 'agentMessage', text, phase, questions } });

  notify('turn/started', { turn: { id: 'turn' } });
  notify('item/started', message('progress', '', 'commentary'));
  notify('item/agentMessage/delta', { itemId: 'progress', delta: 'Checking sources' });
  project();
  assert.equal([...items.values()][0]?.payload.phase, 'commentary');
  notify('item/completed', message('progress', 'Checking sources'));
  notify('item/started', { item: { id: 'reasoning', type: 'reasoning', content: [], summary: [] } });
  project();
  const snapshot = projectTimeline({ key: createConversationKey('bridge', 'route'), revision: 1, phase: 'live', authoritative: true,
    turns: [{ id: 'turn', status: 'streaming', startedAtMs: 1000, items: [...items.values()] }] },
  createDefaultTimelineProjectorRegistry());
  const assistant = snapshot.frames.find(frame => frame.type === 'assistant');
  assert.ok(assistant?.type === 'assistant');
  const slots = createAssistantTurnPresentationPlan(assistant).slots;
  assert.equal(slots.length, 1);
  assert.ok(slots[0]?.type === 'agent-activity');
  assert.equal(slots[0].contentUnits[0]?.type, 'worked-for');
  assert.ok(slots[0].blocks.some(block => block.type === 'text' && block.text === 'Checking sources'));

  const questions = [{ title: 'Which branch?', options: ['main', 'release'] }, { title: 'Extra details?', options: null }];
  notify('item/started', message('question', '', 'final_answer', questions));
  project();
  const pendingQuestion = [...items.values()].at(-1);
  assert.deepEqual(pendingQuestion?.payload.questions, questions);
  notify('item/completed', message('question', 'Which branch?', 'final_answer'));
  notify('item/started', message('answer', '', 'final_answer'));
  notify('item/agentMessage/delta', { itemId: 'answer', delta: 'Done' });
  project();
  notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  project();
  const text = [...items.values()].filter(item => item.type === 'agentMessage').map(item => item.payload);
  assert.deepEqual(text.map(item => [item.phase, item.delivery, item.text, item.completed, item.questions]), [
    ['commentary', null, 'Checking sources', true, null],
    ['final_answer', 'async', 'Which branch?', true, questions],
    ['final_answer', null, 'Done', true, null],
  ]);
});

test('Codex Bridge preserves reasoning sections through a checkpoint and an implicit close', () => {
  const deltas: BridgeDelta[] = [];
  const bridge = new CodexBridge({ async request() { throw Error('Unexpected native request'); } },
    (_, batch) => deltas.push(...batch));
  bridge.bind('route', 'native');
  const notify = (method: string, params: Record<string, unknown>) =>
    bridge.notification(method, { threadId: 'native', turnId: 'turn', ...params });
  notify('turn/started', { turn: { id: 'turn' } });
  notify('item/started', { item: { id: 'reasoning', type: 'reasoning', content: ['Initial'], summary: [] } });
  notify('item/reasoning/textDelta', { itemId: 'reasoning', delta: ' tail', contentIndex: 0 });
  notify('item/reasoning/textDelta', { itemId: 'reasoning', delta: 'Third', contentIndex: 2 });
  notify('item/reasoning/textDelta', { itemId: 'reasoning', delta: 'Invalid', contentIndex: Number.MAX_SAFE_INTEGER });
  const live = assemble(createAssemblerState(BRIDGE_SCHEMA_VERSION), deltas.splice(0), { threadId: 'route', clockSeed: 1000 });
  const options = { schemaVersion: BRIDGE_SCHEMA_VERSION, steerEvidenceDeclared: false };
  const frames = projectToAppServer(live.events, options);
  const item = frames.find(frame => frame.method === 'item/started')?.params.item;
  assert.ok(item);
  assert.deepEqual(frames.filter(frame => frame.method === 'item/reasoning/textDelta')
    .map(({ params }) => [params.itemId, params.contentIndex, params.delta]), [
    [item.id, 0, ' tail'], [item.id, 2, 'Third'],
  ]);

  notify('item/reasoning/textDelta', { itemId: 'reasoning', delta: ' section', contentIndex: 2 });
  notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  const checkpoint = JSON.parse(JSON.stringify(live.state));
  const final = assemble(checkpoint, deltas, { threadId: 'route', clockSeed: 1000 });
  assert.deepEqual(final.diagnostics, []);
  assert.deepEqual(projectToAppServer(final.events, options).find(frame => frame.method === 'item/completed')?.params.item, {
    id: item.id, type: 'reasoning', summary: [], content: ['Initial tail', '', 'Third section'],
  });
});

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

test('the Codex declaration matches native input and invalid content is refused before sending', async () => {
  const sent: any[] = [];
  const bridge = new CodexBridge({ async request(method, params) {
    sent.push({ method, params });
    return method === 'turn/start' ? { turn: { id: `turn-${sent.length}` } } : { turnId: 'turn-1' };
  } }, () => {});
  bridge.bind('route', 'native');
  const rich = [
    { type: 'text', text: 'look' },
    { type: 'image', url: 'data:image/png;base64,AAAA' },
    { type: 'localImage', path: '/tmp/a.png' },
    { type: 'mention', name: 'notes.md', path: '/work/notes.md' },
    { type: 'skill', name: 'fixture', path: '/work/fixture/SKILL.md' },
  ];
  assert.deepEqual(codexDeclaration.capabilities.inputContentTypes, rich.map(item => item.type));
  assert.deepEqual(codexDeclaration.capabilities.steer.contentLimits.allowedContentTypes, rich.map(item => item.type));
  await bridge.start('route', { input: rich, clientUserMessageId: 'rich' });
  assert.deepEqual(sent[0].params.input, rich);
  bridge.notification('turn/started', { threadId: 'native', turn: { id: 'turn-1' } });
  await bridge.steer('route', { inputId: 'more', clientRequestId: 'more', expectedTurnId: 'turn-1', input: [{ type: 'localImage', path: '/tmp/b.png' }] });
  assert.equal(sent[1].method, 'turn/steer');
  bridge.notification('turn/completed', { threadId: 'native', turn: { id: 'turn-1', status: 'completed' } });
  for (const input of [
    [{ type: 'skill', name: 'fixture', path: 'fixture/SKILL.md' }],
    [{ type: 'localImage', path: 'relative.png' }],
    [{ type: 'image', url: 'http://plain/a.png' }],
    [{ type: 'text', text: 'x'.repeat(CODEX_INPUT_MAX_BYTES) }],
  ])
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

test('turn/start defaults summary to auto unless explicitly set or disabled with null', async () => {
  const sent: any[] = [];
  const bridge = new CodexBridge({ async request(method, params) {
    sent.push({ method, params });
    return { turn: { id: `t-${sent.length}` } };
  } }, () => {});
  bridge.bind('route', 'native');

  await bridge.start('route', { input: [{ type: 'text', text: 'default summary' }] });
  assert.equal(sent[0].params.summary, 'auto');
  bridge.notification('turn/completed', { threadId: 'native', turn: { id: 't-1', status: 'completed' } });

  await bridge.start('route', { input: [{ type: 'text', text: 'explicit null' }], summary: null });
  assert.equal(sent[1].params.summary, null);
  bridge.notification('turn/completed', { threadId: 'native', turn: { id: 't-2', status: 'completed' } });

  await bridge.start('route', { input: [{ type: 'text', text: 'explicit detailed' }], summary: 'detailed' });
  assert.equal(sent[2].params.summary, 'detailed');
});

test('Codex Bridge preserves v0.167.2 activity items, citations, command metadata, and open-work state on session end', () => {
  const deltas: BridgeDelta[] = [];
  const bridge = new CodexBridge({ async request() { return {}; } }, (_, batch) => deltas.push(...batch));
  bridge.bind('route', 'native');
  const notify = (method: string, params: Record<string, unknown>) =>
    bridge.notification(method, { threadId: 'native', turnId: 'turn', ...params });

  notify('turn/started', { turn: { id: 'turn' } });
  const activityItems = [
    { id: 'fco', type: 'functionCallOutput', name: 'generate_chart', namespace: null, output: 'generated /tmp/out.png' },
    { id: 'iv', type: 'imageView', path: '/tmp/out.png' },
    { id: 'sl', type: 'sleep', durationMs: 500 },
    { id: 'er', type: 'enteredReviewMode', review: 'PR #1' },
    { id: 'xr', type: 'exitedReviewMode', review: 'LGTM' },
    { id: 'img', type: 'imageGeneration', status: 'inProgress', revisedPrompt: null, result: null, savedPath: null },
    {
      id: 'cmd', type: 'commandExecution', command: 'python3 run.py', cwd: '/work',
      status: 'completed', commandActions: [], aggregatedOutput: 'ok', exitCode: 0, durationMs: 12,
      processId: null, pluginId: 'skill-runner', scriptPath: '/work/run.py',
    },
  ];
  for (const item of activityItems) {
    notify('item/started', { item });
    notify('item/completed', { item });
  }

  const citation = { entries: [{ path: '/mem/notes.md', lineStart: 1, lineEnd: 4, note: 'fact' }], threadIds: ['t-prev'] };
  const questions = [{ title: 'Continue?', options: ['yes', 'no'] }];
  notify('item/started', { item: { id: 'msg', type: 'agentMessage', text: '', phase: 'commentary', questions, memoryCitation: citation } });
  notify('item/agentMessage/delta', { itemId: 'msg', delta: 'Streaming insight' });
  notify('item/started', { item: { id: 'rsn', type: 'reasoning', summary: ['Plan'], content: ['First'] } });
  notify('item/reasoning/textDelta', { itemId: 'rsn', delta: ' step', contentIndex: 0 });
  notify('item/reasoning/textDelta', { itemId: 'rsn', delta: 'Second section', contentIndex: 1 });
  deltas.push({ op: 'session.ended', scope: { threadId: 'route' } });

  for (const delta of deltas) assert.equal(parseDelta(delta).ok, true, JSON.stringify(delta));
  const assembled = assemble(createAssemblerState(BRIDGE_SCHEMA_VERSION), deltas, { threadId: 'route', clockSeed: 2000 });
  assert.deepEqual(assembled.diagnostics.map(d => d.code), ['session-ended-settled']);
  const projected = projectToAppServer(assembled.events, { schemaVersion: BRIDGE_SCHEMA_VERSION, steerEvidenceDeclared: false });
  const completed = projected.filter(f => f.method === 'item/completed').map(f => f.params.item);

  assert.equal(completed.some(item => item.type === 'functionCallOutput' && item.output === 'generated /tmp/out.png'), true);
  assert.equal(completed.some(item => item.type === 'imageView' && item.path === '/tmp/out.png'), true);
  assert.equal(completed.some(item => item.type === 'sleep'), true);
  assert.equal(completed.some(item => item.type === 'enteredReviewMode'), true);
  assert.equal(completed.some(item => item.type === 'exitedReviewMode'), true);
  assert.equal(completed.some(item => item.type === 'imageGeneration' && item.savedPath === null && item.result === null), true);

  const cmd = completed.find(item => item.type === 'commandExecution');
  assert.equal(cmd?.pluginId, 'skill-runner');
  assert.equal(cmd?.scriptPath, '/work/run.py');

  const msg = completed.find(item => item.type === 'agentMessage');
  assert.equal(msg?.text, 'Streaming insight');
  assert.equal(msg?.phase, 'commentary');
  assert.deepEqual(msg?.questions, questions);
  assert.deepEqual(msg?.memoryCitation, citation);

  const rsn = completed.find(item => item.type === 'reasoning');
  assert.deepEqual(rsn?.summary, ['Plan']);
  assert.deepEqual(rsn?.content, ['First step', 'Second section']);
});
