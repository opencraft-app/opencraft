import type { RuntimeDiscoveredModelView, RuntimeModelInspectionResponse, RuntimeModelInspectionParams } from '@opencraft/appserver-protocol';
import { withSavedModel } from './saved-model-check.js';

type Json = Record<string, any>;
const record = (v: unknown): Json => v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};
const positive = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined;
const levels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const inputs = (v: unknown) => Array.isArray(v) && v.includes('text') ? v.includes('image') ? ['text', 'image'] as const : ['text'] as const : undefined;

/** Parse declarations, never infer capabilities from model names. */
export function declaredModelCapabilities(value: unknown): Omit<RuntimeDiscoveredModelView, 'id'> {
  const m = record(value), limit = record(m.limit), architecture = record(m.architecture), modalities = record(m.modalities);
  const contextWindow = positive(m.context_window) ?? positive(m.context_length) ?? positive(limit.context);
  const maxTokens = positive(m.max_output_tokens) ?? positive(limit.output);
  const input = inputs(m.input_modalities) ?? inputs(architecture.input_modalities) ?? inputs(modalities.input) ?? inputs(m.input);
  const offered = Array.isArray(m.reasoning_efforts) ? m.reasoning_efforts : Array.isArray(m.reasoning_options)
    ? m.reasoning_options.filter((r: Json) => r?.type === 'effort').flatMap((r: Json) => Array.isArray(r.values) ? r.values : []) : [];
  const accepted = levels.filter(level => offered.includes(level));
  const reasoningEfforts = accepted.length ? Object.fromEntries(accepted.map(level => [level, level])) : undefined;
  return { ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}), ...(input ? { input } : {}), ...(reasoningEfforts ? { reasoningEfforts } : {}) };
}

async function jsonResponse(response: Response, maxBytes = 12 * 1024 * 1024): Promise<Json> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Empty response');
  let size = 0; const chunks: Uint8Array[] = [];
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
    if (size > maxBytes) throw new Error('Response too large'); chunks.push(next.value); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
let directory: { expires: number; value: Promise<Json> } | undefined;
function publicDirectory(fetcher: typeof fetch): Promise<Json> {
  if (directory && directory.expires > Date.now()) return directory.value;
  const value = fetcher('https://models.dev/api.json', { redirect: 'error', signal: AbortSignal.timeout(12_000), headers: { accept: 'application/json' } }).then(r => jsonResponse(r));
  directory = { expires: Date.now() + 3600_000, value };
  value.catch(() => { if (directory?.value === value) directory = undefined; });
  return value;
}
function endpointKey(url: string): string | undefined {
  try { const u = new URL(url); return u.origin + u.pathname.replace(/\/v\d+\/?$/, '').replace(/\/$/, ''); } catch { return undefined; }
}
export function directoryModelCapabilities(data: Json, baseURL: string, model: string) {
  const candidates = Object.values(data).map(record).filter(p => endpointKey(p.api ?? '') === endpointKey(baseURL));
  for (const candidate of candidates) {
    const models = record(candidate.models), row = models[model];
    if (row) return { capabilities: declaredModelCapabilities(row), source: 'models.dev · 同供应商' };
  }
  const slash = model.indexOf('/');
  if (slash > 0) {
    const provider = record(data[model.slice(0, slash)]), row = record(provider.models)[model.slice(slash + 1)];
    if (row) return { capabilities: declaredModelCapabilities(row), source: 'models.dev · 原厂参考，部署上限可能不同' };
  }
  return undefined;
}

// Diagnostic asset created for this project: red block on the left, blue block on the right.
const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAABACAIAAABdtOgoAAAAu0lEQVR4nO3cMQqAQAwAQSP+/8vnCwRtHMSdNk1gSXHNzVpri7PrBf6uAFgBsAJgBcAKgBUAOy4nMy+ucc+TJ8tX1u8CsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgCsANj0cavVBWAFwAqAFQArAFYA7ATsyAp7o+nPawAAAABJRU5ErkJggg==';
const outputText = (body: Json, responses: boolean): string => responses
  ? (Array.isArray(body.output) ? body.output : []).filter((i: Json) => i.type === 'message').flatMap((i: Json) => i.content ?? []).filter((p: Json) => p.type === 'output_text').map((p: Json) => p.text ?? '').join(' ')
  : body.choices?.[0]?.message?.content ?? '';

export async function inspectModelTransport(input: { baseURL: string; model: string; api: 'openai-responses' | 'openai-completions'; apiKey?: string },
  verify: boolean, fetcher: typeof fetch = fetch): Promise<RuntimeModelInspectionResponse> {
  const result: RuntimeModelInspectionResponse = { model: input.model, checkedAt: new Date().toISOString(), capabilities: {}, sources: {}, checks: [], notes: [] };
  const headers = { 'content-type': 'application/json', ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}) };
  const base = input.baseURL.replace(/\/+$/, '');
  const merge = (caps: Omit<RuntimeDiscoveredModelView, 'id'>, source: string) => {
    for (const field of ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts'] as const) {
      if (result.capabilities[field] === undefined && caps[field] !== undefined) {
        Object.assign(result.capabilities, { [field]: caps[field] }); result.sources[field] = source;
      }
    }
  };
  const probeDeadline = AbortSignal.timeout(25_000);
  const [supplier, known] = await Promise.allSettled([
    fetcher(base + '/models', { headers, redirect: 'error', signal: AbortSignal.any([probeDeadline, AbortSignal.timeout(10_000)]) }).then(r => jsonResponse(r, 4 * 1024 * 1024)),
    publicDirectory(fetcher),
  ]);
  if (supplier.status === 'fulfilled') {
    const row = Array.isArray(supplier.value.data) ? supplier.value.data.find((m: unknown) => record(m).id === input.model) : undefined;
    if (row) merge(declaredModelCapabilities(row), '当前供应商 /models 声明');
  } else result.notes.push('供应商未返回可用的模型能力声明。');
  if (known.status === 'fulfilled') {
    const found = directoryModelCapabilities(known.value, base, input.model);
    if (found) merge(found.capabilities, found.source);
  } else result.notes.push('公开模型目录暂不可用，仍可手动设置和验证接口。');
  if (!result.capabilities.contextWindow) result.notes.push('上下文上限未知；短请求不能测出最大窗口，请保留供应商或手动确认的值。');
  if (!verify) return result;
  const responses = input.api === 'openai-responses';
  async function probe(kind: 'text' | 'image' | 'reasoning', effort?: string) {
    const prompt = kind === 'image' ? 'Name the color of the left block, then the right block. Reply only color names separated by a comma.' : 'What is 17 times 19? Reply only the number.';
    const content = kind === 'image' ? responses
      ? [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: imageData }]
      : [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageData } }] : prompt;
    const body = { model: input.model, stream: false, ...(responses
      ? { input: [{ role: 'user', content }], max_output_tokens: 256, ...(effort ? { reasoning: { effort } } : {}) }
      : { messages: [{ role: 'user', content }], max_tokens: 256, ...(effort ? { reasoning_effort: effort } : {}) }) };
    if (probeDeadline.aborted) { result.checks.push({ kind, ...(effort ? { effort } : {}), status: 'unknown', detail: '检查时间已到；未继续发送请求' }); return; }
    try {
      const response = await fetcher(base + (responses ? '/responses' : '/chat/completions'), { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([probeDeadline, AbortSignal.timeout(10_000)]) });
      if (!response.ok) { await response.body?.cancel(); result.checks.push({ kind, ...(effort ? { effort } : {}), status: 'unknown', detail: `HTTP ${response.status}；未据此判定不支持` }); return; }
      const data = await jsonResponse(response, 256 * 1024); const text = outputText(data, responses);
      const good = !data.error && !['failed', 'incomplete', 'cancelled'].includes(data.status) && (kind === 'image' ? /red\s*[,，]\s*blue/i.test(text) : text.trim() === '323');
      const reasoningTokens = positive(data.usage?.output_tokens_details?.reasoning_tokens) ?? positive(data.usage?.completion_tokens_details?.reasoning_tokens) ?? 0;
      result.checks.push({ kind, ...(effort ? { effort } : {}), status: good ? kind === 'reasoning' ? 'accepted' : 'verified' : 'unknown', detail: good ? kind === 'reasoning' ? `参数被接受；返回思考 token ${reasoningTokens}，不证明档位强度差异` : '合成测试通过' : '未得到预期测试结果，能力仍未知' });
    } catch { result.checks.push({ kind, ...(effort ? { effort } : {}), status: 'unknown', detail: '检查未完成；未自动重试' }); }
  }
  await probe('text'); await probe('image');
  // Bound concurrency and cost; no existing conversation or user attachment is sent.
  for (let i = 0; i < levels.length; i += 2) await Promise.all(levels.slice(i, i + 2).map(level => probe('reasoning', level)));
  if (result.checks.some(c => c.kind === 'image' && c.status === 'verified')) { result.capabilities = { ...result.capabilities, input: ['text', 'image'] }; result.sources.input = '当前接口 · 合成图片验证'; }
  const rank = (check: RuntimeModelInspectionResponse['checks'][number]) => check.kind === 'text' ? 0 : check.kind === 'image' ? 1 : 2 + levels.findIndex(level => level === check.effort);
  result.checks.sort((a, b) => rank(a) - rank(b));
  const accepted = levels.filter(level => result.checks.some(c => c.kind === 'reasoning' && c.status === 'accepted' && c.effort === level));
  if (accepted.length) { result.capabilities = { ...result.capabilities, reasoningEfforts: Object.fromEntries(accepted.map(level => [level, level])) }; result.sources.reasoningEfforts = '当前接口 · 参数接受测试（非强度证明）'; }
  return result;
}

export async function inspectSavedModel(input: RuntimeModelInspectionParams, source: Parameters<typeof withSavedModel>[1], fetcher: typeof fetch = fetch) {
  if (!input || !['metadata', 'verify'].includes(input.mode) || Object.keys(input).some(k => !['provider', 'model', 'expectedRevision', 'mode'].includes(k))) throw new Error('无效的能力检查请求');
  const { mode, ...saved } = input;
  const result = await withSavedModel(saved, source, async connection => inspectModelTransport(connection, mode === 'verify', fetcher));
  // A late result must not be presented as evidence about a replacement connection.
  if ((await source.read()).revision !== input.expectedRevision) throw new Error('配置已更新，请重新获取模型能力');
  return { ...result, revision: input.expectedRevision };
}
