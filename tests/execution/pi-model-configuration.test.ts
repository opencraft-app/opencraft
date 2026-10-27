import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import WebSocket from 'ws';
import {startEngineHost} from '../../apps/local-agent-host/src/engine-host.js';
import {mkdtemp, mkdir, rm, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPiModelConfiguration} from '../../apps/local-agent-host/src/model-config/pi-adapter.js';
import {ModelConfigurationRepository, ModelCredentialRepository} from '../../apps/local-agent-host/src/model-config/repository.js';
import {PiEngine, piModel} from '../../plugins/pi-engine/src/index.js';
import {getSupportedThinkingLevels} from '@earendil-works/pi-ai/models';
import type {ModelDocument} from '../../apps/local-agent-host/src/model-config/model-document.js';

const client = {notify() {}, async request() {throw new Error('Unexpected tool request');}};
const seed = (): ModelDocument => ({schemaVersion: 1, revision: 0, defaultModel: null, providers: [{
  id: 'custom-stable', name: 'Arbitrary endpoint', protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1',
  credentialRef: 'EXAMPLE_CREDENTIAL', enabled: true, models: [{id: 'arbitrary-model', name: 'Example', enabled: true,
    input: ['text'], contextWindow: 98765, maxTokens: 2345, reasoningEfforts: {low: 'economical', high: 'thorough'}}],
}]});
async function fixture(t: test.TestContext, document = seed(), legacy?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-model-config-')); t.after(() => rm(dir, {recursive: true, force: true}));
  const directory = join(dir, 'pi'); await mkdir(directory);
  if (legacy) await writeFile(join(directory, 'models.json'), JSON.stringify(legacy));
  const repository = new ModelConfigurationRepository(join(dir, 'models'));
  await repository.initialize(document);
  const credentials = new ModelCredentialRepository(join(dir, 'models')); await credentials.set('EXAMPLE_CREDENTIAL', 'test-key-in-memory');
  const config = await createPiModelConfiguration(join(dir, 'models'), directory);
  const engine = new PiEngine({...config, directory, cwd: dir}); t.after(() => engine.close()); await engine.start();
  return {dir, directory, repository, credentials, config, engine,
    update: async (change: (draft: ModelDocument) => void) => repository.update((await repository.read()).revision, change)};
}

test('same Pi instance dynamically projects capabilities, wire levels, model edits and defaults', async t => {
  const f = await fixture(t); const id = piModel('custom-stable', 'arbitrary-model');
  let rows = await f.engine.models(); assert.equal(rows.length, 1); assert.equal(rows[0].isDefault, false);
  assert.deepEqual(rows[0].supportedReasoningEfforts.map((r: any) => r.reasoningEffort), ['low', 'high']);
  assert.deepEqual(rows[0].inputModalities, ['text']); assert.equal(rows[0].contextWindow, 98765);
  assert.equal((await f.engine.request('config/read', {}, client)).config.model, null);
  await assert.rejects(f.engine.request('thread/start', {}, client), /select a Pi model/);
  const started = await f.engine.request('thread/start', {model: id, effort: 'high'}, client);
  assert.equal(started.reasoningEffort, 'high');
  await f.update(doc => {
    const model = doc.providers[0]!.models[0]!; model.input = ['text', 'image']; model.name = 'Renamed model';
    model.reasoningEfforts = {off: null, medium: 'balanced', max: 'exhaustive'}; model.maxTokens = 5000;
    doc.defaultModel = {providerId: 'custom-stable', modelId: model.id, reasoningEffort: 'max'};
  });
  rows = await f.engine.models(); assert.deepEqual(rows[0].inputModalities, ['text', 'image']);
  assert.deepEqual(rows[0].supportedReasoningEfforts.map((r: any) => r.reasoningEffort), ['none', 'medium', 'max']);
  assert.equal(rows[0].displayName, 'Renamed model'); assert.equal(rows[0].maxTokens, 5000);
  assert.equal(rows[0].defaultReasoningEffort, 'max'); assert.equal(rows[0].isDefault, true);
  const model = f.config.models.getModel('custom-stable', 'arbitrary-model')!;
  assert.equal(model.thinkingLevelMap?.medium, 'balanced'); assert.equal(model.thinkingLevelMap?.max, 'exhaustive');
  assert.equal(model.thinkingLevelMap?.off, undefined); // explicitly supported off omits its wire field
  await assert.rejects(f.engine.request('thread/resume', {threadId: started.thread.id, effort: 'high'}, client), /does not support reasoning effort/);
  assert.equal((await f.engine.request('thread/read', {threadId: started.thread.id}, client)).thread.model, id);
  const resumed = await f.engine.request('thread/resume', {threadId: started.thread.id, effort: 'max'}, client);
  assert.equal(resumed.reasoningEffort, 'max');
  await f.engine.request('config/batchWrite', {edits: [{keyPath: 'model', value: id}, {keyPath: 'model_reasoning_effort', value: 'medium'}]}, client);
  assert.equal((await f.repository.read()).defaultModel!.reasoningEffort, 'medium');
  await f.update(doc => {doc.providers[0]!.models.push({id: 'second-random-id', enabled: true, reasoningEfforts: false});});
  assert.equal((await f.engine.models()).length, 2);
  await f.update(doc => {doc.providers[0]!.models[0]!.enabled = false; doc.defaultModel = null;});
  assert.deepEqual((await f.engine.models()).map(row => row.model), [piModel('custom-stable', 'second-random-id')]);
  await assert.rejects(f.engine.request('thread/start', {model: id}, client), /unavailable/);
  await f.update(doc => {doc.providers[0]!.enabled = false;}); assert.deepEqual(await f.engine.models(), []);
});

test('legacy alias is a one-time unique metadata match and survives rename, restart and native-file edits', async t => {
  const legacy = {providers: {'legacy-alias': {name: 'Arbitrary endpoint', api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:9/v1', apiKey: '!DO-NOT-EXECUTE', models: [{id: 'arbitrary-model'}]}}};
  const f = await fixture(t, seed(), legacy); const id = piModel('legacy-alias', 'arbitrary-model');
  assert.equal((await f.engine.models())[0].model, id);
  await f.update(doc => {doc.providers[0]!.name = 'Renamed endpoint'; doc.providers[0]!.models[0]!.input = ['text', 'image'];});
  assert.equal((await f.engine.models())[0].model, id);
  assert.equal((await readFile(join(f.directory, 'models.json'), 'utf8')), JSON.stringify(legacy));
  await writeFile(join(f.directory, 'models.json'), '{invalid legacy JSON after migration');
  const reopened = await createPiModelConfiguration(join(f.dir, 'models'), f.directory); await reopened.configuration.synchronize();
  assert.ok(reopened.models.getModel('legacy-alias', 'arbitrary-model')!.input.includes('image'));
  assert.equal(reopened.models.getModel('custom-stable', 'arbitrary-model'), undefined);
});

test('credential rotation/removal and unbound references update availability without an auth copy', async t => {
  const f = await fixture(t);
  assert.equal((await f.config.models.getAuth('custom-stable'))!.auth.apiKey, 'test-key-in-memory');
  await f.credentials.set('EXAMPLE_CREDENTIAL', 'rotated-key'); await f.engine.models();
  assert.equal((await f.config.models.getAuth('custom-stable'))!.auth.apiKey, 'rotated-key');
  await f.credentials.remove('EXAMPLE_CREDENTIAL'); assert.deepEqual(await f.engine.models(), []);
  await assert.rejects(f.engine.request('thread/start', {model: piModel('custom-stable', 'arbitrary-model')}, client), /unavailable/);
  await f.update(doc => {doc.providers[0]!.credentialRef = null;}); assert.deepEqual(await f.engine.models(), []);
  await f.credentials.set('EXAMPLE_CREDENTIAL', 'newly-bound-key');
  assert.deepEqual(await f.engine.models(), []);
  await f.update(doc => {doc.providers[0]!.credentialRef = 'EXAMPLE_CREDENTIAL';});
  assert.equal((await f.engine.models()).length, 1);
  await assert.rejects(readFile(join(f.directory, 'auth.json')), {code: 'ENOENT'});
});

test('bad configuration fails closed and can recover at the same revision; speech stays out of Pi', async t => {
  const f = await fixture(t);
  await f.update(doc => {doc.providers.push({id: 'speech-only', name: 'Speech', protocol: 'hunyuan-asr', baseUrl: 'https://tokenhub.tencentmaas.com', credentialRef: 'EXAMPLE_CREDENTIAL', enabled: true, models: [{id: 'arbitrary-asr', type: 'asr', enabled: true}]});});
  assert.equal((await f.engine.models()).length, 1);
  const path = f.repository.path; const original = await readFile(path, 'utf8');
  await writeFile(path, '{broken'); await assert.rejects(f.engine.models());
  await assert.rejects(f.engine.request('thread/start', {model: piModel('custom-stable', 'arbitrary-model')}, client));
  await writeFile(path, original); assert.equal((await f.engine.models()).length, 1);
  await f.update(doc => {doc.providers[0]!.protocol = 'unregistered-protocol';});
  await assert.rejects(f.engine.models(), /不支持/);
  await f.update(doc => {doc.providers[0]!.protocol = 'openai-completions';});
  assert.equal((await f.engine.models()).length, 1);
  await f.update(doc => {doc.providers[0]!.models[0]!.reasoningEfforts = false;});
  assert.deepEqual(getSupportedThinkingLevels((await f.engine.models(), f.config.models.getModel('custom-stable', 'arbitrary-model')!)), ['off']);
});


test('native SDK request preserves configured reasoning wire values and image input after hot update', async t => {
  const requests: {body: any; authorization?: string}[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({body: JSON.parse(Buffer.concat(chunks).toString()), authorization: req.headers.authorization});
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write('data: '+JSON.stringify({id: 'synthetic', object: 'chat.completion.chunk', choices: [{index: 0, delta: {role: 'assistant', content: 'synthetic answer'}, finish_reason: null}]})+'\n\n');
    res.end('data: '+JSON.stringify({id: 'synthetic', object: 'chat.completion.chunk', choices: [{index: 0, delta: {}, finish_reason: 'stop'}]})+'\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => {server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());}));
  const doc = seed(); doc.providers[0]!.baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const f = await fixture(t, doc);
  const send = (reasoning: 'low' | 'max' | undefined, image = false) => f.config.models.completeSimple(
    f.config.models.getModel('custom-stable', 'arbitrary-model')!, {messages: [{role: 'user', timestamp: Date.now(),
      content: [{type: 'text', text: 'synthetic request'}, ...(image ? [{type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw1cAAAAASUVORK5CYII='}] : [])]}]},
    {reasoning, maxTokens: 10});
  assert.equal((await send('low')).stopReason, 'stop'); assert.equal(requests[0]!.body.reasoning_effort, 'economical');
  await f.update(value => {value.providers[0]!.models[0]!.reasoningEfforts = {off: null, max: 'exhaustive'};
    value.providers[0]!.models[0]!.input = ['text', 'image'];});
  await f.credentials.set('EXAMPLE_CREDENTIAL', 'new-synthetic-key'); await f.engine.models();
  assert.equal((await send('max', true)).stopReason, 'stop');
  assert.equal(requests[1]!.body.reasoning_effort, 'exhaustive');
  assert.equal(requests[1]!.authorization, 'Bearer new-synthetic-key');
  assert.equal(requests[1]!.body.messages[0].content[1].type, 'image_url');
  assert.equal((await send(undefined)).stopReason, 'stop'); assert.equal(Object.hasOwn(requests[2]!.body, 'reasoning_effort'), false);
});


test('Engine Host preserves an explicit missing model default and refreshes a later configured default', async t => {
  const f = await fixture(t);
  const host = await startEngineHost({providers: [f.engine], defaultEngine: 'pi'}); t.after(() => host.close());
  const socket = new WebSocket(host.websocketUrl); await once(socket, 'open'); t.after(() => socket.close());
  let id = 0;
  const call = (method: string) => new Promise<any>((resolve, reject) => {
    const key = ++id;
    const listener = (raw: WebSocket.RawData) => {const value = JSON.parse(String(raw)); if (value.id !== key) return;
      socket.off('message', listener); value.error ? reject(new Error(value.error.message)) : resolve(value.result);};
    socket.on('message', listener); socket.send(JSON.stringify({jsonrpc: '2.0', id: key, method, params: {}}));
  });
  assert.equal((await call('model/list')).data.some((row: any) => row.isDefault), false);
  assert.equal((await call('config/read')).config.model, null);
  await f.update(doc => {doc.defaultModel = {providerId: 'custom-stable', modelId: 'arbitrary-model', reasoningEffort: 'high'};});
  const selected = (await call('model/list')).data.filter((row: any) => row.isDefault);
  assert.equal(selected.length, 1); assert.equal(selected[0].model, piModel('custom-stable', 'arbitrary-model'));
  assert.equal((await call('config/read')).config.model_reasoning_effort, 'high');
});
