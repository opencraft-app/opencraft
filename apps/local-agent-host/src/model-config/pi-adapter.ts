import {join} from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createProvider, InMemoryCredentialStore, type Api, type Model, type Provider} from '@earendil-works/pi-ai';
import {getApiProvider} from '@earendil-works/pi-ai/compat';
import {piModel} from '@opencraft/plugin-pi-engine';
import type {ConfiguredProvider, ModelDocument} from './model-document.js';
import {ModelConfigurationApplyError, ModelConfigurationService, type ModelCredentialResolver, type ModelEnginePort} from './service.js';
import {ModelConfigurationRepository, ModelCredentialRepository} from './repository.js';
import {locked, readJson, writeJson} from './json-file.js';

const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type Bindings = Record<string, string>;

/** Execution projection only: the product document and credential repository remain authoritative. */
export class PiModelEngineAdapter implements ModelEnginePort {
  private bindings: Bindings = {};
  private projected = new Set<string>();
  private readonly catalog: readonly Model<Api>[];
  private readonly endpoints: Map<string, string | undefined>;
  private defaults: {model: string | null; effort?: string} = {model: null};
  private constructor(readonly runtime: ModelRuntime, private readonly directory: string) {
    this.catalog = [...runtime.getModels()];
    this.endpoints = new Map(runtime.getProviders().map(provider => [provider.id, provider.baseUrl]));
  }
  static async create(directory: string) {
    // No native auth/config files, ambient credentials or network catalog are product configuration.
    const runtime = await ModelRuntime.create({modelsPath: null, credentials: new InMemoryCredentialStore(),
      allowModelNetwork: false, refreshOnCreate: false});
    const adapter = new PiModelEngineAdapter(runtime, directory);
    for (const provider of runtime.getProviders()) adapter.hide(provider);
    await runtime.refresh({allowNetwork: false});
    return adapter;
  }
  private hide(provider: Provider) {
    this.runtime.registerNativeProvider({...provider, getModels: () => [], getAllModels: () => [], refreshModels: undefined,
      auth: {apiKey: {name: 'OpenCraft configuration', check: async () => undefined, resolve: async () => undefined}}});
  }
  private async providerBindings(providers: ConfiguredProvider[]) {
    const path = join(this.directory, 'model-provider-bindings.json');
    return locked(path, async () => {
      const saved = await readJson(path) as {version?: number; providers?: Bindings} | null;
      if (saved && (saved.version !== 1 || !saved.providers || typeof saved.providers !== 'object' || Array.isArray(saved.providers)
        || new Set(Object.values(saved.providers)).size !== Object.values(saved.providers).length
        || Object.entries(saved.providers).some(([id, alias]) => !id || typeof alias !== 'string' || !alias)))
        throw new ModelConfigurationApplyError('Pi模型身份映射损坏，请修复后重试。');
      const bindings: Bindings = Object.assign(Object.create(null), saved?.providers);
      // Read legacy metadata only for the first identity migration. Never resolve its apiKey commands.
      const legacy = saved ? null : await readJson(join(this.directory, 'models.json')) as {providers?: Record<string, any>} | null;
      const previous = Object.entries(legacy?.providers ?? {});
      for (const provider of providers) {
        if (bindings[provider.id]) continue;
        const exact = previous.find(([id]) => id === provider.id);
        const matches = previous.filter(([, old]) => old.name === provider.name && old.api === provider.protocol
          && old.baseUrl === provider.baseUrl);
        const uniqueSource = providers.filter(p => p.name === provider.name && p.protocol === provider.protocol && p.baseUrl === provider.baseUrl).length === 1;
        const alias = exact?.[0] ?? (uniqueSource && matches.length === 1 ? matches[0]![0] : provider.id);
        if (Object.values(bindings).includes(alias) || alias !== provider.id && providers.some(p => p.id === alias))
          throw new ModelConfigurationApplyError('Pi模型提供商身份冲突，请检查配置。');
        bindings[provider.id] = alias;
      }
      if (!saved || JSON.stringify(saved.providers) !== JSON.stringify(bindings)) await writeJson(path, {version: 1, providers: bindings});
      return bindings;
    });
  }
  async apply(document: ModelDocument, credentials: ModelCredentialResolver) {
    const bindings = await this.providerBindings(document.providers);
    const providers: Provider[] = [];
    for (const provider of document.providers) {
      const selected = provider.models.filter(model => model.enabled && (model.type ?? 'chat') === 'chat');
      if (!provider.enabled || !selected.length) continue;
      const api = getApiProvider(provider.protocol as Api);
      if (!api) throw new ModelConfigurationApplyError('Pi不支持所配置的模型协议，请检查提供商配置。');
      const key = provider.credentialRef ? await credentials.resolve(provider.credentialRef) : undefined;
      // An unresolved reference never falls back to native files or process-global provider credentials.
      if (!key) continue;
      const id = bindings[provider.id]!;
      const baseUrl = provider.baseUrl || this.endpoints.get(provider.catalogId ?? provider.id);
      if (!baseUrl) throw new ModelConfigurationApplyError('Pi模型提供商缺少服务地址，请检查配置。');
      const models: Model<Api>[] = selected.map(model => {
        const known = this.catalog.find(entry => entry.provider === (provider.catalogId ?? provider.id)
          && entry.id === model.id && entry.api === provider.protocol);
        const efforts = model.reasoningEfforts;
        const reasoning = efforts === undefined ? known?.reasoning ?? false : efforts !== false;
        // Product off:null explicitly supports disabling without sending a provider field.
        // In Pi null means unsupported, so that one explicit omission becomes an absent key.
        const thinkingLevelMap = efforts && typeof efforts === 'object'
          ? Object.fromEntries(levels.filter(level => !(level === 'off' && Object.hasOwn(efforts, 'off') && efforts.off === null))
            .map(level => [level, efforts[level] ?? null])) : efforts === false ? undefined : known?.thinkingLevelMap;
        return {...known, id: model.id, name: model.name ?? known?.name ?? model.id, provider: id,
          api: provider.protocol as Api, baseUrl,
          input: model.input ?? known?.input ?? ['text'], reasoning, ...(thinkingLevelMap ? {thinkingLevelMap} : {}),
          // Same generic fallback limits as Pi's models.json custom-model loader.
          contextWindow: model.contextWindow ?? known?.contextWindow ?? 128000,
          maxTokens: model.maxTokens ?? known?.maxTokens ?? 16384,
          cost: known?.cost ?? {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
      });
      providers.push(createProvider({id, name: provider.name, baseUrl, models, api,
        auth: {apiKey: {name: 'OpenCraft configuration',
          check: async () => ({type: 'api_key', source: 'OpenCraft configuration'}),
          resolve: async () => ({auth: {apiKey: key}, source: 'OpenCraft configuration'})}}}));
    }
    // Resolve and validate the entire next projection before replacing native providers.
    const next = new Set(providers.map(provider => provider.id));
    for (const id of this.projected) if (!next.has(id)) {
      const provider = this.runtime.getProvider(id); if (provider) this.hide(provider);
    }
    for (const provider of providers) this.runtime.registerNativeProvider(provider);
    const result = await this.runtime.refresh({allowNetwork: false});
    if (result.aborted || result.errors.size || this.runtime.getError()) throw new ModelConfigurationApplyError('Pi模型配置未能应用，请检查后重试。');
    this.projected = next; this.bindings = bindings;
    const model = document.defaultModel;
    this.defaults = model ? {model: piModel(bindings[model.providerId]!, model.modelId),
      ...(model.reasoningEffort ? {effort: model.reasoningEffort === 'off' ? 'none' : model.reasoningEffort} : {})} : {model: null};
  }
  readDefaults() {return {...this.defaults};}
  sourceProvider(alias: string) {return Object.keys(this.bindings).find(id => this.bindings[id] === alias);}
}

/** The same revision/stamp owner used by the DSH adapter; Pi only supplies its execution port. */
export async function createPiModelConfiguration(modelDirectory: string, piDirectory: string) {
  const adapter = await PiModelEngineAdapter.create(piDirectory);
  const repository = new ModelConfigurationRepository(modelDirectory);
  const service = new ModelConfigurationService(repository, new ModelCredentialRepository(modelDirectory), adapter);
  return {models: adapter.runtime,
    configuration: {
      async synchronize() {
        const state = await service.synchronize(service.application.state === 'failed');
        if (state.state !== 'applied') throw new ModelConfigurationApplyError(state.error ?? 'Pi模型配置尚未应用。');
      },
      defaults: () => adapter.readDefaults(),
      async writeDefaults(value: {model: string | null; effort?: string}) {
        const doc = await repository.read();
        await service.update(doc.revision, draft => {
          if (value.model === null) {draft.defaultModel = null; return;}
          const match = /^pi:([^:]+):(.+)$/u.exec(value.model);
          const providerId = match && adapter.sourceProvider(decodeURIComponent(match[1]!));
          if (!providerId) throw new Error('Pi model is unavailable');
          draft.defaultModel = {providerId, modelId: decodeURIComponent(match![2]!),
            ...(value.effort ? {reasoningEffort: value.effort === 'none' ? 'off' : value.effort} : {})};
        });
        if (service.application.state !== 'applied') throw new ModelConfigurationApplyError(service.application.error);
      },
    },
  };
}
