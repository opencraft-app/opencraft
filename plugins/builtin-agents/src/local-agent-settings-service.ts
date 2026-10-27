import type {
  AppServerMethod, AppServerMethodParams, AppServerMethodResult, RuntimeCredentialView,
  RuntimeDiscoveredModelView, RuntimeModelsListResponse, RuntimeProviderView,
  RuntimeProvidersListResponse, RuntimeSettingsDescribeResponse, RuntimeSettingsNamespaceView,
  RuntimeStatusResponse,
  RuntimeProviderApplyParams, RuntimeProviderProtocol,
  RuntimeModelProbeResponse,
} from "@opencraft/appserver-protocol";
export type HostProtocolRequest = <TMethod extends AppServerMethod>(hostId: string, method: TMethod,
  params: AppServerMethodParams<TMethod>) => Promise<AppServerMethodResult<TMethod>>;

export interface LocalAgentSettingsSnapshot {
  readonly phase: "idle" | "loading" | "ready" | "error";
  readonly status: RuntimeStatusResponse | null;
  readonly settings: RuntimeSettingsDescribeResponse | null;
  readonly providers: RuntimeProvidersListResponse | null;
  readonly models: RuntimeModelsListResponse | null;
  readonly error: string | null;
}

export interface RuntimeProviderConfiguration {
  readonly baseURL: string; readonly credentialRef: string;
  readonly displayName: string; readonly api?: RuntimeProviderProtocol;
  readonly models: readonly RuntimeDiscoveredModelView[];
}
export interface SaveRuntimeProviderInput {
  readonly disableNewModels?: boolean;
  readonly enabled?: boolean;
  readonly baseURL: string;
  readonly credential: RuntimeProviderApplyParams["credential"];
  readonly api?: RuntimeProviderProtocol;
  readonly displayName?: string;
  readonly models?: readonly RuntimeDiscoveredModelView[];
}

const EMPTY_SNAPSHOT: LocalAgentSettingsSnapshot = Object.freeze({
  phase: "idle", status: null, settings: null, providers: null, models: null, error: null,
});

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function atPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) current = record(current)[segment];
  return current;
}
function defaultCredentialRef(provider: string): string {
  return `${provider.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()}_API_KEY`;
}

export class LocalAgentSettingsService {
  private snapshot: LocalAgentSettingsSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private refreshGeneration = 0;
  private disposed = false;
  constructor(private readonly requestHost: HostProtocolRequest, readonly hostId: string) {
    if (typeof hostId !== "string" || !hostId.trim()) throw new Error("Model settings require an explicit environment");
  }

  getSnapshot = (): LocalAgentSettingsSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  };

  async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    this.publish({ ...this.snapshot, phase: "loading", error: null });
    try {
      const [status, settings, providers, models] = await Promise.all([
        this.requestHost(this.hostId, "runtime/status/read", {}),
        this.requestHost(this.hostId, "runtime/settings/describe", {}),
        this.requestHost(this.hostId, "runtime/providers/list", {}),
        this.requestHost(this.hostId, "runtime/models/list", { includeDisabled: true }),
      ]);
      if (this.disposed || generation !== this.refreshGeneration) return;
      this.publish({ phase: "ready", status, settings, providers, models, error: null });
    } catch (error) {
      if (this.disposed || generation !== this.refreshGeneration) return;
      this.publish({ ...this.snapshot, phase: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }

  providerConfiguration(provider: RuntimeProviderView): RuntimeProviderConfiguration {
    const namespace = this.snapshot.settings?.namespaces.find((entry) => entry.ns === provider.settingsNs);
    const profile = record(atPath(namespace?.value, provider.settingsPath));
    return {
      baseURL: typeof profile.baseURL === "string" ? profile.baseURL : !provider.configured && provider.configuration?.modelDeclarations ? provider.configuration.defaultBaseURL ?? "" : "",
      displayName: typeof profile.displayName === "string" ? profile.displayName : provider.displayName,
      api: profile.api === "openai-completions" || profile.api === "openai-responses" || profile.api === "hunyuan-asr" ? profile.api : !provider.configured && provider.configuration?.modelDeclarations ? provider.configuration.defaultApi : undefined,
      // DSH materializes an omitted optional modality array as []. The public
      // command uses omission for inherited capabilities and rejects explicit
      // empty declarations. Normalize the read projection, not the stored data.
      models: Array.isArray(profile.models) ? (profile.models as RuntimeDiscoveredModelView[]).map(model =>
        Array.isArray(model.input) && model.input.length === 0 ? { ...model, input: undefined } : model) : [],
      credentialRef: typeof profile.apiKeyEnv === "string" && profile.apiKeyEnv.trim() !== ""
        ? profile.apiKeyEnv.trim() : provider.configuration?.defaultCredentialRef ?? defaultCredentialRef(provider.provider),
    };
  }

  async describeCredential(ref: string): Promise<RuntimeCredentialView | null> {
    if (ref.trim() === "") return null;
    const result = await this.requestHost(this.hostId, "runtime/credentials/describe", { refs: [ref.trim()] });
    return result.credentials[ref.trim()] ?? null;
  }

  async discoverModels(provider: RuntimeProviderView | null, input: SaveRuntimeProviderInput, source: "catalog" | "endpoint"): Promise<readonly RuntimeDiscoveredModelView[]> {
    const result = await this.requestHost(this.hostId, "runtime/models/discover", {
      source,
      settingsNs: provider?.settingsNs ?? "",
      ...(provider ? { provider: provider.provider } : {}),
      ...(input.api ? { api: input.api } : {}),
      ...(input.baseURL.trim() === "" ? {} : { baseURL: input.baseURL.trim() }),
      ...(input.credential.kind === "replace" ? { apiKey: input.credential.value } : {}),
    });
    return result.models;
  }

  async probeModel(input: SaveRuntimeProviderInput, model: string): Promise<RuntimeModelProbeResponse> {
    if (!input.api || input.api === "hunyuan-asr" || !input.baseURL.trim()) throw new Error("此连接不支持文本连通性检查");
    if (input.credential.kind === "replace" && !input.credential.value.trim()) throw new Error("Enter the test key before testing");
    if (input.credential.kind !== "replace" && input.credential.kind !== "none") throw new Error("Enter a test key explicitly. Saved credentials are not used for draft endpoint tests.");
    return this.requestHost(this.hostId, "runtime/models/probe", {
      baseURL: input.baseURL, api: input.api, model,
      ...(input.credential.kind === "replace" ? { apiKey: input.credential.value } : {}),
    });
  }
  async checkSavedModel(provider:string,model:string,expectedRevision:number):Promise<RuntimeModelProbeResponse>{
    return this.requestHost(this.hostId,"runtime/models/check",{provider,model,expectedRevision});
  }

  async saveDefaultModel(provider: string, model: string, reasoningEffort: string | undefined, expectedRevision: number): Promise<void> {
    const namespace = this.namespace("agent-default-model");
    const selected = this.snapshot.models?.groups.find(group => group.id === provider)?.models.find(entry => entry.id === model);
    if (!selected || selected.enabled === false) throw new Error("Selected model is unavailable. Refresh the model catalog.");
    if (selected.type === "asr") throw new Error("转写模型不能设为聊天默认");
    if (reasoningEffort !== undefined && !selected.reasoning?.efforts.some(entry => entry.id === reasoningEffort)) {
      throw new Error(`Selected model does not support reasoning effort "${reasoningEffort}"`);
    }
    await this.requestHost(this.hostId, "runtime/settings/mutate", { ns: namespace.ns, expectedRevision, ops: [
      { op: "set", path: ["provider"], value: provider }, { op: "set", path: ["model"], value: model },
      reasoningEffort === undefined
        ? { op: "unset", path: ["reasoningEffort"] }
        : { op: "set", path: ["reasoningEffort"], value: reasoningEffort },
    ] });
    await this.refresh();
  }

  async saveProvider(provider: RuntimeProviderView, input: SaveRuntimeProviderInput, expectedRevision: number): Promise<void> {
    await this.requestHost(this.hostId, "runtime/providers/apply", {
      ...input, target: { kind: "update", id: provider.provider }, expectedRevision,
    });
    await this.refresh();
  }

  async createProvider(id: string, input: SaveRuntimeProviderInput, expectedRevision?: number): Promise<void> {
    const creation = this.snapshot.providers?.creation;
    if (!creation) throw new Error("This runtime does not support creating providers");
    await this.requestHost(this.hostId, "runtime/providers/apply", {
      ...input, target: { kind: "create", id }, expectedRevision: expectedRevision ?? creation.revision,
    });
    await this.refresh();
  }

  async setEnabled(provider: RuntimeProviderView, enabled: boolean, expectedRevision: number): Promise<void> {
    await this.requestHost(this.hostId, "runtime/providers/setEnabled", { provider: provider.provider, enabled, expectedRevision });
    await this.refresh();
  }

  async deleteProvider(provider: RuntimeProviderView, expectedRevision: number): Promise<void> {
    await this.requestHost(this.hostId, "runtime/providers/delete", { provider: provider.provider, expectedRevision });
    await this.refresh();
  }
  async reapply():Promise<void>{await this.requestHost(this.hostId,"runtime/providers/reapply",{});await this.refresh();}

  async changeModel(provider: string, model: string, enabled?: boolean): Promise<void> {
    const expectedRevision = this.namespace("llm-pi-ai").revision;
    if (enabled === undefined) await this.requestHost(this.hostId, "runtime/models/delete", { provider, model, expectedRevision });
    else await this.requestHost(this.hostId, "runtime/models/setEnabled", { provider, model, expectedRevision, enabled });
    await this.refresh();
  }

  dispose(): void { this.disposed = true; this.refreshGeneration += 1; this.listeners.clear(); }
  private namespace(ns: string): RuntimeSettingsNamespaceView {
    const namespace = this.snapshot.settings?.namespaces.find((candidate) => candidate.ns === ns);
    if (!namespace) throw new Error(`Local Agent does not expose the ${ns} settings namespace`);
    if (this.snapshot.settings?.writable !== true) throw new Error("Local Agent settings are read-only");
    return namespace;
  }
  private publish(snapshot: LocalAgentSettingsSnapshot): void {
    this.snapshot = Object.freeze(snapshot); for (const listener of this.listeners) listener();
  }
}
