import { createServer } from 'node:http';
import { generateCustomImage } from './custom-image-generation.mjs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';

export const CUSTOM_MODEL_PREFIX = 'custom-responses:';
export const CUSTOM_PROVIDER = 'opencraft-custom-responses';
const SUMMARY_TAG = 'opencraft-summary-v1:';
const MAX_BYTES = 16 * 1024 * 1024;
const summaryInstruction = 'Summarize this conversation for continuation by another assistant. Preserve the user goal, constraints, completed work, decisions, unresolved issues, next actions, and references. Do not perform tools or continue the task. Return only the handoff summary.';

export function customModelId(provider, model) {
  return CUSTOM_MODEL_PREFIX + encodeURIComponent(provider) + '/' + encodeURIComponent(model);
}

export function decodeCustomModel(id) {
  if (typeof id !== 'string' || !id.startsWith(CUSTOM_MODEL_PREFIX)) return null;
  const parts = id.slice(CUSTOM_MODEL_PREFIX.length).split('/');
  if (parts.length !== 2) throw new Error('Invalid custom model identity');
  try { return { provider: decodeURIComponent(parts[0]), model: decodeURIComponent(parts[1]) }; }
  catch { throw new Error('Invalid custom model identity'); }
}

function failure(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function summaryItem(text) {
  return { type: 'compaction', id: 'cmp_' + randomUUID(), encrypted_content: SUMMARY_TAG + Buffer.from(text).toString('base64url') };
}
function summaryText(item) {
  if (!['compaction', 'context_compaction', 'compaction_summary'].includes(item.type)) return null;
  const value = item.encrypted_content;
  if (typeof value !== 'string' || !value.startsWith(SUMMARY_TAG))
    throw failure('incompatible_compaction', 'This model cannot read the previous provider summary. Continue with the original provider or create a new conversation.');
  const payload = value.slice(SUMMARY_TAG.length);
  const bytes = Buffer.from(payload, 'base64url');
  const text = bytes.toString('utf8');
  if (!text.trim() || bytes.toString('base64url') !== payload || !Buffer.from(text).equals(bytes))
    throw failure('invalid_compaction', 'Stored summary is invalid; the original history was not replaced.');
  return text;
}

/** Translate only caller-owned tools. The upstream never executes local tools. */
export function prepareCustomRequest(request, upstreamModel, compactEndpoint = false) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw failure('invalid_request', 'Expected a Responses request.');
  if (request.previous_response_id || request.conversation || request.background)
    throw failure('unsupported_state', 'Custom models require explicit history and foreground execution.');
  const reverse = new Map();
  const alias = (tool, namespace) => {
    if (!['function', 'custom'].includes(tool.type) || typeof tool.name !== 'string')
      throw failure('unsupported_tool', 'This custom model connection supports caller-owned function and custom tools only.');
    const name = 'oc_' + createHash('sha256').update(JSON.stringify([namespace ?? null, tool.type, tool.name])).digest('hex').slice(0, 32);
    reverse.set(name, { type: tool.type, name: tool.name, ...(namespace ? { namespace } : {}) });
    return name;
  };
  const tools = [];
  const flatten = (items, namespace) => {
    for (const tool of items) {
      if (tool.type === 'namespace') {
        flatten(tool.tools ?? [], namespace ? namespace + '.' + tool.name : tool.name);
      } else {
        const name = alias(tool, namespace);
        tools.push(tool.type === 'function' ? { ...tool, name } : {
          type: 'function', name, description: (tool.description ?? '') + '\nProvide the exact raw tool input in the input string. Format: ' + JSON.stringify(tool.format ?? {}),
          parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false },
        });
      }
    }
  };
  flatten(request.tools ?? []);
  let compact = compactEndpoint;
  const input = typeof request.input === 'string' ? [{ role: 'user', content: request.input }] : request.input;
  if (!Array.isArray(input)) throw failure('invalid_request', 'Explicit input history is required.');
  const rewritten = input.map(item => {
    if (item.type === 'compaction_trigger') { compact = true; return { role: 'user', content: summaryInstruction }; }
    const text = summaryText(item);
    if (text !== null) return { role: 'user', content: 'Conversation handoff summary:\n' + text };
    if (item.type === 'agent_message') throw failure('unsupported_agent_message', 'This connection does not support provider-encrypted agent tasks.');
    if (['function_call', 'custom_tool_call'].includes(item.type)) {
      const custom = item.type === 'custom_tool_call';
      const { namespace, ...rest } = item;
      const call = { ...rest, type: 'function_call', name: alias({ type: custom ? 'custom' : 'function', name: item.name }, namespace) };
      if (custom) { call.arguments = JSON.stringify({ input: item.input }); delete call.input; }
      return call;
    }
    if (item.type === 'custom_tool_call_output') return { ...item, type: 'function_call_output' };
    return item;
  });
  if (compactEndpoint) rewritten.push({ role: 'user', content: summaryInstruction });
  const body = { ...request, model: upstreamModel, input: rewritten, store: false };
  if (request.tools) body.tools = tools;
  if (request.tool_choice && typeof request.tool_choice === 'object') {
    const { type, name, namespace } = request.tool_choice;
    body.tool_choice = { type: 'function', name: alias({ type, name }, namespace) };
  }
  if (compact) { body.tool_choice = 'none'; delete body.text; }
  return { body, reverse, compact };
}

function restoreItem(item, reverse) {
  if (item?.type !== 'function_call') return item;
  const identity = reverse.get(item.name);
  if (!identity) throw failure('unknown_tool', 'The model returned an undeclared tool.', 502);
  if (identity.type === 'custom') {
    let args;
    try { args = JSON.parse(item.arguments); } catch { throw failure('invalid_tool_arguments', 'The model returned invalid custom tool input.', 502); }
    if (typeof args?.input !== 'string') throw failure('invalid_tool_arguments', 'The model returned invalid custom tool input.', 502);
    const { arguments: _arguments, ...rest } = item;
    return { ...rest, ...identity, type: 'custom_tool_call', input: args.input };
  }
  return { ...item, ...identity, type: 'function_call' };
}
function outputText(response) {
  return (response.output ?? []).filter(item => item.type === 'message' && item.role === 'assistant')
    .flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text).join('\n');
}
function finishSummary(response) {
  const text = outputText(response);
  if (response.status !== 'completed' || !text.trim() || (response.output ?? []).some(item => item.type.endsWith('_call')))
    throw failure('compaction_incomplete', 'The model did not finish the summary; original history must be retained.', 502);
  return { ...response, output: [summaryItem(text)] };
}
function restoreResponse(response, reverse) { return { ...response, output: (response.output ?? []).map(item => restoreItem(item, reverse)) }; }
const eventBytes = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

async function* upstreamEvents(body) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  for await (const bytes of body) {
    pending += decoder.decode(bytes, { stream: true });
    if (Buffer.byteLength(pending) > MAX_BYTES) throw failure('upstream_limit', 'Upstream event exceeds the size limit.', 502);
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(pending))) {
      const block = pending.slice(0, boundary.index); pending = pending.slice(boundary.index + boundary[0].length);
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) throw failure('upstream_truncated', 'Upstream stream ended inside an event.', 502);
}

async function boundedText(response, limit = MAX_BYTES) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw failure('upstream_limit', 'Model response exceeds the size limit.', 502);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Loopback-only API boundary. Credentials are read through the existing owner. */
export class CustomResponsesGateway {
  constructor({ catalog, imageConfiguration, imageFetch = fetch, fetchImpl = fetch, timeoutMs = 120_000, imageTimeoutMs = 180_000 }) {
    this.catalog = catalog; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
    this.imageConfiguration = imageConfiguration; this.imageFetch = imageFetch; this.imageTimeoutMs = imageTimeoutMs; this.imageTurns = new Map();
    this.secret = randomBytes(32).toString('hex'); this.active = new Set(); this.closed = false;
  }
  async start() {
    if (this.closed) throw new Error('Custom model gateway is closed');
    this.starting ??= (async () => {
      this.server = createServer((request, response) => { void this.handle(request, response); });
      this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening');
      this.baseUrl = `http://127.0.0.1:${this.server.address().port}/v1`;
      return this.baseUrl;
    })();
    return this.starting;
  }
  async imageAvailable() { return !!await this.imageConfiguration?.(); }
  async definition({ images = false } = {}) {
    return { name: 'OpenCraft custom Responses', base_url: await this.start(), wire_api: 'responses',
      requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0,
      http_headers: { Authorization: 'Bearer ' + this.secret, ...(images ? { 'x-openai-actor-authorization': this.secret } : {}) } };
  }
  async handle(request, response) {
    const controller = new AbortController(); this.active.add(controller);
    const imageEndpoint = ['/v1/images/generations', '/v1/images/edits'].includes(request.url);
    const timer = setTimeout(() => controller.abort(), imageEndpoint ? this.imageTimeoutMs : this.timeoutMs); timer.unref();
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', cancel); request.once('aborted', cancel);
    try {
      const auth = Buffer.from(request.headers.authorization ?? ''); const expected = Buffer.from('Bearer ' + this.secret);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) throw failure('unauthorized', 'Unauthorized', 401);
      const compactEndpoint = request.url === '/v1/responses/compact';
      if (request.method !== 'POST' || !imageEndpoint && !['/v1/responses', '/v1/responses/compact'].includes(request.url)) throw failure('not_found', 'Unknown endpoint', 404);
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > MAX_BYTES) throw failure('request_limit', 'Request exceeds the size limit.', 413); chunks.push(chunk); }
      let incoming; try { incoming = JSON.parse(Buffer.concat(chunks)); } catch { throw failure('invalid_json', 'Invalid JSON request.'); }
      if (imageEndpoint) {
        const turn = this.imageTurns.get(request.headers['x-codex-image-turn-id']);
        if (request.headers['x-openai-actor-authorization'] !== this.secret || !turn || turn.expiresAt <= Date.now())
          throw failure('image_turn_unknown', '图像生成需要已接纳的非订阅模型回合。', 409);
        const source = (await this.catalog()).find(item => customModelId(item.provider.id, item.model.id) === turn.source);
        if (!source?.model.input?.includes('image')) throw failure('image_model_unavailable', '原对话模型已停用或不支持图片。', 409);
        const image = await this.imageConfiguration?.();
        if (!image || image.binding !== turn.binding) throw failure('image_config_changed', '图像模型配置已改变或不可用，请重新发送。', 409);
        if (request.url.endsWith('/edits') && !incoming.images?.length || request.url.endsWith('/generations') && incoming.images?.length)
          throw failure('invalid_image_request', '图像操作与参考图不匹配。');
        const result = await generateCustomImage(incoming, image, { signal: controller.signal, fetchImpl: this.imageFetch });
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result)); return;
      }
      const selected = (await this.catalog()).find(item => customModelId(item.provider.id, item.model.id) === incoming.model);
      if (!selected) throw failure('model_unavailable', 'The selected custom model is disabled or unavailable.');
      if (!compactEndpoint && selected.model.input?.includes('image') && request.headers['x-openai-actor-authorization'] === this.secret) {
        let metadata; try { metadata = JSON.parse(request.headers['x-codex-turn-metadata'] ?? '{}'); } catch { metadata = {}; }
        const turnId = metadata.turn_id;
        if (typeof turnId === 'string' && turnId.length < 256) {
          for (const [id, turn] of this.imageTurns) if (turn.expiresAt <= Date.now()) this.imageTurns.delete(id);
          const image = await this.imageConfiguration?.();
          if (image && !this.imageTurns.has(turnId)) {
            while (this.imageTurns.size >= 8192) this.imageTurns.delete(this.imageTurns.keys().next().value);
            this.imageTurns.set(turnId, { source: incoming.model, binding: image.binding, expiresAt: Date.now() + 24*60*60*1000 });
          }
        }
      }
      const { body, reverse, compact } = prepareCustomRequest(incoming, selected.model.id, compactEndpoint);
      if (selected.model.maxTokens) body.max_output_tokens = Math.min(body.max_output_tokens ?? selected.model.maxTokens, selected.model.maxTokens);
      if (body.reasoning?.effort && selected.model.reasoningEfforts && typeof selected.model.reasoningEfforts === 'object') {
        const level = body.reasoning.effort === 'none' ? 'off' : body.reasoning.effort;
        const wire = selected.model.reasoningEfforts[level];
        if (wire === undefined) throw failure('unsupported_reasoning', 'The selected model does not support this reasoning level.');
        body.reasoning = wire === null ? undefined : { ...body.reasoning, effort: wire };
      }
      const url = new URL(selected.provider.baseUrl.replace(/\/$/, '') + '/responses');
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw failure('invalid_endpoint', 'Invalid provider endpoint.');
      const headers = { 'Content-Type': 'application/json', Accept: incoming.stream ? 'text/event-stream' : 'application/json' };
      if (selected.apiKey) headers.Authorization = 'Bearer ' + selected.apiKey;
      else if (selected.provider.authentication !== 'none') throw failure('credential_missing', 'The selected custom model has no configured credential.');
      const upstream = await this.fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'manual' });
      if (!upstream.ok) {
        const details = await boundedText(upstream, 32768);
        const context = /context.{0,32}(?:length|window|limit)|maximum context/i.test(details);
        throw failure(context ? 'context_length_exceeded' : 'upstream_rejected', context ? 'Model context limit exceeded; compact or reduce the input.' : `Model service rejected the request (HTTP ${upstream.status}).`, upstream.status >= 400 ? upstream.status : 502);
      }
      if (!incoming.stream) {
        const text = await boundedText(upstream);
        let result = JSON.parse(text); result = compact ? finishSummary(result) : restoreResponse(result, reverse);
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result)); return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      let completed = false, sequence = 0; const calls = new Map();
      const write = async event => { if (!response.write(eventBytes({ ...event, sequence_number: sequence++ }))) await once(response, 'drain', { signal: controller.signal }); };
      for await (const event of upstreamEvents(upstream.body)) {
        if (controller.signal.aborted) throw failure('cancelled', 'Request cancelled.', 499);
        if (completed) continue;
        if (event.type === 'response.completed') {
          const result = compact ? finishSummary(event.response) : restoreResponse(event.response, reverse);
          if (compact) {
            const item = result.output[0];
            await write({ type: 'response.output_item.added', output_index: 0, item });
            await write({ type: 'response.output_item.done', output_index: 0, item });
          }
          await write({ ...event, response: result }); completed = true;
        } else if (compact) {
          if (event.type === 'response.created' || event.type === 'response.in_progress') await write({ ...event, response: { ...event.response, output: [] } });
          if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) throw failure('compaction_incomplete', 'The model did not finish the summary; original history must be retained.', 502);
        } else {
          if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
            const identity = reverse.get(event.item.name);
            if (!identity) throw failure('unknown_tool', 'The model returned an undeclared tool.', 502);
            calls.set(event.item.id, { identity, arguments: '' });
            if (identity.type === 'custom') {
              const { arguments: _arguments, ...item } = event.item;
              event.item = { ...item, ...identity, type: 'custom_tool_call', input: '' };
            }
            else event.item = { ...event.item, ...identity, type: 'function_call' };
          }
          if (event.type === 'response.function_call_arguments.delta' && calls.get(event.item_id)?.identity.type === 'custom') {
            calls.get(event.item_id).arguments += event.delta; continue;
          }
          if (event.type === 'response.function_call_arguments.done' && calls.get(event.item_id)?.identity.type === 'custom') continue;
          if (event.type === 'response.output_item.done' && event.item) {
            event.item = restoreItem(event.item, reverse);
            if (event.item.type === 'custom_tool_call') {
              await write({ type: 'response.custom_tool_call_input.delta', item_id: event.item.id, output_index: event.output_index, delta: event.item.input });
              await write({ type: 'response.custom_tool_call_input.done', item_id: event.item.id, output_index: event.output_index, input: event.item.input });
            }
          }
          await write(event);
          if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) completed = true;
        }
      }
      if (!completed) throw failure('upstream_truncated', 'Model stream ended before completion.', 502);
      response.end();
    } catch (error) {
      if (response.destroyed) return;
      const detail = { type: 'custom_model_error', code: error.code ?? 'gateway_error', message: error.status ? error.message : controller.signal.aborted ? 'Model request timed out or was cancelled.' : 'Custom model request failed.' };
      if (response.headersSent) response.end(eventBytes({ type: 'response.failed', response: { id: 'resp_' + randomUUID(), object: 'response', status: 'failed', error: detail, output: [] } }));
      else { response.writeHead(error.status ?? 502, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: detail })); }
    } finally { clearTimeout(timer); response.off('close', cancel); request.off('aborted', cancel); this.active.delete(controller); }
  }
  async close() {
    this.closed = true; this.imageTurns.clear();
    for (const controller of this.active) controller.abort();
    if (this.starting) await this.starting.catch(() => {});
    if (this.server?.listening) { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); }
  }
}
