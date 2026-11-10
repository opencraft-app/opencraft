import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeProtocolServer } from '../../apps/claude-code-bridge/src/protocol-server.js';
import type { BridgeWireMessage } from '@opencraft/agent-bridge-protocol';
import { FakeClaudeFactory, FakeClaudeNative } from './fixtures/fake-claude-native.js';
import type { NativeStartOptions } from '../../apps/claude-code-bridge/src/types.js';

const emptyInput: AsyncIterable<string> = {
  async *[Symbol.asyncIterator]() {
    // The test feeds chunks explicitly.
  },
};

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await new Promise<void>((accept) => setImmediate(accept));
}

class HangingModelFactory extends FakeClaudeFactory {
  override start(options: NativeStartOptions) {
    const native = super.start(options) as FakeClaudeNative;
    if (options.model === 'hang') native.hangInitialize = true;
    return native;
  }
}

function harness(overrides: { factory?: FakeClaudeFactory; initializeTimeoutMs?: number } = {}) {
  const frames: any[] = [];
  const factory = overrides.factory ?? new FakeClaudeFactory();
  let server!: BridgeProtocolServer;
  const write = (data: string) => {
    for (const line of data.trim().split('\n')) {
      const frame = JSON.parse(line);
      frames.push(frame);
      if (frame.method && typeof frame.id === 'string') {
        // The Host persists a callback request before acknowledging it.
        queueMicrotask(() => {
          void server.feed(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { durable: true } }) + '\n');
        });
      }
    }
  };
  server = new BridgeProtocolServer({
    input: emptyInput,
    write,
    factory,
    callbackTimeoutMs: 1_000,
    ...(overrides.initializeTimeoutMs !== undefined ? { initializeTimeoutMs: overrides.initializeTimeoutMs } : {}),
  });
  return { server, factory, frames };
}

function request(id: string, method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

function response(frames: any[], id: string): any {
  return frames.find((frame) => frame.id === id && 'result' in frame);
}

function failure(frames: any[], id: string): any {
  return frames.find((frame) => frame.id === id && 'error' in frame);
}

test('protocol handshake gates undeclared methods and serves a full session command path', async (t) => {
  const h = harness();
  t.after(() => h.server.close());
  await h.server.feed(request('init', 'initialize', { protocolVersion: 1, grammarRange: { min: 1, max: 1 } }));
  const init = response(h.frames, 'init');
  assert.ok(init);
  assert.deepEqual(init.result.effectiveCapabilities.steer.deliveryMethods, ['native-inject']);
  assert.deepEqual(init.result.effectiveCapabilities.steer.evidenceKinds, ['context-confirmed', 'admission']);

  await h.server.feed(request('history', 'history/read', { threadId: '["s","t"]' }));
  const history = failure(h.frames, 'history');
  assert.ok(history);
  assert.equal(history.error.kind, 'unsupported');
  assert.equal(history.error.code, -32001);

  await h.server.feed(request('bad-env', 'session/create', {
    threadId: '["s","bad"]',
    cwd: '/tmp/claude-protocol',
    env: { CLAUDE_CODE_EXECUTABLE: '/bin/sh' },
  }));
  assert.equal(failure(h.frames, 'bad-env')?.error.kind, 'invalid', 'command env cannot choose the native executable');

  await h.server.feed(request('bad-env-url', 'session/create', {
    threadId: '["s","bad-url"]',
    cwd: '/tmp/claude-protocol',
    env: { ANTHROPIC_BASE_URL: 'https://evil.invalid' },
  }));
  assert.equal(failure(h.frames, 'bad-env-url')?.error.kind, 'invalid', 'command env cannot redirect the credential endpoint');

  await h.server.feed(request('bad-cwd', 'session/create', { threadId: '["s","bad"]' }));
  assert.equal(failure(h.frames, 'bad-cwd')?.error.kind, 'invalid', 'session/create requires an explicit absolute cwd');

  await h.server.feed(request('create', 'session/create', {
    threadId: '["s","t"]',
    cwd: '/tmp/claude-protocol',
    model: 'haiku',
    permissionMode: 'default',
  }));
  const create = response(h.frames, 'create');
  assert.ok(create);
  assert.match(create.result.providerThreadId, /^[0-9a-f-]{36}$/u);
  assert.equal(create.result.sessionRestorable, false);
  const identity = h.frames.find((frame) => frame.method === 'thread/identity');
  assert.ok(identity);
  assert.equal(identity.params.threadId, '["s","t"]');
  assert.equal(identity.params.providerThreadId, create.result.providerThreadId);

  await h.server.feed(request('start', 'turn/start', {
    threadId: '["s","t"]',
    inputId: 'in1',
    clientRequestId: 'client-1',
    text: 'Read note.txt',
  }));
  const start = response(h.frames, 'start');
  assert.ok(start);
  assert.equal(start.result.admitted, true);
  assert.equal(h.factory.last.pushes.length, 1);
  const deltaCallbacks = h.frames.filter((frame) => frame.method === 'thread/delta');
  assert.ok(deltaCallbacks.length >= 1);
  assert.ok(deltaCallbacks.flatMap((frame) => frame.params.deltas).some((delta: any) => delta.op === 'turn.open'));

  h.factory.last.emit({
    type: 'assistant',
    uuid: 'assistant-1',
    message: { content: [{ type: 'text', text: 'Done.' }] },
  });
  h.factory.last.emit({
    type: 'result',
    subtype: 'success',
    uuid: 'result-1',
    user_message_uuids: [h.factory.last.pushes[0]!.uuid],
    queued_turn_count: 0,
  });
  await flush();
  await h.server.bridge.inputStatus('["s","t"]');
  assert.equal(h.server.bridge.inputStatus('["s","t"]')[0]?.evidence, 'context-confirmed');
});

test('a hung model probe cannot head-of-line block another Thread', async (t) => {
  const h = harness({ factory: new HangingModelFactory(), initializeTimeoutMs: 150 });
  t.after(() => h.server.close());
  await h.server.feed(request('init', 'initialize', { protocolVersion: 1, grammarRange: { min: 1, max: 1 } }));

  const probe = h.server.feed(request('probe', 'model/list', { cwd: '/tmp/claude-protocol', model: 'hang' }));
  await h.server.feed(request('create', 'session/create', { threadId: '["s","other"]', cwd: '/tmp/claude-protocol' }));
  assert.ok(response(h.frames, 'create'), 'an unrelated session/create must finish before the probe timeout');
  assert.equal(failure(h.frames, 'probe'), undefined);

  await probe;
  const timedOut = failure(h.frames, 'probe');
  assert.ok(timedOut);
  assert.equal(timedOut.error.kind, 'internal');
});

test('protocol rejects an initialize with no common grammar and unknown methods', async (t) => {
  const h = harness();
  t.after(() => h.server.close());
  await h.server.feed(request('init', 'initialize', { protocolVersion: 1, grammarRange: { min: 2, max: 2 } }));
  const init = failure(h.frames, 'init');
  assert.ok(init);
  assert.equal(init.error.kind, 'unsupported');

  await h.server.feed(request('nope', 'turn/start', { threadId: 'x' }));
  assert.equal(failure(h.frames, 'nope')?.error.message, 'Bridge is not initialized');
});
