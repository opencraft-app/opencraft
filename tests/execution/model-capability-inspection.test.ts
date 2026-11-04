import test from 'node:test';
import assert from 'node:assert/strict';
import { declaredModelCapabilities, directoryModelCapabilities, inspectModelTransport, inspectSavedModel } from '../../apps/local-agent-host/src/model-capability-inspection';
import type { ModelDocument } from '../../apps/local-agent-host/src/model-config/model-document';
const response = (text: string) => Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { output_tokens_details: { reasoning_tokens: 12 } } });
const connection = { baseURL: 'https://provider.invalid/v1', model: 'vendor/model', api: 'openai-responses' as const, apiKey: 'synthetic-private-key' };
function fetcher(log: any[], failImage = false): typeof fetch {
  return (async (url: any, init: any) => {
    const target = String(url); log.push({ target, ...init });
    if (target === 'https://models.dev/api.json') { assert.equal(init.headers.authorization, undefined); return Response.json({ vendor: { api: 'https://factory.invalid/v1', models: { model: { limit: { context: 1048576, output: 32000 }, modalities: { input: ['text', 'image'] }, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] } } } }); }
    assert.equal(init.headers.authorization, 'Bearer synthetic-private-key');
    if (target.endsWith('/models')) return Response.json({ data: [{ id: 'vendor/model', context_window: 262144, modalities: { input: ['text'] } }] });
    const body = JSON.parse(init.body); const image = JSON.stringify(body.input ?? body.messages).includes('image');
    if (image && failImage) return new Response('arbitrary secret upstream details', { status: 400 });
    if (body.reasoning?.effort === 'minimal') await new Promise(r => setTimeout(r, 10));
    return response(image ? 'red, blue' : '323');
  }) as typeof fetch;
}
test('declarations validate numeric limits and efforts without guessing names', () => {
  assert.deepEqual(declaredModelCapabilities({ id: 'vision-model', context_length: '262144', reasoning: true }), {});
  assert.deepEqual(declaredModelCapabilities({ context_length: 262144, limit: { output: 4096 }, input_modalities: ['text', 'image'], reasoning_options: [{ type: 'effort', values: ['high', 'nonsense'] }] }), { contextWindow: 262144, maxTokens: 4096, input: ['text', 'image'], reasoningEfforts: { high: 'high' } });
});
test('directory requires matching deployment or an explicit vendor/model identity', () => {
  const data = { vendor: { api: 'https://provider.invalid/v1', models: { model: { limit: { context: 262144 } } } } };
  assert.match(directoryModelCapabilities(data, connection.baseURL, 'model')!.source, /同供应商/);
  assert.equal(directoryModelCapabilities(data, 'https://provider.invalid/other/v1', 'model'), undefined);
  assert.match(directoryModelCapabilities(data, 'https://other.invalid/v1', 'vendor/model')!.source, /原厂参考/);
  assert.equal(directoryModelCapabilities(data, 'https://other.invalid/v1', 'new-model'), undefined);
});
test('metadata uses supplier limits first, labels fallback and never sends the key to the public directory', async () => {
  const log: any[] = []; const result = await inspectModelTransport(connection, false, fetcher(log));
  assert.equal(result.capabilities.contextWindow, 262144); assert.match(result.sources.contextWindow!, /供应商/);
  assert.equal(result.capabilities.maxTokens, 32000); assert.match(result.sources.maxTokens!, /原厂参考/);
  assert.deepEqual(result.checks, []); assert.equal(log.some(r => r.method === 'POST'), false);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-key/);
});
test('verification distinguishes image evidence, accepted parameters and unknown without copying upstream errors', async () => {
  const log: any[] = []; const result = await inspectModelTransport(connection, true, fetcher(log));
  assert.equal(log.filter(r => r.method === 'POST').length, 8); assert.equal(result.checks.filter(c => c.status === 'accepted').length, 6);
  assert.deepEqual(Object.keys(result.capabilities.reasoningEfforts || {}), ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(result.checks.filter(c => c.kind === 'reasoning').map(c => c.effort), ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(result.capabilities.input, ['text', 'image']); assert.match(result.sources.input!, /合成图片/);
  const fail = await inspectModelTransport(connection, true, fetcher([], true));
  assert.equal(fail.checks.find(c => c.kind === 'image')!.status, 'unknown');
  assert.doesNotMatch(JSON.stringify(fail), /arbitrary secret/);
});
test('saved inspections reject caller destinations, stale/late revisions and credentials before touching the network', async () => {
  const doc: ModelDocument = { schemaVersion: 1, revision: 2, defaultModel: null, providers: [{ id: 'p', name: 'P', protocol: connection.api, baseUrl: connection.baseURL, enabled: false, credentialRef: 'KEY', models: [{ id: connection.model, enabled: true }] }] };
  const input = { provider: 'p', model: connection.model, expectedRevision: 2, mode: 'metadata' as const };
  const source = { read: async () => structuredClone(doc), credential: async () => 'synthetic-private-key' }; const log: any[] = [];
  await assert.rejects(inspectSavedModel({ ...input, baseURL: 'https://attacker.invalid' } as any, source, fetcher(log))); assert.equal(log.length, 0);
  await assert.rejects(inspectSavedModel({ ...input, expectedRevision: 1 }, source, fetcher(log))); assert.equal(log.length, 0);
  const changed = { ...source, credential: async () => { doc.revision++; return 'synthetic-private-key'; } };
  await assert.rejects(inspectSavedModel(input, changed, fetcher(log)), /配置已更新/); assert.equal(log.length, 0);
  doc.revision = 2;
  const late = (async (url: any, init: any) => { const result = await fetcher(log)(url, init); doc.revision = 3; return result; }) as typeof fetch;
  await assert.rejects(inspectSavedModel(input, source, late), /配置已更新/);
});
