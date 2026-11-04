import { randomUUID } from 'node:crypto';
import { CUSTOM_MODEL_PREFIX, CUSTOM_PROVIDER, customModelId, decodeCustomModel } from './codex-custom-responses.mjs';

const intercepted = new Set(['model/list', 'thread/start', 'thread/resume', 'thread/fork', 'turn/start']);
const own = model => typeof model === 'string' && model.startsWith(CUSTOM_MODEL_PREFIX);

export function customModelOption({ provider, model }) {
  const id = customModelId(provider.id, model.id);
  const efforts = model.reasoningEfforts && Object.keys(model.reasoningEfforts).filter(key => key !== 'off') || [];
  return { id, model: id, displayName: `${model.name ?? model.id} · ${provider.name}`, description: 'Custom Responses model',
    groupKey: provider.id, groupLabel: provider.name, hidden: false, isDefault: false,
    supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })),
    defaultReasoningEffort: efforts[0] ?? 'none', inputModalities: model.input ?? ['text'],
    supportsPersonality: false, multiAgentVersion: null, additionalSpeedTiers: [], serviceTiers: [],
    defaultServiceTier: null, availableAccessPrograms: null, upgrade: null, upgradeInfo: null, availabilityNux: null, modelSpecialty: null };
}

/** Decorates the admitted native connection; model execution and approvals stay in Codex. */
export class CustomModelNativeTransport {
  constructor(inner, gateway, { closeGateway = true } = {}) {
    this.inner = inner; this.gateway = gateway; this.listeners = new Set(); this.pending = new Map(); this.operations = new Map(); this.fresh = new Map(); this.foreign = new Set(); this.closed = false;
    this.closeGateway = closeGateway;
    this.prefix = 'custom-model-rpc:' + randomUUID() + ':'; this.sequence = 0;
    this.unsubscribe = inner.subscribeMessage(frame => {
      let message; try { message = JSON.parse(frame); } catch { this.emit(frame); return; }
      if (typeof message.id === 'string' && message.id.startsWith(this.prefix) && !message.method) {
        const entry = this.pending.get(message.id);
        if (entry) {
          clearTimeout(entry.timer); this.pending.delete(message.id);
          if (message.error) entry.reject(Object.assign(new Error('Native custom model operation failed.'), {
            resultUnknown: ['thread/start', 'thread/fork', 'turn/start'].includes(entry.method) || message.error.data?.resultUnknown === true,
          }));
          else entry.resolve(message.result);
        }
        return;
      }
      this.emit(frame);
    });
    this.unsubscribeStatus = inner.subscribeStatus(status => { if (['closed', 'failed'].includes(status.state)) this.rejectPending(); });
  }
  get status() { return this.inner.status; }
  connect(signal) { return this.inner.connect(signal); }
  subscribeStatus(listener) { return this.inner.subscribeStatus(listener); }
  subscribeRecoveryHint(listener) { return this.inner.subscribeRecoveryHint?.(listener) ?? (() => {}); }
  subscribeMessage(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(frame) { for (const listener of this.listeners) listener(typeof frame === 'string' ? frame : JSON.stringify(frame)); }
  rejectPending() {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(Object.assign(new Error('Native custom model connection closed; outcome may be unknown.'), {
      resultUnknown: ['thread/start', 'thread/fork', 'turn/start'].includes(entry.method),
    })); }
    this.pending.clear();
  }
  rpc(method, params, signal) {
    if (this.closed || signal?.aborted || this.pending.size >= 128) return Promise.reject(new Error('Custom model request cancelled or unavailable.'));
    const id = this.prefix + ++this.sequence;
    return new Promise((resolve, reject) => {
      const unknown = ['thread/start', 'thread/fork', 'turn/start'].includes(method);
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error('Native custom model request timed out; outcome may be unknown.'), { resultUnknown: unknown })); }, 30_000);
      timer.unref(); this.pending.set(id, { resolve, reject, timer, method });
      Promise.resolve().then(() => this.inner.send(JSON.stringify({ id, method, params }), signal)).catch(() => {
        const entry = this.pending.get(id); if (!entry) return;
        clearTimeout(timer); this.pending.delete(id); reject(Object.assign(new Error('Native custom model request failed; outcome may be unknown.'), { resultUnknown: unknown }));
      });
    });
  }
  async selection(model) {
    const item = (await this.gateway.catalog()).find(item => customModelId(item.provider.id, item.model.id) === model);
    if (!item) throw new Error('所选自定义模型已停用或不可用，请在模型服务中检查配置。');
    return item;
  }
  async definition(params, item) {
    const images = params.config?.['features.image_generation'] !== false && item.model.input?.includes('image') === true && await this.gateway.imageAvailable?.() === true;
    const config = { ...params.config, ['model_providers.' + CUSTOM_PROVIDER]: await this.gateway.definition({ images }),
      web_search: 'disabled', 'features.image_generation': images };
    if (item.model.contextWindow) {
      config.model_context_window = item.model.contextWindow;
      config.model_auto_compact_token_limit = Math.max(1, Math.floor(item.model.contextWindow * 0.75));
    }
    const efforts = item.model.reasoningEfforts && Object.keys(item.model.reasoningEfforts).filter(level => level !== 'off');
    if (efforts?.length) {
      // Native fallback metadata otherwise omits the entire reasoning request,
      // even when turn/start explicitly selects an effort.
      config.model_supports_reasoning_summaries = true;
      config.model_reasoning_effort ??= efforts[0];
      config.model_reasoning_summary ??= 'none';
    } else config.model_reasoning_effort = 'none';
    return { ...params, model: customModelId(item.provider.id, item.model.id), modelProvider: CUSTOM_PROVIDER,
      allowProviderModelFallback: false, config };
  }
  async route(message, signal) {
    const { method } = message; const params = message.params ?? {};
    if (method === 'model/list') {
      const result = await this.rpc(method, params, signal);
      if (result.nextCursor) return result;
      let catalog; try { catalog = await this.gateway.catalog(); } catch { catalog = []; }
      return { ...result, data: [...result.data, ...catalog.map(customModelOption)] };
    }
    if (method === 'thread/start') {
      if (!own(params.model)) {
        const result = await this.rpc(method, params, signal);
        if (result.thread?.id) {
          if (this.foreign.size >= 2048) this.foreign.delete(this.foreign.values().next().value);
          this.foreign.add(result.thread.id);
        }
        return result;
      }
      const result = await this.rpc(method, await this.definition(params, await this.selection(params.model)), signal);
      if (result.modelProvider !== CUSTOM_PROVIDER || result.model !== params.model)
        throw Object.assign(new Error('自定义模型未正确加载；创建结果需核对，未自动重试。'), { resultUnknown: true });
      if (this.fresh.size >= 2048) this.fresh.delete(this.fresh.keys().next().value);
      this.fresh.set(result.thread.id, params.model);
      return result;
    }
    const fresh = this.fresh.get(params.threadId);
    if (fresh && method === 'turn/start') {
      if (params.model && params.model !== fresh) throw new Error('首条消息请使用创建时选择的模型，或用目标模型新建会话。');
      const item = await this.selection(fresh);
      const result = await this.rpc(method, { ...params, model: fresh, ...(!item.model.reasoningEfforts ? { effort: 'none' } : {}), serviceTier: null }, signal);
      this.fresh.delete(params.threadId); return result;
    }
    // A newly created native/Knot thread may have no rollout yet. Its original
    // decorator owns that lifecycle; do not insert an extra disk-history read.
    if (this.foreign.has(params.threadId) && !own(params.model)) {
      const result = await this.rpc(method, params, signal);
      if (method === 'thread/fork' && result.thread?.id && this.foreign.size < 2048) this.foreign.add(result.thread.id);
      return result;
    }
    const { thread } = await this.rpc('thread/read', { threadId: params.threadId, includeTurns: false }, signal);
    const sourceIsCustom = thread.modelProvider === CUSTOM_PROVIDER;
    const selected = params.model ?? thread.model;
    if (!sourceIsCustom && !own(selected)) return this.rpc(method, params, signal);
    if (!sourceIsCustom || !own(selected)) throw new Error('本批自定义模型接入请使用新会话；暂不跨供应商迁移旧会话。');
    if (decodeCustomModel(thread.model)?.provider !== decodeCustomModel(selected)?.provider)
      throw new Error('不同模型服务连接请使用新会话；暂不跨供应商迁移旧会话。');
    const item = await this.selection(selected);
    if (method === 'thread/resume' || method === 'thread/fork') {
      const result = await this.rpc(method, await this.definition({ ...params, model: selected }, item), signal);
      if (result.modelProvider !== CUSTOM_PROVIDER || result.model !== selected) throw Object.assign(new Error('自定义模型未正确恢复，本次操作结果需核对。'), { resultUnknown: method === 'thread/fork' });
      return result;
    }
    if (method === 'turn/start') {
      if (thread.status?.type === 'notLoaded') {
        const resumed = await this.rpc('thread/resume', await this.definition({ threadId: params.threadId }, item), signal);
        if (resumed.modelProvider !== CUSTOM_PROVIDER || resumed.model !== selected) throw new Error('自定义模型未正确恢复，本次消息未发送。');
      }
      if (signal?.aborted) throw new Error('Custom model request cancelled.');
      return this.rpc(method, { ...params, model: selected, ...(!item.model.reasoningEfforts ? { effort: 'none' } : {}), serviceTier: null }, signal);
    }
    return this.rpc(method, params, signal);
  }
  async send(frame, signal) {
    const message = JSON.parse(frame);
    if (!intercepted.has(message.method) || message.id === undefined) return this.inner.send(frame, signal);
    const operation = async () => {
      try {
        if (this.closed || signal?.aborted) throw new Error('Custom model request cancelled.');
        this.emit({ id: message.id, result: await this.route(message, signal) });
      } catch (error) { this.emit({ id: message.id, error: { code: -32000, message: error.message, data: {
        ...(error.resultUnknown === true ? { resultUnknown: true, submissionOutcome: 'unknown' } : { submissionOutcome: 'rejected' }), retryable: false,
      } } }); }
    };
    const thread = message.params?.threadId;
    if (!thread) return operation();
    const next = (this.operations.get(thread) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.operations.set(thread, next);
    try { await next; } finally { if (this.operations.get(thread) === next) this.operations.delete(thread); }
  }
  async close() {
    this.closed = true; this.rejectPending(); this.unsubscribe(); this.unsubscribeStatus(); this.listeners.clear(); this.fresh.clear(); this.foreign.clear();
    if (this.closeGateway) await this.gateway.close();
    await this.inner.close();
  }
}
