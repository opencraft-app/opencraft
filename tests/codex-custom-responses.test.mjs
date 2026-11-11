import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomResponsesGateway, CUSTOM_PROVIDER, customModelId, prepareCustomRequest } from '../scripts/codex-custom-responses.mjs';
import { CustomModelNativeTransport } from '../scripts/codex-custom-model-transport.mjs';

const provider = { id: 'test', name: 'Test', baseUrl: 'https://model.invalid/v1' };
const model = { id: 'test/model', enabled: true, contextWindow: 32000, reasoningEfforts: false };
const id = customModelId(provider.id, model.id);
const catalog = async () => [{ provider, model, apiKey: 'private-test-key' }];
const result = text => ({ id: 'resp_test', object: 'response', status: 'completed', output: [{ id: 'msg_test', type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] });
const sse = events => new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
async function fixture(t, fetchImpl) {
  const gateway = new CustomResponsesGateway({ catalog, fetchImpl }); await gateway.start(); t.after(() => gateway.close());
  const send = (body, endpoint = '/responses', auth = gateway.secret) => fetch(gateway.baseUrl + endpoint, {
    method: 'POST', headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: id, input: 'hello', ...body }),
  });
  return { gateway, send };
}

test('gateway authenticates locally, routes the exact model and never forwards local credentials', async t => {
  let calls = 0;
  const { send, gateway } = await fixture(t, async (url, options) => {
    calls++; assert.equal(String(url), 'https://model.invalid/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer private-test-key');
    assert.notEqual(options.headers.Authorization, 'Bearer ' + gateway.secret);
    assert.equal(JSON.parse(options.body).model, model.id); return Response.json(result('OK'));
  });
  assert.equal((await send({}, '/responses', 'bad')).status, 401);
  assert.equal((await send({ model: customModelId('other', model.id) })).status, 400);
  assert.equal((await (await send({})).json()).output[0].content[0].text, 'OK'); assert.equal(calls, 1);
});

test('namespace and custom tools survive HTTP response and historical replay', async t => {
  let upstream;
  const tools = [{ type: 'namespace', name: 'files', tools: [{ type: 'custom', name: 'patch', description: 'apply', format: { type: 'text' } }] }];
  const { send } = await fixture(t, async (_url, options) => {
    upstream = JSON.parse(options.body);
    return Response.json({ ...result(''), output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: upstream.tools[0].name, arguments: JSON.stringify({ input: 'raw patch' }) }] });
  });
  const response = await (await send({ tools })).json(); const call = response.output[0];
  assert.equal(call.type, 'custom_tool_call'); assert.equal(call.namespace, 'files'); assert.equal(call.name, 'patch'); assert.equal(call.input, 'raw patch');
  const replay = prepareCustomRequest({ tools, input: [call, { type: 'custom_tool_call_output', call_id: call.call_id, output: 'done' }] }, model.id);
  assert.equal(replay.body.input[0].name, upstream.tools[0].name); assert.equal(replay.body.input[1].type, 'function_call_output');
});

test('remote compression wraps a finished summary and restores it on the next request', async t => {
  let body;
  const { send } = await fixture(t, async (_url, options) => { body = JSON.parse(options.body); return Response.json(result('marker: preserved; next: finish')); });
  const response = await (await send({ input: [{ role: 'user', content: 'remember marker' }, { type: 'compaction_trigger' }] })).json();
  assert.equal(response.output.length, 1); assert.equal(response.output[0].type, 'compaction'); assert.equal(body.tool_choice, 'none');
  const prepared = prepareCustomRequest({ input: [response.output[0], { role: 'user', content: 'continue' }] }, model.id);
  assert.match(prepared.body.input[0].content, /marker: preserved/);
  const legacy = await (await send({}, '/responses/compact')).json(); assert.equal(legacy.output[0].type, 'compaction');
});

test('empty, truncated and foreign summaries never become successful compaction', async t => {
  const { send } = await fixture(t, async () => Response.json({ ...result('unfinished'), status: 'incomplete' }));
  const response = await send({ input: [{ type: 'compaction_trigger' }] }); assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'compaction_incomplete');
  assert.throws(() => prepareCustomRequest({ input: [{ type: 'compaction', encrypted_content: 'foreign' }] }, model.id), /previous provider/);
  assert.throws(() => prepareCustomRequest({ input: [{ type: 'compaction', encrypted_content: 'opencraft-summary-v1:!!' }] }, model.id), /invalid/);
});

test('ordinary SSE is incremental and premature EOF becomes failure', async t => {
  let release;
  const { send } = await fixture(t, async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created","response":{"id":"r","output":[]}}\n\n'));
    release = () => controller.close();
  } })));
  const response = await send({ stream: true }); const reader = response.body.getReader();
  const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /response.created/);
  release(); let rest = ''; for (;;) { const part = await reader.read(); if (part.done) break; rest += new TextDecoder().decode(part.value); }
  assert.match(rest, /upstream_truncated/); assert.doesNotMatch(rest, /response.completed/);
});

test('SSE compaction emits exactly one compacted item and no assistant summary message', async t => {
  const { send } = await fixture(t, async () => sse([
    { type: 'response.created', response: { id: 'r', output: [] } },
    { type: 'response.output_text.delta', delta: 'summary' },
    { type: 'response.completed', response: result('summary marker') },
  ]));
  const text = await (await send({ stream: true, input: [{ type: 'compaction_trigger' }] })).text();
  assert.match(text, /opencraft-summary-v1:/); assert.match(text, /response.completed/); assert.doesNotMatch(text, /response.output_text.delta/);
  assert.equal(text.match(/event: response.output_item.done/g)?.length, 1);
});

test('upstream secrets and arbitrary response bodies are absent from errors', async t => {
  const { send } = await fixture(t, async () => new Response('private-test-key prompt secret context length exceeded', { status: 400 }));
  const text = await (await send({})).text(); assert.match(text, /context_length_exceeded/); assert.doesNotMatch(text, /private-test-key|prompt secret/);
});

test('client cancellation aborts the upstream inference', async t => {
  let aborted; const observed = new Promise(resolve => { aborted = resolve; });
  const { gateway } = await fixture(t, async (_url, options) => {
    options.signal.addEventListener('abort', aborted, { once: true });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created","response":{"output":[]}}\n\n')); } }));
  });
  const controller = new AbortController();
  const response = await fetch(gateway.baseUrl + '/responses', { method: 'POST', signal: controller.signal, headers: { Authorization: 'Bearer ' + gateway.secret, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: id, input: 'hi', stream: true }) });
  await response.body.getReader().read(); controller.abort(); await Promise.race([observed, new Promise((_, reject) => setTimeout(() => reject(new Error('abort not propagated')), 2000))]);
});

test('native model list, creation and cold recovery use the declared provider without changing defaults', async () => {
  const listeners = new Set(); const calls = []; let modelProvider = CUSTOM_PROVIDER; let state = 'notLoaded';
  const inner = { status: { state: 'open' }, subscribeMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); }, subscribeStatus() { return () => {}; }, async close() {},
    async send(frame) { const req = JSON.parse(frame); calls.push(req); let value;
      if (req.method === 'model/list') value = { data: [{ id: 'official' }], nextCursor: null };
      if (req.method === 'thread/read') value = { thread: { id: 't', model: id, modelProvider, status: { type: state } } };
      if (['thread/start', 'thread/resume'].includes(req.method)) { state = 'idle'; value = { thread: { id: 't' }, model: req.params.model, modelProvider: req.params.modelProvider }; }
      if (req.method === 'turn/start') value = { turn: { id: 'turn' } };
      for (const listener of listeners) listener(JSON.stringify({ id: req.id, result: value })); },
  };
  const gateway = new CustomResponsesGateway({ catalog: async () => [...await catalog(), { provider: { ...provider, id: 'other' }, model, apiKey: 'other-test-key' }] });
  const transport = new CustomModelNativeTransport(inner, gateway); const replies = [];
  transport.subscribeMessage(frame => replies.push(JSON.parse(frame)));
  try {
    await transport.send(JSON.stringify({ id: 1, method: 'model/list' })); assert.equal(replies.at(-1).result.data[1].id, id);
    await transport.send(JSON.stringify({ id: 2, method: 'thread/start', params: { model: id } }));
    const start = calls.find(c => c.method === 'thread/start'); assert.equal(start.params.modelProvider, CUSTOM_PROVIDER); assert.equal(start.params.config.model_context_window, 32000);
    const reads = calls.filter(c => c.method === 'thread/read').length;
    await transport.send(JSON.stringify({ id: 'first', method: 'turn/start', params: { threadId: 't', input: [] } }));
    assert.equal(calls.filter(c => c.method === 'thread/read').length, reads, 'first input does not require a persisted rollout');
    state = 'notLoaded'; await transport.send(JSON.stringify({ id: 3, method: 'turn/start', params: { threadId: 't', input: [] } }));
    assert.ok(calls.some(c => c.method === 'thread/resume')); assert.equal(calls.at(-1).params.effort, 'none');
    modelProvider = 'openai'; const count = calls.filter(c => c.method === 'turn/start').length;
    await transport.send(JSON.stringify({ id: 4, method: 'turn/start', params: { threadId: 't', model: id, input: [] } }));
    assert.match(replies.at(-1).error.message, /新会话/); assert.equal(calls.filter(c => c.method === 'turn/start').length, count);
    modelProvider = CUSTOM_PROVIDER;
    await transport.send(JSON.stringify({ id: 5, method: 'turn/start', params: { threadId: 't', model: customModelId('other', model.id), input: [] } }));
    assert.match(replies.at(-1).error.message, /不同模型服务连接/); assert.equal(calls.filter(c => c.method === 'turn/start').length, count);
    assert.ok(!calls.some(c => c.method === 'config/write'));
  } finally { await transport.close(); }
});

test('ordinary first input preserves the original transport lifecycle without requiring a rollout', async () => {
  const listeners = new Set(); const calls = [];
  const inner = { status: { state: 'open' }, subscribeMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); }, subscribeStatus() { return () => {}; }, async close() {},
    async send(frame) {
      const req = JSON.parse(frame); calls.push(req.method);
      const result = req.method === 'thread/start' ? { thread: { id: 'ordinary' }, model: 'official', modelProvider: 'openai' } : { turn: { id: 'first' } };
      for (const listener of listeners) listener(JSON.stringify(req.method === 'thread/read' ? { id: req.id, error: { message: 'no rollout found' } } : { id: req.id, result }));
    },
  };
  const transport = new CustomModelNativeTransport(inner, new CustomResponsesGateway({ catalog })); const replies = [];
  transport.subscribeMessage(frame => replies.push(JSON.parse(frame)));
  try {
    await transport.send(JSON.stringify({ id: 1, method: 'thread/start', params: { model: 'official' } }));
    await transport.send(JSON.stringify({ id: 2, method: 'turn/start', params: { threadId: 'ordinary', input: [] } }));
    assert.deepEqual(calls, ['thread/start', 'turn/start']); assert.equal(replies.at(-1).result.turn.id, 'first');
  } finally { await transport.close(); }
});

test('closing one client does not dispose a gateway shared by other clients', async t => {
  const { gateway, send } = await fixture(t, async () => Response.json(result('still available')));
  const inner = { status: { state: 'open' }, subscribeMessage() { return () => {}; }, subscribeStatus() { return () => {}; }, async close() {} };
  const transport = new CustomModelNativeTransport(inner, gateway, { closeGateway: false });
  await transport.close();
  assert.equal((await send({})).status, 200);
  assert.equal((await (await send({})).json()).output[0].content[0].text, 'still available');
});


test('declared reasoning enables native request emission and maps effort values at the HTTP boundary', async t => {
  const thinking = { ...model, reasoningEfforts: { medium: 'medium', high: 'high', off: 'none' } };
  const seen = [];
  const gateway = new CustomResponsesGateway({ catalog: async () => [{ provider, model: thinking, apiKey: "test-reasoning-key" }],
    fetchImpl: async (_url, init) => { seen.push(JSON.parse(init.body)); return Response.json(result('323')); } });
  t.after(() => gateway.close());
  const transport = new CustomModelNativeTransport({ subscribeMessage() { return () => {}; }, subscribeStatus() { return () => {}; } }, gateway);
  const defined = await transport.definition({}, { provider, model: thinking });
  assert.equal(defined.config.model_supports_reasoning_summaries, true);
  assert.equal(defined.config.model_reasoning_effort, 'medium');
  assert.equal(defined.config.model_reasoning_summary, 'none');
  const configured = await transport.definition({ config: { model_reasoning_effort: 'high' } }, { provider, model: thinking });
  assert.equal(configured.config.model_reasoning_effort, 'high');
  const plain = await transport.definition({}, { provider, model });
  assert.equal(plain.config.model_supports_reasoning_summaries, undefined);
  assert.equal(plain.config.model_reasoning_effort, 'none');
  const send = effort => fetch(gateway.baseUrl + '/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + gateway.secret },
    body: JSON.stringify({ model: id, input: '17 times 19?', reasoning: { effort } }) });
  assert.equal((await send('high')).status, 200); assert.equal(seen.at(-1).reasoning.effort, 'high');
  assert.equal((await send('none')).status, 200); assert.equal(seen.at(-1).reasoning.effort, 'none');
  const count = seen.length; assert.equal((await send('low')).status, 400); assert.equal(seen.length, count);
});
