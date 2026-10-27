import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  RuntimeProviderApplyParams, RuntimeProviderApplyResponse, RuntimeProvidersListResponse,
  RuntimeSettingsDescribeResponse, RuntimeSettingsNamespaceView, RuntimeSettingsPathOperation,
  RuntimeModelsDiscoverParams, RuntimeModelsDiscoverResponse,
  RuntimeProviderSetEnabledParams,
  RuntimeModelsListResponse, RuntimeModelMutationParams,
  RuntimeModelProbeParams, RuntimeDiscoveredModelView, RuntimeModelView,
} from "@opencraft/appserver-protocol";
import { probeRuntimeModel } from "./runtime-model-probe.js";
import { modelBaseUrlError } from "@opencraft/appserver-protocol";
import { DshClientError, type DshClient } from "./dsh-client.js";
import { modelInputModalities } from "@opencraft/composer-core";
import { HUNYUAN_SPEECH, isHunyuanSpeechEndpoint } from "./model-config/speech.js";

const CUSTOM_NS = "llm-pi-ai";
const supportsProviderLifecycle = (ns: string) => ns === CUSTOM_NS || ns === "llm-deepseek";
const APIS = ["openai-completions", "openai-responses"] as const;
export type RuntimeModelInfoReader = (provider: string, model: string) => Promise<{
  input?: readonly ("text" | "image")[] | null;
  reasoning?: import("@opencraft/appserver-protocol").RuntimeModelView["reasoning"] | null;
}>;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const at = (value: unknown, path: readonly string[]): unknown => path.reduce((node, key) => object(node)[key], value);

function endpoint(value: string, validateOperation = true): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Endpoint must be an HTTP(S) base URL without credentials, query or fragment");
  }
  const issue = validateOperation ? modelBaseUrlError(value) : null; if (issue) throw new Error(issue);
  return url.toString().replace(/\/+$/, "");
}

const OLLAMA_REASONING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const REASONING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function declaredReasoning(value: unknown): RuntimeModelView["reasoning"] | undefined {
  if (value === undefined || value === false) return undefined;
  const efforts = object(value);
  const declared = REASONING_ORDER.filter(level => Object.hasOwn(efforts, level));
  return declared.length ? { efforts: declared.map(level => ({ id: level, name: level })) } : undefined;
}

/** Ollama's OpenAI-compatible /models lists IDs; its native show API owns capabilities. */
async function ollamaModelMetadata(baseURL: string, models: readonly { id: string }[]): Promise<Map<string, Pick<RuntimeDiscoveredModelView, "input" | "reasoningEfforts">>> {
  const base = new URL(baseURL);
  if (!base.pathname.endsWith("/v1")) return new Map();
  base.pathname = `${base.pathname.slice(0, -3)}/api/show`;
  const showURL = base.toString();
  const metadataByModel = new Map<string, Pick<RuntimeDiscoveredModelView, "input" | "reasoningEfforts">>();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, models.length) }, async () => {
    while (cursor < models.length) {
      const model = models[cursor++]!;
      try {
        const response = await fetch(showURL, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(4_000),
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ model: model.id }),
        });
        if (!response.ok) { await response.body?.cancel(); continue; }
        const reader = response.body?.getReader();
        if (!reader) continue;
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength;
            if (size > 64 * 1024) throw new Error("Ollama model metadata is too large");
            chunks.push(part.value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const metadata = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const input = Array.isArray(metadata.capabilities) && metadata.capabilities.includes("vision")
          ? ["text", "image"] as const : undefined;
        const thinking = object(metadata.thinking);
        const levels = Array.isArray(thinking.values)
          ? [...new Set(thinking.values.filter((value): value is string =>
            typeof value === "string" && OLLAMA_REASONING_LEVELS.has(value)))] : [];
        const reasoningEfforts = levels.length
          ? Object.fromEntries(levels.map(level => [level, level])) as Exclude<RuntimeDiscoveredModelView["reasoningEfforts"], false | undefined>
          : undefined;
        if (input || reasoningEfforts) metadataByModel.set(model.id, { ...(input ? { input } : {}), ...(reasoningEfforts ? { reasoningEfforts } : {}) });
      } catch { /* Metadata is optional; the user can set image input explicitly. */ }
    }
  }));
  return metadataByModel;
}

/** Runtime protocol coordinator; product persistence is owned by the injected configuration bridge. */
export class RuntimeProviderService {
  private modelInfoReader?: RuntimeModelInfoReader;
  setModelInfoReader(reader: RuntimeModelInfoReader) { this.modelInfoReader = reader; }
  constructor(private readonly client: Pick<DshClient, "call">, private readonly applicationModels = false) {}

  probe(input: RuntimeModelProbeParams) { return probeRuntimeModel(input); }

  async remove(input: Omit<RuntimeProviderSetEnabledParams, "enabled">): Promise<RuntimeProviderApplyResponse> {
    if (!input || typeof input.provider !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.provider)
      || ["__proto__", "constructor", "prototype"].includes(input.provider) || !Number.isInteger(input.expectedRevision)) throw new Error("Invalid provider command");
    const [directory, settings] = await Promise.all([
      this.client.call<RuntimeProvidersListResponse>("llm.providers"),
      this.client.call<RuntimeSettingsDescribeResponse>("settings.describe"),
    ]);
    const provider = directory.providers.find(entry => entry.provider === input.provider);
    if (!provider?.declared || provider.settingsNs !== CUSTOM_NS
      || !isDeepStrictEqual(provider.settingsPath, ["providers", input.provider])) throw new Error("Only custom providers can be deleted");
    const namespace = settings.namespaces.find(entry => entry.ns === CUSTOM_NS);
    if (!settings.writable || !namespace) throw new Error("Runtime settings are read-only");
    if (namespace.revision !== input.expectedRevision) throw new DshClientError("settings-conflict", "Provider settings changed; refresh before deleting");
    const defaults = object(settings.namespaces.find(entry => entry.ns === "agent-default-model")?.value);
    if (defaults.provider === input.provider) throw new Error("请先选择其他提供商的默认模型");
    const ops: RuntimeSettingsPathOperation[] = [{ op: "unset", path: ["providers", input.provider] }];
    if (Object.hasOwn(object(object(namespace.value).modelSelection), input.provider)) ops.push({ op: "unset", path: ["modelSelection", input.provider] });
    const saved = await this.client.call<RuntimeSettingsNamespaceView>("settings.mutate", { ns: CUSTOM_NS, expectedRevision: input.expectedRevision, ops });
    // Credentials may be shared by other connections; never remove them here.
    return { provider: input.provider, revision: saved.revision, saved: true };
  }

  async models(includeDisabled = false): Promise<RuntimeModelsListResponse> {
    const [catalog, settings, directory] = await Promise.all([
      this.client.call<RuntimeModelsListResponse>("llm.models"),
      this.client.call<RuntimeSettingsDescribeResponse>("settings.describe"),
      this.client.call<RuntimeProvidersListResponse>("llm.providers"),
    ]);
    const config = object(settings.namespaces.find(entry => entry.ns === CUSTOM_NS)?.value);
    const policy = object(config.modelSelection);
    // Defensive projection even if an engine briefly returns a stale cached catalog.
    const chatGroups = catalog.groups.filter(group => object(object(config.providers)[group.id]).api !== HUNYUAN_SPEECH.api)
      .map(group => ({ ...group, models: group.models.filter(model => model.type !== "asr") }));
    const liveModels = new Set(chatGroups.flatMap(group => group.models.map(model => JSON.stringify([group.id, model.id]))));
    let groups = [...chatGroups];
    if (includeDisabled) {
      for (const provider of directory.providers) {
        if (!supportsProviderLifecycle(provider.settingsNs) || groups.some(group => group.id === provider.provider)) continue;
        const section = settings.namespaces.find(entry => entry.ns === provider.settingsNs);
        const declared = provider.settingsNs === CUSTOM_NS ? object(object(config.providers)[provider.provider]).models
          : object(at(section?.value, provider.settingsPath)).models;
        if (Array.isArray(declared)) groups = [...groups, { id: provider.provider, name: provider.displayName,
          models: declared.map(entry => { const model = object(entry); const reasoning = declaredReasoning(model.reasoningEfforts); return { id: String(model.id), name: String(model.name ?? model.id),
            ...(model.type === "asr" ? { type: "asr" as const } : {}),
            ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
            ...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
            ...(Array.isArray(model.input ?? model.inputModalities) ? { input: (model.input ?? model.inputModalities) as ("text" | "image")[] } : {}),
            ...(reasoning ? { reasoning } : {}),
          }; }),
        }];
      }
    }
    return { ...catalog, groups: await Promise.all(groups.map(async group => {
      const provider = directory.providers.find(entry => entry.provider === group.id && entry.active) ?? directory.providers.find(entry => entry.provider === group.id);
      const declared = object(object(config.providers)[group.id]).models;
      const builtin = object(object(config.providers)[group.id]).api !== HUNYUAN_SPEECH.api && provider?.settingsNs === CUSTOM_NS && Array.isArray(declared) && declared.length
        ? provider.declared || provider.provider === "ollama-cloud" ? new Set<string>() : new Set((await this.client.call<RuntimeModelsDiscoverResponse>("llm.discoverModels", { settingsNs: CUSTOM_NS, provider: group.id })).models.map(model => model.id))
        : null;
      const disabled = new Set(Array.isArray(policy[group.id]) ? policy[group.id] as string[] : []);
      return { ...group, models: (await Promise.all(group.models.map(async model => {
        const info = this.modelInfoReader && liveModels.has(JSON.stringify([group.id, model.id]))
          ? await this.modelInfoReader(group.id, model.id) : null;
        const input = info?.input
          ?? model.input
          ?? (model as { inputModalities?: readonly string[] }).inputModalities;
        return { ...model,
        ...(info ? { reasoning: info.reasoning ?? undefined } : {}),
        input: model.type === "asr" ? undefined : modelInputModalities(input)
          .filter((modality): modality is "text" | "image" => modality !== "audio"),
        enabled: !disabled.has(model.id),
        source: model.type === "asr" || (builtin && !builtin.has(model.id)) ? "custom" as const : "builtin" as const,
      }; }))).filter(model => includeDisabled || model.enabled) };
    })) };
  }

  async mutateModel(input: RuntimeModelMutationParams, enabled?: boolean): Promise<RuntimeProviderApplyResponse> {
    if (!input || typeof input.provider !== "string" || typeof input.model !== "string" || !input.model.trim()
      || !Number.isInteger(input.expectedRevision) || ["__proto__", "constructor", "prototype"].includes(input.provider)) throw new Error("Invalid model command");
    const settings = await this.client.call<RuntimeSettingsDescribeResponse>("settings.describe");
    const namespace = settings.namespaces.find(entry => entry.ns === CUSTOM_NS);
    if (!settings.writable || !namespace) throw new Error("Model settings are unavailable");
    if (namespace.revision !== input.expectedRevision) throw new DshClientError("settings-conflict", "Models changed; refresh before retrying");
    const catalog = await this.models(true);
    const model = catalog.groups.find(group => group.id === input.provider)?.models.find(model => model.id === input.model);
    if (!model) throw new Error("Model no longer exists or provider is unavailable");
    const defaults = object(settings.namespaces.find(entry => entry.ns === "agent-default-model")?.value);
    if (enabled !== true && defaults.provider === input.provider && defaults.model === input.model) throw new Error("Select another default model first");
    const config = object(namespace.value);
    const previous = object(config.modelSelection)[input.provider];
    const disabled = new Set(Array.isArray(previous) ? previous as string[] : []);
    const ops: RuntimeSettingsPathOperation[] = [];
    if (enabled === undefined) {
      if (model.source !== "custom") throw new Error("Built-in models can be disabled, not deleted");
      const provider = object(object(config.providers)[input.provider]);
      if (!Array.isArray(provider.models)) throw new Error("Model has no custom configuration");
      const remaining = provider.models.filter(entry => object(entry).id !== input.model);
      if (remaining.length === 0 && provider.enabled !== false) throw new Error("Disable this provider before deleting its last model");
      ops.push({ op: "set", path: ["providers", input.provider, "models"], value: remaining });
      disabled.delete(input.model);
    } else if (enabled) disabled.delete(input.model);
    else disabled.add(input.model);
    ops.push({ op: "set", path: ["modelSelection", input.provider], value: [...disabled] });
    const saved = await this.client.call<RuntimeSettingsNamespaceView>("settings.mutate", { ns: CUSTOM_NS, expectedRevision: input.expectedRevision, ops });
    return { provider: input.provider, revision: saved.revision, saved: true };
  }

  async list(): Promise<RuntimeProvidersListResponse> {
    const [directory, settings] = await Promise.all([
      this.client.call<RuntimeProvidersListResponse>("llm.providers"),
      this.client.call<RuntimeSettingsDescribeResponse>("settings.describe"),
    ]);
    const namespace = settings.namespaces.find((entry) => entry.ns === CUSTOM_NS);
    return { ...directory, providers: directory.providers.map((provider) => {
      const section = settings.namespaces.find((entry) => entry.ns === provider.settingsNs);
      const value = at(section?.value, provider.settingsPath);
      const configured = value !== undefined;
      const speech = object(value).api === HUNYUAN_SPEECH.api;
      return { ...provider, configured, enabled: configured && object(value).enabled !== false,
        ...(provider.settingsNs === CUSTOM_NS ? { configuration: { modelDeclarations: true, apis: speech ? [HUNYUAN_SPEECH.api] : APIS,
          modelType: speech ? "asr" as const : "chat" as const, canToggle: true, canProbe: !speech,
          ...(!speech && provider.provider === "ollama-cloud" ? { defaultBaseURL: "https://ollama.com/v1", defaultApi: "openai-completions" as const, defaultCredentialRef: "OLLAMA_API_KEY" } : {}),
        } } : {}),
        // The pinned native DeepSeek adapter speaks Chat Completions. These are
        // public draft-probe defaults, never a readback of credentials or env overrides.
        ...(provider.settingsNs === "llm-deepseek" && provider.provider === "deepseek-official" ? { configuration: {
          modelDeclarations: false, apis: [], canToggle: true, canProbe: true, defaultBaseURL: "https://api.deepseek.com", defaultApi: "openai-completions" as const,
        } } : {}),
      };
    }), ...(settings.writable && namespace ? {
      creation: { kind: "openai-compatible" as const, revision: namespace.revision, apis: APIS, ...(this.applicationModels ? { speech: HUNYUAN_SPEECH } : {}), canProbe: true, canEnableOnCreate: true },
    } : {}) };
  }

  async apply(input: RuntimeProviderApplyParams): Promise<RuntimeProviderApplyResponse> {
    if (!input || !input.target || !["create", "update"].includes(input.target.kind)
      || typeof input.target.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.target.id)
      || ["__proto__", "constructor", "prototype"].includes(input.target.id)
      || !Number.isInteger(input.expectedRevision) || typeof input.baseURL !== "string") {
      throw new Error("Invalid provider command");
    }
    const [directory, settings] = await Promise.all([
      this.client.call<RuntimeProvidersListResponse>("llm.providers"),
      this.client.call<RuntimeSettingsDescribeResponse>("settings.describe"),
    ]);
    if (!settings.writable) throw new Error("Runtime settings are read-only");
    const id = input.target.id;
    const existing = directory.providers.find((entry) => entry.provider === id && entry.active)
      ?? directory.providers.find((entry) => entry.provider === id);
    const create = input.target.kind === "create";
    if (create && existing) throw new Error("Provider ID already exists; refresh before editing it");
    if (!create && !existing) throw new Error("Provider no longer exists");
    if (id === "openai-codex") throw new Error("This provider requires an interactive OAuth authorization session");
    const ns = create ? CUSTOM_NS : existing!.settingsNs;
    const path = create ? ["providers", id] : [...existing!.settingsPath];
    const namespace = settings.namespaces.find((entry) => entry.ns === ns);
    if (!namespace) throw new Error("Runtime does not expose this provider adapter");
    if (namespace.revision !== input.expectedRevision) throw new DshClientError("settings-conflict", "Provider settings changed; refresh before saving");
    if (create && at(namespace.value, path) !== undefined) throw new Error("Provider ID already exists");
    const current = object(at(namespace.value, path));
    const baseURL = input.baseURL.trim() ? endpoint(input.baseURL.trim()) : "";
    const api = input.api ?? current.api;
    const speech = api === HUNYUAN_SPEECH.api;
    if (speech && (!this.applicationModels || !isHunyuanSpeechEndpoint(baseURL))) throw new Error("语音连接请使用混元转写服务地址");
    if (!create && input.api !== undefined && (current.api === HUNYUAN_SPEECH.api) !== speech) throw new Error("连接用途不能更改，请创建新连接");
    if (create && !input.displayName?.trim()) throw new Error("New providers require a name");
    if (input.api !== undefined && (ns !== CUSTOM_NS || (!speech && !APIS.some(api => api === input.api)))) throw new Error("Unsupported protocol for this adapter");
    if (input.models !== undefined) {
      if (ns !== CUSTOM_NS || !Array.isArray(input.models) || input.models.length > 1000) throw new Error("Invalid model declarations");
      const seen = new Set<string>();
      for (const model of input.models) {
        if (!model || typeof model.id !== "string" || !model.id.trim() || model.id !== model.id.trim() || seen.has(model.id)) throw new Error("Model IDs must be nonempty and unique");
        seen.add(model.id);
        if ((model.type === "asr") !== speech || (model.type !== undefined && model.type !== "chat" && model.type !== "asr")) throw new Error("模型用途与连接不匹配");
        if (speech && (!/^[a-zA-Z0-9._-]{1,100}$/u.test(model.id) || model.input !== undefined || model.maxTokens !== undefined || model.contextWindow !== undefined || model.reasoningEfforts !== undefined)) throw new Error("语音模型请仅填写模型名称");
        for (const n of [model.contextWindow, model.maxTokens]) if (n !== undefined && (!Number.isInteger(n) || n <= 0)) throw new Error("Model limits must be positive integers");
        if (model.name !== undefined && (typeof model.name !== "string" || !model.name.trim())) throw new Error("Model display names must be nonempty");
        if (model.contextWindow !== undefined && model.maxTokens !== undefined && model.maxTokens > model.contextWindow) throw new Error("Output limit cannot exceed the context window");
        if (model.input !== undefined && (!Array.isArray(model.input) || !model.input.includes("text") || new Set(model.input).size !== model.input.length || model.input.some((value: unknown) => value !== "text" && value !== "image"))) throw new Error("Model input must include text and optionally image");
        if (model.reasoningEfforts !== undefined && model.reasoningEfforts !== false) {
          const efforts = object(model.reasoningEfforts);
          if (!Object.keys(efforts).some(level => level !== "off") || Object.entries(efforts).some(([level, wire]) =>
            !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)
            || (wire !== null && (typeof wire !== "string" || !wire.trim()))
            || (level !== "off" && wire === null))) throw new Error("Invalid model reasoning efforts");
        }
      }
      const defaults = object(settings.namespaces.find((entry) => entry.ns === "agent-default-model")?.value);
      if (defaults.provider === id && Array.isArray(current.models)
        && current.models.some((model) => object(model).id === defaults.model)
        && !input.models.some((model) => model.id === defaults.model)) {
        throw new Error("Select another default model before removing its declaration");
      }
    }
    const ops: RuntimeSettingsPathOperation[] = [];
    const set = (key: string, value: unknown) => ops.push({ op: "set", path: [...path, key], value });
    if (input.disableNewModels !== undefined) {
      if (typeof input.disableNewModels !== "boolean" || ns !== CUSTOM_NS || !input.models) throw new Error("Invalid model import policy");
      if (input.disableNewModels) {
        const catalog = await this.client.call<RuntimeModelsListResponse>("llm.models");
        const existingIds = new Set([
          ...(Array.isArray(current.models) ? current.models.map(model => object(model).id) : []),
          ...((catalog.groups ?? []).find(group => group.id === id)?.models.map(model => model.id) ?? []),
        ]);
        const previous = object(namespace.value).modelSelection;
        const disabled = new Set(Array.isArray(object(previous)[id]) ? object(previous)[id] as string[] : []);
        for (const model of input.models) if (!existingIds.has(model.id)) disabled.add(model.id);
        ops.push({ op: "set", path: ["modelSelection", id], value: [...disabled] });
      }
    }
    // Legacy callers still create disabled drafts; activation must be explicit.
    if (create) {
      if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("Invalid enabled state");
      if (input.enabled === true && (!baseURL || !input.api || !input.models?.length)) throw new Error("Enabling a new connection requires an endpoint, protocol and at least one model");
      set("enabled", input.enabled === true);
    }
    else if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean" || !supportsProviderLifecycle(ns)) throw new Error("This adapter does not support changing enabled state");
      await this.assertEnabledChange(id, input.enabled);
      set("enabled", input.enabled);
    }
    if (baseURL) set("baseURL", baseURL);
    else ops.push({ op: "unset", path: [...path, "baseURL"] });
    if (input.displayName !== undefined) {
      if (ns !== CUSTOM_NS || !input.displayName.trim()) throw new Error("Invalid provider display name");
      set("displayName", input.displayName.trim());
    }
    if (input.api !== undefined) set("api", input.api);
    if (input.models !== undefined) set("models", input.models);

    let stagedRef: string | null = null;
    switch (input.credential?.kind) {
      case "keep": {
        const oldEndpoint = typeof current.baseURL === "string" ? endpoint(current.baseURL, false) : "";
        if (!create && baseURL !== oldEndpoint && !input.credential.allowEndpointChange
          && !(id === "ollama-cloud" && typeof current.apiKeyEnv !== "string")) throw new Error("Changing the endpoint requires confirmation before reusing its credential");
        if (create) set("apiKeyEnv", `OPENCRAFT_UNBOUND_${randomUUID().replaceAll("-", "_")}`);
        else if (id === "ollama-cloud" && typeof current.apiKeyEnv !== "string") set("apiKeyEnv", "OLLAMA_API_KEY");
        break;
      }
      case "replace":
        if (typeof input.credential.value !== "string" || !input.credential.value.trim() || /[\r\n\0]/.test(input.credential.value)) throw new Error("API key is empty or contains invalid control characters");
        stagedRef = `OPENCRAFT_PROVIDER_${randomUUID().replaceAll("-", "_")}`;
        set("apiKeyEnv", stagedRef);
        break;
      case "reference":
        if (typeof input.credential.ref !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.credential.ref)) throw new Error("Invalid credential reference");
        set("apiKeyEnv", input.credential.ref);
        break;
      case "none":
        // An explicit empty binding must not fall through to an inherited/default secret.
        set("apiKeyEnv", `OPENCRAFT_UNBOUND_${randomUUID().replaceAll("-", "_")}`);
        break;
      default: throw new Error("Choose how this provider authenticates");
    }
    // Every enabling command uses the same validation, including direct apply.
    if (input.enabled === true && input.credential.kind !== "replace") {
      const ref = input.credential.kind === "reference" ? input.credential.ref : current.apiKeyEnv;
      if (input.credential.kind === "none" || typeof ref !== "string") throw new Error("Configure authentication before enabling this provider");
      const credentials = await this.client.call<{ credentials: Record<string, { configured: boolean }> }>("credentials.describe", { refs: [ref], ...(speech ? { storedOnly: true } : {}) });
      if (!credentials.credentials[ref]?.configured) throw new Error("Configure authentication before enabling this provider");
    }
    if (input.enabled === true && ns === CUSTOM_NS) {
      const declared = input.models ?? (Array.isArray(current.models) ? current.models : []);
      const previousIds = new Set(Array.isArray(current.models) ? current.models.map(model => object(model).id) : []);
      const policy = object(namespace.value).modelSelection;
      const disabled = new Set(Array.isArray(object(policy)[id]) ? object(policy)[id] as string[] : []);
      if (!declared.some(model => !disabled.has(model.id)
        && !(input.disableNewModels === true && !previousIds.has(model.id)))) {
        throw new Error("请先获取模型，并启用至少一个模型，再启用提供商");
      }
    }
    if (stagedRef && input.credential.kind === "replace") {
      try { await this.client.call("credentials.set", { ref: stagedRef, value: input.credential.value.trim() }); }
      catch { throw new DshClientError("provider-credential-uncertain", `Credential staging could not be confirmed. Configuration was not submitted. Recovery reference: ${stagedRef}`); }
    }
    try {
      const saved = await this.client.call<RuntimeSettingsNamespaceView>("settings.mutate", { ns, expectedRevision: input.expectedRevision, ops });
      return { provider: id, revision: saved.revision, saved: true };
    } catch (error) {
      // A lost response may follow a committed write. Never undo its credential blindly.
      let freshSection: RuntimeSettingsNamespaceView | undefined;
      try {
        const fresh = await this.client.call<RuntimeSettingsDescribeResponse>("settings.describe");
        const section = fresh.namespaces.find((entry) => entry.ns === ns);
        freshSection = section;
        if (section && section.revision > input.expectedRevision && ops.every((op) =>
          op.op === "set" ? isDeepStrictEqual(at(section.user, op.path), op.value) : at(section.user, op.path) === undefined)) {
          return { provider: id, revision: section.revision, saved: true };
        }
      } catch { /* no authority available to reconcile */ }
      // DSH can emit settings-rejected after persistence if a commit listener throws.
      // Only a CAS conflict, or an unchanged authoritative revision after a definitive
      // rejection, proves that our fresh credential was not committed.
      if (error instanceof DshClientError && (error.code === "settings-conflict"
        || (error.code === "settings-rejected" && freshSection?.revision === input.expectedRevision))) {
        if (stagedRef) {
          try { await this.client.call("credentials.unset", { ref: stagedRef }); }
          catch { throw new DshClientError(error.code, `${error.message}. Uncommitted credential retained for cleanup: ${stagedRef}`); }
        }
        throw error;
      }
      throw new DshClientError("provider-save-uncertain", `Save outcome is unknown. Refresh and inspect the provider before retrying.${stagedRef ? ` Credential retained: ${stagedRef}` : ""}`);
    }
  }

  private async assertEnabledChange(provider: string, enabled: boolean): Promise<void> {
    if (enabled) return; // DSH validates serviceability on the enabling CAS write.
    const settings = await this.client.call<RuntimeSettingsDescribeResponse>("settings.describe");
    const defaults = object(settings.namespaces.find((entry) => entry.ns === "agent-default-model")?.value);
    if (defaults.provider === provider) throw new Error("Select another default model before disabling this provider");
  }

  async setEnabled(input: RuntimeProviderSetEnabledParams): Promise<RuntimeProviderApplyResponse> {
    if (!input || typeof input.enabled !== "boolean") throw new Error("Invalid enabled state");
    const settings = await this.client.call<RuntimeSettingsDescribeResponse>("settings.describe");
    const directory = await this.list();
    const provider = directory.providers.find((entry) => entry.provider === input.provider);
    if (!provider?.configured || !provider.configuration?.canToggle) throw new Error("This provider cannot be enabled or disabled here");
    const section = settings.namespaces.find((entry) => entry.ns === provider.settingsNs);
    const config = object(at(section?.value, provider.settingsPath));
    return this.apply({ target: { kind: "update", id: input.provider }, expectedRevision: input.expectedRevision,
      baseURL: typeof config.baseURL === "string" ? config.baseURL : "", enabled: input.enabled, credential: { kind: "keep" },
    });
  }

  async discover(input: RuntimeModelsDiscoverParams): Promise<RuntimeModelsDiscoverResponse> {
    if (input.api === HUNYUAN_SPEECH.api || (this.applicationModels && input.source === "catalog" && input.provider && (await this.list()).providers.find(p => p.provider === input.provider)?.configuration?.modelType === "asr")) throw new Error("请手动添加语音模型名称");
    if (input.source === "catalog") {
      if (!input.provider) throw new Error("Catalog lookup requires a provider");
      // No draft endpoint or secret is sent for catalog lookup.
      return this.client.call("llm.discoverModels", { settingsNs: input.settingsNs, provider: input.provider });
    }
    if (input.source !== "endpoint" || !input.baseURL || !APIS.includes(input.api as typeof APIS[number])) throw new Error("Endpoint discovery requires a supported protocol and base URL");
    if (input.apiKey !== undefined && (typeof input.apiKey !== "string" || /[\r\n\0]/.test(input.apiKey))) throw new Error("Invalid discovery credential");
    // Explicit draft credentials only. Never send a stored provider secret to a new endpoint implicitly.
    const baseURL = endpoint(input.baseURL);
    const url = `${baseURL}/models`;
    const response = await fetch(url, {
      redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json", ...(input.apiKey?.trim() ? { authorization: `Bearer ${input.apiKey.trim()}` } : {}) },
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Model discovery returned HTTP ${response.status}`); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty model discovery response");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 4 * 1024 * 1024) throw new Error("Model discovery response exceeds 4 MiB");
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let body: Record<string, unknown>;
    try { body = object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { throw new Error("Endpoint returned invalid JSON for model discovery"); }
    if (!Array.isArray(body.data)) throw new Error("Endpoint did not return a model list in data[]; enter model IDs manually");
    const ids = new Set<string>();
    const models = body.data.flatMap((entry: unknown) => {
      const model = object(entry);
      if (typeof model.id !== "string" || !model.id.trim() || ids.has(model.id.trim())) return [];
      ids.add(model.id.trim());
      return [{ id: model.id.trim(), ...(typeof model.name === "string" ? { name: model.name } : {}) }];
    });
    if (input.provider !== "ollama-cloud") return { models };
    const metadata = await ollamaModelMetadata(baseURL, models);
    return { models: models.map(model => ({ ...model, ...metadata.get(model.id) })) };
  }
}
