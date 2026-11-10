import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ClaudeSession } from '../../apps/claude-code-bridge/src/session.js';
import type { BridgeDelta } from '@opencraft/agent-bridge-protocol';
import { FakeClaudeFactory } from './fixtures/fake-claude-native.js';

async function flush(session: ClaudeSession): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((accept) => setImmediate(accept));
    await session.drain();
  }
}

async function setup(options: Partial<ConstructorParameters<typeof ClaudeSession>[0]> = {}) {
  const factory = new FakeClaudeFactory();
  const deltas: BridgeDelta[] = [];
  const identities: { providerThreadId: string; sessionRestorable: boolean }[] = [];
  const session = new ClaudeSession({
    scopeId: '["server","thread"]',
    cwd: '/tmp/claude-bridge-test',
    model: 'haiku',
    emit: async (batch) => { deltas.push(...batch); },
    emitIdentity: async (identity) => { identities.push(identity); },
    initializeTimeoutMs: 500,
    steerWaitTimeoutMs: 40,
    backgroundIdleGraceMs: 15,
    ...options,
  }, factory);
  await session.create();
  return { session, factory, native: factory.last, deltas, identities };
}

function closeCount(deltas: readonly BridgeDelta[]): number {
  return deltas.filter((delta) => delta.op === 'turn.close').length;
}

function evidence(deltas: readonly BridgeDelta[], inputId: string): string[] {
  return deltas
    .filter((delta) => delta.op === 'input.evidence' && delta.inputId === inputId)
    .map((delta) => delta.evidenceKind);
}

test('session create reports the generated native session id without a model turn', async () => {
  const { session, native, identities, deltas } = await setup();
  assert.equal(identities.length, 1);
  assert.match(identities[0]!.providerThreadId, /^[0-9a-f-]{36}$/u);
  assert.equal(identities[0]!.sessionRestorable, false);
  assert.equal(native.pushes.length, 0, 'create must not run a model turn');
  assert.equal(native.options.sessionId, identities[0]!.providerThreadId);
  assert.equal(deltas.length, 0);
  await session.close();
});

test('turn start streams text and tool work, then settles with usage', async () => {
  const { session, native, deltas } = await setup();
  const started = await session.startTurn({ inputId: 'in1', clientRequestId: 'client-1', text: 'Read note.txt' });
  assert.equal(started.admitted, true);
  assert.equal(native.pushes.length, 1);
  const initialUuid = native.pushes[0]!.uuid;

  native.emit({
    type: 'assistant',
    uuid: 'assistant-1',
    message: {
      content: [
        { type: 'text', text: 'Reading it.' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'cat note.txt', cwd: '/tmp/claude-bridge-test' } },
      ],
    },
  });
  await flush(session);
  assert.ok(deltas.some((delta) => delta.op === 'item.open' && delta.nativeKey === 'assistant-1:text:0'));
  assert.ok(deltas.some((delta) => delta.op === 'item.open' && delta.nativeKey === 'tool-1' && delta.shape.kind === 'command'));

  native.emit({
    type: 'user',
    uuid: 'user-1',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'hello from note\n' }] },
  });
  await flush(session);
  const closedTool = deltas.find((delta) => delta.op === 'item.close' && delta.nativeKey === 'tool-1');
  assert.ok(closedTool && closedTool.op === 'item.close');
  assert.equal(closedTool.shape.kind, 'command');
  assert.equal((closedTool.shape as any).output, 'hello from note\n');

  native.emit({
    type: 'result',
    subtype: 'success',
    uuid: 'result-1',
    user_message_uuids: [initialUuid],
    queued_turn_count: 0,
    usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 5 },
    modelUsage: {
      'claude-haiku-5-5': { inputTokens: 12, outputTokens: 3, cacheReadInputTokens: 4, cacheCreationInputTokens: 5, contextWindow: 200000 },
    },
  });
  await flush(session);
  assert.equal(closeCount(deltas), 1);
  const closed = deltas.find((delta) => delta.op === 'turn.close');
  assert.ok(closed && closed.op === 'turn.close');
  assert.equal(closed.status, 'completed');
  const usage = deltas.find((delta) => delta.op === 'usage');
  assert.ok(usage && usage.op === 'usage');
  assert.equal(usage.last.inputTokens, 12);
  assert.equal(usage.total.outputTokens, 3);
  assert.deepEqual(session.query(['in1'])[0]?.evidence, 'context-confirmed');
  await session.close();
});

test('a steer accepted before the first result keeps the logical turn open until its UUID is reported', async () => {
  const { session, native, deltas } = await setup();
  await session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Read the note.' });
  const initialUuid = native.pushes[0]!.uuid;
  await session.steer({ inputId: 'steer-1', clientRequestId: 'client-steer', text: 'Add the word PINEAPPLE.' });
  const steerUuid = native.pushes[1]!.uuid;

  native.emit({
    type: 'result',
    subtype: 'success',
    uuid: 'result-1',
    user_message_uuids: [initialUuid],
    queued_turn_count: 0,
  });
  await flush(session);
  assert.equal(closeCount(deltas), 0, 'first result must not close a turn with an unconsumed steer');
  assert.equal(session.query(['steer-1'])[0]?.evidence, 'evidence-observed');

  native.emit({
    type: 'result',
    subtype: 'success',
    uuid: 'result-2',
    user_message_uuids: [steerUuid],
    queued_turn_count: 0,
  });
  await flush(session);
  assert.equal(closeCount(deltas), 1);
  assert.equal(session.query(['steer-1'])[0]?.evidence, 'context-confirmed');
  assert.equal(session.query(['steer-1'])[0]?.outcome, 'context-confirmed');
  assert.equal(native.pushes.length, 2, 'steer must be pushed exactly once');
  await session.close();
});

test('a steer that arrives after settlement is an explicit stale rejection with no native write', async () => {
  const { session, native, deltas } = await setup();
  await session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Say hi.' });
  native.emit({
    type: 'result',
    subtype: 'success',
    uuid: 'result-1',
    user_message_uuids: [native.pushes[0]!.uuid],
    queued_turn_count: 0,
  });
  await flush(session);
  assert.equal(closeCount(deltas), 1);
  await assert.rejects(
    session.steer({ inputId: 'late', clientRequestId: 'client-late', text: 'Too late' }),
    (error: any) => error.kind === 'stale-target',
  );
  assert.equal(native.pushes.length, 1, 'stale steer must not reach the SDK input stream');
  await session.close();
});

test('an older CLI without result UUIDs holds once, then settles without claiming context evidence', async () => {
  const { session, native, deltas } = await setup();
  await session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Read the note.' });
  await session.steer({ inputId: 'steer-1', clientRequestId: 'client-steer', text: 'Add PINEAPPLE.' });

  native.emit({ type: 'result', subtype: 'success', uuid: 'result-1', queued_turn_count: 0 });
  await flush(session);
  assert.equal(closeCount(deltas), 0);
  native.emit({ type: 'result', subtype: 'success', uuid: 'result-2', queued_turn_count: 0 });
  await flush(session);
  assert.equal(closeCount(deltas), 1);
  const status = session.query(['steer-1'])[0]!;
  assert.equal(status.evidence, 'evidence-observed', 'missing UUIDs must stay admission-only');
  assert.equal(evidence(deltas, 'steer-1').includes('context-confirmed'), false);
  await session.close();
});

test('the recorded steer/end race fixture replays to the same held-turn decision', async () => {
  const fixture = JSON.parse(await readFile(resolve('tests/agent-bridge/fixtures/claude-steer-race.json'), 'utf8'));
  const { session, native, deltas } = await setup();
  await session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Read the note.' });
  await session.steer({ inputId: 'steer-1', clientRequestId: 'client-steer', text: 'Add PINEAPPLE.' });
  const values: Record<string, string> = {
    $initial: native.pushes[0]!.uuid,
    $steer: native.pushes[1]!.uuid,
  };
  for (const message of fixture.messages) {
    native.emit(JSON.parse(JSON.stringify(message).replace(/\$(initial|steer)/gu, (token) => values[token]!)));
    await flush(session);
  }
  assert.equal(fixture.nativeVersion, '2.1.321');
  assert.equal(closeCount(deltas), 1);
  assert.equal(session.query(['steer-1'])[0]?.evidence, 'context-confirmed');
  await session.close();
});

test('background work keeps the logical turn held until the native idle signal', async () => {
  const { session, native, deltas } = await setup();
  await session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Start a task.' });
  native.emit({ type: 'system', subtype: 'task_started', task_id: 'bg-1', is_backgrounded: true, uuid: 'task-1', session_id: 's' });
  native.emit({
    type: 'result',
    subtype: 'success',
    uuid: 'result-1',
    user_message_uuids: [native.pushes[0]!.uuid],
    queued_turn_count: 0,
  });
  await flush(session);
  assert.equal(closeCount(deltas), 0, 'background work must not be cut off by the main result');
  native.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [], uuid: 'tasks-1', session_id: 's' });
  native.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: 'idle-1', session_id: 's' });
  await flush(session);
  assert.equal(closeCount(deltas), 1);
  await session.close();
});

test('the SDK idle signal is authoritative over a stale background set and ambient tasks', async () => {
  const { session, native, deltas } = await setup();
  await session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Start a task.' });
  native.emit({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'ambient-1', task_type: 'local_bash', description: 'watcher', ambient: true }],
    uuid: 'tasks-1',
    session_id: 's',
  });
  native.emit({
    type: 'result',
    subtype: 'success',
    uuid: 'result-1',
    user_message_uuids: [native.pushes[0]!.uuid],
    queued_turn_count: 0,
  });
  await flush(session);
  assert.equal(closeCount(deltas), 1, 'ambient tasks must not hold the turn');

  const second = await setup();
  await second.session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Start a task.' });
  second.native.emit({ type: 'system', subtype: 'task_started', task_id: 'bg-1', is_backgrounded: true, uuid: 'task-1', session_id: 's' });
  second.native.emit({
    type: 'result',
    subtype: 'success',
    uuid: 'result-1',
    user_message_uuids: [second.native.pushes[0]!.uuid],
    queued_turn_count: 0,
  });
  await flush(second.session);
  assert.equal(closeCount(second.deltas), 0, 'a real background task holds the turn');
  second.native.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: 'idle-1', session_id: 's' });
  await flush(second.session);
  assert.equal(closeCount(second.deltas), 1, 'idle remains authoritative even if the level bookend was missed');
  await session.close();
  await second.session.close();
});

test('a foreground or ambient task_started edge does not hold the turn', async () => {
  const { session, native, deltas } = await setup();
  await session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Start.' });
  native.emit({ type: 'system', subtype: 'task_started', task_id: 'fg-1', is_backgrounded: false, uuid: 'task-1', session_id: 's' });
  native.emit({ type: 'system', subtype: 'task_started', task_id: 'amb-1', is_backgrounded: true, skip_transcript: true, uuid: 'task-2', session_id: 's' });
  native.emit({
    type: 'result',
    subtype: 'success',
    uuid: 'result-1',
    user_message_uuids: [native.pushes[0]!.uuid],
    queued_turn_count: 0,
  });
  await flush(session);
  assert.equal(closeCount(deltas), 1);
  await session.close();
});

test('turn/start cannot switch to bypassPermissions without the create-time opt-in', async () => {
  const { session, native } = await setup();
  await assert.rejects(
    session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Read.', permissionMode: 'bypassPermissions' }),
    (error: any) => error.kind === 'explicit-reject',
  );
  assert.equal(native.pushedPermissionModes.length, 0);
  await session.close();

  const allowed = await setup({ allowDangerouslySkipPermissions: true });
  await allowed.session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Read.', permissionMode: 'bypassPermissions' });
  assert.deepEqual(allowed.native.pushedPermissionModes, ['bypassPermissions']);
  await allowed.session.close();
});

test('a queued native turn holds the turn until the following result', async () => {
  const { session, native, deltas } = await setup();
  await session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Say hi.' });
  native.emit({
    type: 'result',
    subtype: 'success',
    uuid: 'result-1',
    user_message_uuids: [native.pushes[0]!.uuid],
    queued_turn_count: 1,
  });
  await flush(session);
  assert.equal(closeCount(deltas), 0);
  native.emit({ type: 'result', subtype: 'success', uuid: 'result-2', queued_turn_count: 0 });
  await flush(session);
  assert.equal(closeCount(deltas), 1);
  await session.close();
});

test('stop closes the turn as interrupted and a late result cannot close it twice', async () => {
  const { session, native, deltas } = await setup();
  await session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Wait.' });
  const result = await session.stop();
  assert.deepEqual(result, { interrupted: true });
  assert.equal(native.interrupts, 1);
  assert.equal(closeCount(deltas), 1);
  const closed = deltas.find((delta) => delta.op === 'turn.close');
  assert.ok(closed && closed.op === 'turn.close');
  assert.equal(closed.status, 'interrupted');
  native.emit({ type: 'result', subtype: 'error_during_execution', uuid: 'result-1', queued_turn_count: 0 });
  await flush(session);
  assert.equal(closeCount(deltas), 1);
  await session.close();
});

test('stop reports a queued steer as cancelled-failed or surviving-unknown without a fake withdrawal', async () => {
  const queued = await setup();
  await queued.session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Read.' });
  await queued.session.steer({ inputId: 'steer-1', clientRequestId: 'client-steer', text: 'Add.' });
  queued.native.interruptReceipt = { stillQueued: [queued.native.pushes[1]!.uuid], cancelled: [] };
  await queued.session.stop();
  assert.equal(queued.session.query(['steer-1'])[0]?.outcome, 'unknown');
  assert.equal(queued.session.query(['steer-1'])[0]?.withdrawal, 'none');
  await queued.session.close();

  const cancelled = await setup();
  await cancelled.session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Read.' });
  await cancelled.session.steer({ inputId: 'steer-1', clientRequestId: 'client-steer', text: 'Add.' });
  cancelled.native.interruptReceipt = { stillQueued: [], cancelled: [cancelled.native.pushes[1]!.uuid] };
  await cancelled.session.stop();
  assert.equal(cancelled.session.query(['steer-1'])[0]?.outcome, 'failed');
  const outcomes = cancelled.deltas.filter((delta) => delta.op === 'input.outcome');
  assert.equal(outcomes.at(-1)?.op === 'input.outcome' ? outcomes.at(-1)!.state : undefined, 'failed');
  await cancelled.session.close();
});

test('session close settles an admitted but unconfirmed steer as unknown', async () => {
  const { session, native } = await setup();
  await session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Read.' });
  await session.steer({ inputId: 'steer-1', clientRequestId: 'client-steer', text: 'Add.' });
  await session.close();
  assert.equal(session.query(['steer-1'])[0]?.outcome, 'unknown');
  assert.equal(native.closes >= 1, true);
});

test('a steer with no native evidence times out to unknown instead of pretending success', async () => {
  const { session, native, deltas } = await setup({ steerWaitTimeoutMs: 20 });
  await session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Read.' });
  await session.steer({ inputId: 'steer-1', clientRequestId: 'client-steer', text: 'Add PINEAPPLE.' });
  native.emit({
    type: 'result',
    subtype: 'success',
    uuid: 'result-1',
    user_message_uuids: [native.pushes[0]!.uuid],
    queued_turn_count: 0,
  });
  await flush(session);
  await new Promise((resolve) => setTimeout(resolve, 60));
  await flush(session);
  const status = session.query(['steer-1'])[0]!;
  assert.equal(status.outcome, 'unknown');
  assert.equal(status.evidence, 'evidence-observed');
  assert.equal(closeCount(deltas), 1);
  await session.close();
});

test('native stream end rejects a blocked input admission and still settles the session', async () => {
  const { session, native, deltas } = await setup();
  native.blockPush = true;
  const start = session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Read.' });
  await new Promise((accept) => setImmediate(accept));
  native.end(new Error('native crash'));
  await assert.rejects(start, (error: any) => error.kind === 'unknown-outcome');
  await flush(session);
  assert.ok(deltas.some((delta) => delta.op === 'session.ended'));
  assert.equal(closeCount(deltas), 1);
  assert.equal(session.query(['initial'])[0]?.outcome, 'unknown');
  await session.close();
});

test('a stalled input admission times out as unknown instead of wedging the queue', async () => {
  const { session, native, deltas } = await setup({ pushTimeoutMs: 30 });
  native.blockPush = true;
  await assert.rejects(
    session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Read.' }),
    (error: any) => error.kind === 'unknown-outcome',
  );
  await flush(session);
  assert.equal(session.query(['initial'])[0]?.outcome, 'unknown');
  assert.equal(closeCount(deltas), 1);
  assert.ok(deltas.some((delta) => delta.op === 'session.ended'));
  await session.close();
});

test('native EOF settles admitted pending input as unknown and ends the session', async () => {
  const { session, native, deltas } = await setup();
  await session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Read.' });
  await session.steer({ inputId: 'steer-1', clientRequestId: 'client-steer', text: 'Add PINEAPPLE.' });
  native.end(new Error('native crash'));
  await flush(session);
  assert.equal(session.query(['steer-1'])[0]?.outcome, 'unknown');
  assert.ok(deltas.some((delta) => delta.op === 'session.ended'));
  assert.equal(closeCount(deltas), 1);
});

test('withdraw is explicitly unsupported because the SDK input stream already owns admitted input', async () => {
  const { session, native, deltas } = await setup();
  await session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Read.' });
  await session.steer({ inputId: 'steer-1', clientRequestId: 'client-steer', text: 'Add.' });
  const result = await session.withdraw('steer-1');
  assert.deepEqual(result, { inputId: 'steer-1', state: 'unsupported' });
  assert.equal(session.query(['steer-1'])[0]?.withdrawal, 'unsupported');
  assert.ok(deltas.some((delta) => delta.op === 'input.withdrawal' && delta.state === 'unsupported'));
  assert.equal(native.pushes.length, 2);
  await session.close();
});

test('a failed turn with no queued follow-up settles an unconsumed steer as unknown', async () => {
  const { session, native, deltas } = await setup();
  await session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Read.' });
  await session.steer({ inputId: 'steer-1', clientRequestId: 'client-steer', text: 'Add.' });
  native.emit({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    uuid: 'result-1',
    user_message_uuids: [native.pushes[0]!.uuid],
    queued_turn_count: 0,
  });
  await flush(session);
  assert.equal(session.query(['steer-1'])[0]?.outcome, 'unknown');
  assert.equal(closeCount(deltas), 1);
  await session.close();
});

test('a native running signal keeps a follow-up run live past the steer timeout', async () => {
  const { session, native, deltas } = await setup({ steerWaitTimeoutMs: 40, maxHoldMs: 1_000 });
  await session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Read.' });
  await session.steer({ inputId: 'steer-1', clientRequestId: 'client-steer', text: 'Add.' });
  native.emit({
    type: 'result',
    subtype: 'success',
    uuid: 'result-1',
    user_message_uuids: [native.pushes[0]!.uuid],
    queued_turn_count: 0,
  });
  await flush(session);
  native.emit({ type: 'system', subtype: 'session_state_changed', state: 'running', uuid: 'run-1', session_id: 's' });
  await flush(session);
  await new Promise((resolve) => setTimeout(resolve, 70));
  await flush(session);
  assert.equal(closeCount(deltas), 0, 'the steer timeout must not close a live follow-up run');
  assert.notEqual(session.query(['steer-1'])[0]?.outcome, 'unknown');
  const runningEvents = deltas.filter((delta) => delta.op === 'turn.mainRun' && delta.state === 'running');
  assert.ok(runningEvents.length >= 2, 'the running signal is reflected in canonical state');
  native.emit({
    type: 'result',
    subtype: 'success',
    uuid: 'result-2',
    user_message_uuids: [native.pushes[1]!.uuid],
    queued_turn_count: 0,
  });
  await flush(session);
  assert.equal(session.query(['steer-1'])[0]?.outcome, 'context-confirmed');
  assert.equal(closeCount(deltas), 1);
  await session.close();
});

test('a held turn has a bounded safety valve when native queued work never returns', async () => {
  const { session, native, deltas } = await setup({ maxHoldMs: 40, steerWaitTimeoutMs: 1_000 });
  await session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Read.' });
  await session.steer({ inputId: 'steer-1', clientRequestId: 'client-steer', text: 'Add.' });
  native.emit({
    type: 'result',
    subtype: 'success',
    uuid: 'result-1',
    user_message_uuids: [native.pushes[0]!.uuid],
    queued_turn_count: 1,
  });
  await flush(session);
  assert.equal(closeCount(deltas), 0);
  await new Promise((resolve) => setTimeout(resolve, 90));
  await flush(session);
  assert.equal(session.query(['steer-1'])[0]?.outcome, 'unknown');
  assert.equal(closeCount(deltas), 1);
  await session.close();
});

test('duplicate turn/start and steer input ids are idempotent and never push twice', async () => {
  const { session, native } = await setup();
  const first = await session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Read.' });
  const repeat = await session.startTurn({ inputId: 'initial', clientRequestId: 'client-initial', text: 'Read.' });
  assert.equal(native.pushes.length, 1);
  assert.equal((repeat as any).idempotent, true);
  assert.equal((repeat as any).inputId, (first as any).inputId);
  const steer = await session.steer({ inputId: 'steer-1', clientRequestId: 'client-steer', text: 'Add.' });
  const steerRepeat = await session.steer({ inputId: 'steer-1', clientRequestId: 'client-steer', text: 'Add.' });
  assert.equal(native.pushes.length, 2);
  assert.equal((steerRepeat as any).idempotent, true);
  assert.equal((steerRepeat as any).inputId, (steer as any).inputId);
  await session.close();
});
