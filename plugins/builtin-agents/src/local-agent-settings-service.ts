import type {
  AppServerMethod, AppServerMethodParams, AppServerMethodResult, RuntimeCredentialView,
  RuntimeDiscoveredModelView, RuntimeModelsListResponse, RuntimeProviderView,
  RuntimeProvidersListResponse, RuntimeSettingsDescribeResponse, RuntimeSettingsNamespaceView,
  RuntimeStatusResponse,
  RuntimeProviderApplyParams, RuntimeOpenAIProtocol,
} from "@opencraft/appserver-protocol";
import { AdaptivePanel } from "@opencraft/workbench-runtime";

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
  readonly displayName: string; readonly api?: RuntimeOpenAIProtocol;
  readonly models: readonly RuntimeDiscoveredModelView[];
}
export interface SaveRuntimeProviderInput {
  readonly enabled?: boolean;
  readonly baseURL: string;
  readonly credential: RuntimeProviderApplyParams["credential"];
  readonly api?: RuntimeOpenAIProtocol;
  readonly displayName?: string;
  readonly models?: readonly RuntimeDiscoveredModelView[];
}

export interface ProviderEditState {
  readonly draft: RuntimeProviderConfiguration;
  readonly baseRevision: number;
  readonly dirty: boolean;
  readonly auth: "keep" | "replace" | "reference";
  readonly apiKey: string;
  readonly allowEndpointChange: boolean;
}

/** Ephemeral editing session. Never persisted, and never a runtime config store. */
export class ProviderEditSession {
  private listeners = new Set<() => void>();
  constructor(private state: ProviderEditState) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  set<K extends keyof ProviderEditState>(key: K, update: ProviderEditState[K] | ((value: ProviderEditState[K]) => ProviderEditState[K])) {
    const value = typeof update === "function" ? (update as (value: ProviderEditState[K]) => ProviderEditState[K])(this.state[key]) : update;
    if (Object.is(value, this.state[key])) return;
    this.state = { ...this.state, [key]: value };
    this.listeners.forEach(listener => listener());
  }
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
  readonly panel = new AdaptivePanel();
  private readonly edits = new Map<string, ProviderEditSession>();
  editor(provider: RuntimeProviderView): ProviderEditSession {
    let editor = this.edits.get(provider.provider);
    if (!editor) {
      editor = new ProviderEditSession({ draft: this.providerConfiguration(provider),
        baseRevision: this.snapshot.settings?.namespaces.find(entry => entry.ns === provider.settingsNs)?.revision ?? -1,
        dirty: false, auth: "keep", apiKey: "", allowEndpointChange: false });
      this.edits.set(provider.provider, editor);
    }
    return editor;
  }
  discardEditor(provider: string): void { this.edits.delete(provider); }
  private snapshot: LocalAgentSettingsSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private refreshGeneration = 0;
  private disposed = false;
  constructor(private readonly requestHost: HostProtocolRequest) {}

  getSnapshot = (): LocalAgentSettingsSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  };

  async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    this.publish({ ...this.snapshot, phase: "loading", error: null });
    try {
      const [status, settings, providers, models] = await Promise.all([
        this.requestHost("local", "runtime/status/read", {}),
        this.requestHost("local", "runtime/settings/describe", {}),
        this.requestHost("local", "runtime/providers/list", {}),
        this.requestHost("local", "runtime/models/list", { includeDisabled: true }),
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
      baseURL: typeof profile.baseURL === "string" ? profile.baseURL : "",
      displayName: typeof profile.displayName === "string" ? profile.displayName : provider.displayName,
      api: profile.api === "openai-completions" || profile.api === "openai-responses" ? profile.api : undefined,
      models: Array.isArray(profile.models) ? profile.models as RuntimeDiscoveredModelView[] : [],
      credentialRef: typeof profile.apiKeyEnv === "string" && profile.apiKeyEnv.trim() !== ""
        ? profile.apiKeyEnv.trim() : defaultCredentialRef(provider.provider),
    };
  }

  async describeCredential(ref: string): Promise<RuntimeCredentialView | null> {
    if (ref.trim() === "") return null;
    const result = await this.requestHost("local", "runtime/credentials/describe", { refs: [ref.trim()] });
    return result.credentials[ref.trim()] ?? null;
  }

  async discoverModels(provider: RuntimeProviderView | null, input: SaveRuntimeProviderInput, source: "catalog" | "endpoint"): Promise<readonly RuntimeDiscoveredModelView[]> {
    const result = await this.requestHost("local", "runtime/models/discover", {
      source,
      settingsNs: provider?.settingsNs ?? "",
      ...(provider ? { provider: provider.provider } : {}),
      ...(input.api ? { api: input.api } : {}),
      ...(input.baseURL.trim() === "" ? {} : { baseURL: input.baseURL.trim() }),
      ...(input.credential.kind === "replace" ? { apiKey: input.credential.value } : {}),
    });
    return result.models;
  }

  async saveDefaultModel(provider: string, model: string, reasoningEffort: string | undefined, expectedRevision: number): Promise<void> {
    const namespace = this.namespace("agent-default-model");
    const selected = this.snapshot.models?.groups.find(group => group.id === provider)?.models.find(entry => entry.id === model);
    if (!selected || selected.enabled === false) throw new Error("Selected model is unavailable. Refresh the model catalog.");
    if (reasoningEffort !== undefined && !selected.reasoning?.efforts.some(entry => entry.id === reasoningEffort)) {
      throw new Error(`Selected model does not support reasoning effort "${reasoningEffort}"`);
    }
    await this.requestHost("local", "runtime/settings/mutate", { ns: namespace.ns, expectedRevision, ops: [
      { op: "set", path: ["provider"], value: provider }, { op: "set", path: ["model"], value: model },
      reasoningEffort === undefined
        ? { op: "unset", path: ["reasoningEffort"] }
        : { op: "set", path: ["reasoningEffort"], value: reasoningEffort },
    ] });
    await this.refresh();
  }

  async saveProvider(provider: RuntimeProviderView, input: SaveRuntimeProviderInput, expectedRevision: number): Promise<void> {
    await this.requestHost("local", "runtime/providers/apply", {
      ...input, target: { kind: "update", id: provider.provider }, expectedRevision,
    });
    await this.refresh();
  }

  async createProvider(id: string, input: SaveRuntimeProviderInput): Promise<void> {
    const creation = this.snapshot.providers?.creation;
    if (!creation) throw new Error("This runtime does not support creating providers");
    await this.requestHost("local", "runtime/providers/apply", {
      ...input, target: { kind: "create", id }, expectedRevision: creation.revision,
    });
    await this.refresh();
  }

  async setEnabled(provider: RuntimeProviderView, enabled: boolean, expectedRevision: number): Promise<void> {
    await this.requestHost("local", "runtime/providers/setEnabled", { provider: provider.provider, enabled, expectedRevision });
    await this.refresh();
  }

  async changeModel(provider: string, model: string, enabled?: boolean): Promise<void> {
    const expectedRevision = this.namespace("llm-pi-ai").revision;
    if (enabled === undefined) await this.requestHost("local", "runtime/models/delete", { provider, model, expectedRevision });
    else await this.requestHost("local", "runtime/models/setEnabled", { provider, model, expectedRevision, enabled });
    await this.refresh();
  }

  dispose(): void { this.disposed = true; this.refreshGeneration += 1; this.listeners.clear(); this.edits.clear(); }
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
