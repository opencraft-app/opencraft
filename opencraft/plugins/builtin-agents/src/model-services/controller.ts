import type { RuntimeProviderView, RuntimeModelProbeResponse, RuntimeDiscoveredModelView } from "@opencraft/appserver-protocol";
import type { LocalAgentSettingsService, RuntimeProviderConfiguration, SaveRuntimeProviderInput } from "../local-agent-settings-service";

export interface ServiceDraft {
  config: RuntimeProviderConfiguration; revision: number; dirty: boolean; key: string;
  modelsTouched: boolean;
  connectionExpanded?: boolean;
  credentialSet: boolean | null; testModel: string; probe: RuntimeModelProbeResponse | null;
}
/** One per environment. The view owns neither a config database nor write retries. */
export class ModelServicesController {
  private serial = 0;
  private listeners = new Set<() => void>();
  private drafts = new Map<string, ServiceDraft>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private creationIds = new Map<string, string>();
  private pendingModelCapabilities = new Set<string>();
  selected: string | null = null;
  initialized = false;
  private disposed = false;
  query = "";
  modelQuery = "";
  busy = false;
  error: string | null = null;
  message: string | null = null;
  constructor(readonly service: LocalAgentSettingsService) {}
  getSnapshot = () => this.serial;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  notify() { this.serial++; for (const listener of this.listeners) listener(); }
  private modelCapabilityKey(provider: string, model: string) { return JSON.stringify([provider, model]); }
  isModelCapabilityPending(provider: string, model: string) { return this.pendingModelCapabilities.has(this.modelCapabilityKey(provider, model)); }
  select(id: string | null) { this.initialized = true; const old = this.selected ? this.drafts.get(this.selected) : undefined; if (old && !old.dirty) old.key = ""; this.selected = id; this.modelQuery = ""; this.error = null; this.message = null; this.notify(); }
  revision(provider: RuntimeProviderView) { return this.service.getSnapshot().settings?.namespaces.find(ns => ns.ns === provider.settingsNs)?.revision ?? -1; }
  draft(provider: RuntimeProviderView): ServiceDraft {
    let draft = this.drafts.get(provider.provider);
    const revision = this.revision(provider);
    if (!draft || (!draft.dirty && draft.revision !== revision)) {
      const config = this.service.providerConfiguration(provider);
      const sameConnection = draft && config.baseURL === draft.config.baseURL && config.api === draft.config.api && config.credentialRef === draft.config.credentialRef;
      draft = { config, revision, dirty: false, modelsTouched: false, connectionExpanded: draft?.connectionExpanded, key: sameConnection ? draft!.key : "", credentialSet: sameConnection ? draft!.credentialSet : null, testModel: draft?.testModel ?? "", probe: null };
      this.drafts.set(provider.provider, draft);
    }
    return draft;
  }
  async inspectCredential(provider: RuntimeProviderView) {
    const draft = this.draft(provider);
    const ref = draft.config.credentialRef, revision = draft.revision;
    let configured: boolean | null;
    try { configured = (await this.service.describeCredential(ref))?.configured ?? false; }
    catch { configured = null; }
    if (!this.disposed && this.drafts.get(provider.provider) === draft && draft.config.credentialRef === ref && draft.revision === revision) { draft.credentialSet = configured; this.notify(); }
  }
  edit(provider: RuntimeProviderView, patch: Partial<RuntimeProviderConfiguration>, key?: string) {
    const draft = this.draft(provider);
    if (patch.baseURL !== undefined && patch.baseURL !== draft.config.baseURL) draft.key = "";
    draft.config = { ...draft.config, ...patch };
    if (patch.models !== undefined) draft.modelsTouched = true;
    if (key !== undefined) draft.key = key;
    draft.dirty = true; draft.probe = null; this.error = null; this.message = null; this.notify();
  }
  scheduleSave(provider: RuntimeProviderView) { if (this.disposed) return; this.cancelSave(provider); this.timers.set(provider.provider, setTimeout(() => { void this.save(provider); }, 500)); }
  private cancelSave(provider: RuntimeProviderView) { const timer = this.timers.get(provider.provider); if (timer) clearTimeout(timer); this.timers.delete(provider.provider); }
  discard(provider: RuntimeProviderView) { this.cancelSave(provider); this.drafts.delete(provider.provider); this.error = null; this.message = null; this.notify(); }
  private input(provider: RuntimeProviderView): SaveRuntimeProviderInput {
    const draft = this.draft(provider);
    return { baseURL: draft.config.baseURL, credential: draft.key ? { kind: "replace", value: draft.key } : { kind: "keep" },
      ...(provider.configuration?.canToggle && !provider.configured ? { enabled: false } : {}),
      ...(provider.configuration?.modelDeclarations ? { displayName: draft.config.displayName, ...(draft.modelsTouched ? { models: draft.config.models } : {}), ...(draft.config.api ? { api: draft.config.api } : {}) } : {}) };
  }
  async run(action: () => Promise<void>) {
    if (this.busy || this.disposed) return;
    const selected = this.selected;
    this.busy = true; this.error = null; this.message = null; this.notify();
    try { await action(); } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; if (selected !== this.selected) { this.error = null; this.message = null; } if (!this.disposed) this.notify(); }
  }
  private async commit(provider: RuntimeProviderView, disableNewModels = false) {
    this.cancelSave(provider);
    const draft = this.draft(provider);
    if (!draft.dirty) return;
    await this.service.saveProvider(provider, { ...this.input(provider), ...(disableNewModels ? { disableNewModels: true } : {}) }, draft.revision);
    draft.revision = this.revision(provider); draft.config = this.service.providerConfiguration(provider); draft.dirty = false; draft.modelsTouched = false;
    if (draft.key) draft.credentialSet = true;
    if (this.selected !== provider.provider) draft.key = "";
    this.message = "配置已保存";
  }
  save(provider: RuntimeProviderView) { if (this.busy) { this.scheduleSave(provider); return Promise.resolve(); } return this.run(() => this.commit(provider)); }
  toggle(provider: RuntimeProviderView, enabled: boolean) { return this.run(async () => {
    await this.commit(provider);
    const fresh = this.service.getSnapshot().providers?.providers.find(p => p.provider === provider.provider);
    if (!fresh) throw new Error("提供商已不可用");
    await this.service.setEnabled(fresh, enabled, this.revision(fresh));
  }); }
  test(provider: RuntimeProviderView, model: string) { return this.run(async () => {
    const draft = this.draft(provider); draft.probe = null;
    if(draft.dirty)throw new Error("请先保存配置，再检查连接");
    const revision=draft.revision;
    const result = await this.service.checkSavedModel(provider.provider, model, revision);
    if (this.drafts.get(provider.provider) === draft && !draft.dirty && draft.revision===revision) draft.probe = result;
  }); }
  fetchModels(provider: RuntimeProviderView) { return this.run(async () => {
    const draft = this.draft(provider);
    const source = draft.config.baseURL && draft.config.api ? "endpoint" : "catalog";
    const models = await this.service.discoverModels(provider, this.input(provider), source);
    const merged = new Map(draft.config.models.map(model => [model.id, model]));
    for (const model of models) if (!merged.has(model.id)) merged.set(model.id, model);
    this.edit(provider, { models: [...merged.values()] });
    await this.commit(provider, true);
    this.message = `已获取 ${models.length} 个模型；未执行推理检查`;
  }); }
  addModel(provider: RuntimeProviderView, model: RuntimeDiscoveredModelView) { return this.run(async () => {
    const draft = this.draft(provider);
    if (draft.config.models.some(m => m.id === model.id)) throw new Error("此模型已存在");
    this.edit(provider, { models: [...draft.config.models, model] });
    await this.commit(provider);
  }); }
  async setModelImageInput(provider: RuntimeProviderView, modelId: string, enabled: boolean) {
    const pendingKey = this.modelCapabilityKey(provider.provider, modelId);
    if (this.disposed || this.pendingModelCapabilities.has(pendingKey)) return;
    this.pendingModelCapabilities.add(pendingKey); this.error = null; this.message = null; this.notify();
    try {
      if (provider.configuration?.modelDeclarations !== true) throw new Error("此模型的能力由运行时管理");
      const draft = this.draft(provider);
      if (draft.dirty) throw new Error("请先保存或取消连接配置的修改");
      const model = draft.config.models.find(entry => entry.id === modelId);
      if (!model) throw new Error("模型声明已变化，请刷新后重试");
      const input = enabled ? ["text", "image"] as const : ["text"] as const;
      const models = draft.config.models.map(entry => entry.id === modelId ? { ...entry, input } : entry);
      await this.service.saveProvider(provider, {
        baseURL: draft.config.baseURL,
        credential: { kind: "keep" },
        displayName: draft.config.displayName,
        ...(draft.config.api ? { api: draft.config.api } : {}),
        models,
      }, draft.revision);
      this.drafts.delete(provider.provider);
      this.message = enabled ? "已允许图片输入" : "已设为仅文本输入";
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.pendingModelCapabilities.delete(pendingKey);
      if (!this.disposed) this.notify();
    }
  }
  create(name: string) { return this.run(async () => {
    const previous = this.creationIds.get(name);
    const id = previous ?? `custom-${crypto.randomUUID()}`;
    this.creationIds.set(name, id);
    if (previous) {
      await this.service.refresh();
      if (this.service.getSnapshot().providers?.providers.some(provider => provider.provider === id)) { this.select(id); this.creationIds.delete(name); return; }
    }
    await this.service.createProvider(id, { displayName: name, baseURL: "", api: "openai-completions", models: [], credential: { kind: "keep" }, enabled: false });
    this.select(id); this.creationIds.delete(name);
  }); }
  changeModel(provider: RuntimeProviderView, model: string, enabled: boolean) { return this.run(async () => {
    await this.commit(provider);
    await this.service.changeModel(provider.provider, model, enabled);
  }); }
  renameProvider(provider: RuntimeProviderView, name: string, revision: number) { return this.run(async () => {
    if (!provider.declared || provider.settingsNs !== "llm-pi-ai") throw new Error("仅支持重命名自定义提供商");
    if (!name.trim()) throw new Error("请输入提供商名称");
    const draft = this.draft(provider);
    if (draft.dirty) throw new Error("请先保存或取消连接配置的修改");
    await this.service.saveProvider(provider, { displayName: name.trim(), baseURL: draft.config.baseURL, credential: { kind: "keep" } }, revision);
    this.message = "提供商已重命名";
  }); }
  deleteProvider(provider: RuntimeProviderView, revision: number) { return this.run(async () => {
    if (!provider.declared || provider.settingsNs !== "llm-pi-ai") throw new Error("仅支持删除自定义提供商");
    if (this.draft(provider).dirty) throw new Error("请先保存或取消连接配置的修改");
    await this.service.deleteProvider(provider, revision);
    this.cancelSave(provider); this.drafts.delete(provider.provider);
    if (this.selected === provider.provider) this.select(this.service.getSnapshot().providers?.providers.find(entry => entry.enabled)?.provider ?? null);
    this.message = "提供商已删除，凭据保留";
  }); }
  setDefault(provider: RuntimeProviderView, model: string) { return this.run(async () => {
    await this.commit(provider);
    const snapshot = this.service.getSnapshot();
    if (!snapshot.providers?.providers.some(entry => entry.provider === provider.provider && entry.active)) throw new Error("请先启用提供商");
    const revision = snapshot.settings?.namespaces.find(entry => entry.ns === "agent-default-model")?.revision;
    if (revision === undefined) throw new Error("默认模型配置不可用");
    await this.service.saveDefaultModel(provider.provider, model, undefined, revision);
    this.message = "默认模型已更新，已有会话保持原选择";
  }); }
  dispose() { this.disposed = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); this.creationIds.clear(); this.pendingModelCapabilities.clear(); this.drafts.clear(); this.listeners.clear(); }
}
