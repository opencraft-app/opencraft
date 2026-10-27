export type RuntimeSettingsApplyMode = "live" | "restart";

export interface RuntimeSettingsSecretView {
  readonly path: readonly string[];
  readonly set: boolean;
}

export interface RuntimeSettingsNamespaceView {
  readonly ns: string;
  readonly schema: unknown;
  readonly value: unknown;
  readonly base?: unknown;
  readonly user?: unknown;
  readonly applies: RuntimeSettingsApplyMode;
  readonly secrets: readonly RuntimeSettingsSecretView[];
  readonly revision: number;
}

export interface RuntimeSettingsDescribeResponse {
  readonly writable: boolean;
  readonly hasDocument: boolean;
  readonly namespaces: readonly RuntimeSettingsNamespaceView[];
}

export type RuntimeSettingsPathOperation =
  | { readonly op: "set"; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: "unset"; readonly path: readonly string[] };

export interface RuntimeSettingsMutateParams {
  readonly ns: string;
  readonly ops: readonly RuntimeSettingsPathOperation[];
  readonly expectedRevision?: number;
}

export interface RuntimeCredentialView {
  readonly configured: boolean;
  readonly source?: string;
  readonly writable: boolean;
}

export interface RuntimeCredentialsDescribeParams {
  readonly refs: readonly string[];
}

export interface RuntimeCredentialsDescribeResponse {
  readonly credentials: Readonly<Record<string, RuntimeCredentialView>>;
}

export interface RuntimeCredentialSetParams {
  readonly ref: string;
  readonly value: string;
}

export interface RuntimeCredentialUnsetParams {
  readonly ref: string;
}

export interface RuntimeProviderView {
  readonly provider: string;
  readonly displayName: string;
  readonly settingsNs: string;
  readonly settingsPath: readonly string[];
  readonly active: boolean;
  readonly configured?: boolean;
  readonly enabled?: boolean;
  readonly declared?: boolean;
  readonly configuration?: { readonly modelDeclarations: boolean; readonly apis: readonly RuntimeProviderProtocol[]; readonly modelType?: "chat" | "asr"; readonly canToggle?: boolean; readonly canProbe?: boolean; readonly canCheckSaved?: boolean;
    readonly defaultBaseURL?: string; readonly defaultApi?: RuntimeProviderProtocol; readonly defaultCredentialRef?: string };
}

export interface RuntimeProvidersListResponse {
  readonly application?: { readonly state: "pending" | "applied" | "failed"; readonly revision: number; readonly error?: string };
  readonly providers: readonly RuntimeProviderView[];
  readonly creation?: { readonly kind: "openai-compatible"; readonly revision: number; readonly apis: readonly RuntimeOpenAIProtocol[]; readonly speech?: { readonly api: "hunyuan-asr"; readonly baseURL: string; readonly model: string }; readonly canProbe?: boolean; readonly canEnableOnCreate?: boolean };
}

export type RuntimeOpenAIProtocol = "openai-completions" | "openai-responses";
export type RuntimeProviderProtocol = RuntimeOpenAIProtocol | "hunyuan-asr";

/** Host application command: credentials and settings are coordinated behind this boundary. */
export interface RuntimeProviderApplyParams {
  /** Discovery imports new declarations disabled in the same settings revision. */
  readonly disableNewModels?: boolean;
  readonly target: { readonly kind: "create"; readonly id: string } | { readonly kind: "update"; readonly id: string };
  readonly expectedRevision: number;
  readonly baseURL: string;
  readonly displayName?: string;
  readonly api?: RuntimeProviderProtocol;
  readonly models?: readonly RuntimeDiscoveredModelView[];
  readonly enabled?: boolean;
  readonly credential: { readonly kind: "keep"; readonly allowEndpointChange?: boolean }
    | { readonly kind: "replace"; readonly value: string }
    | { readonly kind: "reference"; readonly ref: string }
    | { readonly kind: "none" };
}

export interface RuntimeProviderApplyResponse {
  readonly provider: string;
  readonly revision: number;
  /** Persisted config does not guarantee endpoint availability or successful inference. */
  readonly saved: true;
}

export interface RuntimeProviderSetEnabledParams {
  readonly provider: string;
  readonly enabled: boolean;
  readonly expectedRevision: number;
}

export interface RuntimeModelView {
  readonly type?: "chat" | "asr";
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly input?: readonly ("text" | "image")[];
  readonly enabled?: boolean;
  readonly source?: "builtin" | "custom";
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly reasoning?: {
    readonly efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[];
    readonly defaultEffort?: string;
  };
}

/** Selection policy, not deletion of the upstream catalog or conversation history. */
export interface RuntimeModelMutationParams {
  readonly provider: string;
  readonly model: string;
  readonly expectedRevision: number;
}

export interface RuntimeModelGroupView {
  readonly id: string;
  readonly name: string;
  readonly models: readonly RuntimeModelView[];
}

export interface RuntimeModelsListResponse {
  readonly groups: readonly RuntimeModelGroupView[];
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[];
}

export interface RuntimeModelsDiscoverParams {
  readonly source: "catalog" | "endpoint";
  readonly settingsNs: string;
  readonly provider?: string;
  readonly baseURL?: string;
  readonly api?: string;
  /** Write-only probe credential. It is never persisted or returned. */
  readonly apiKey?: string;
}

export interface RuntimeDiscoveredModelView {
  readonly type?: "chat" | "asr";
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly input?: readonly ("text" | "image")[];
  /** Explicitly offered reasoning levels and their provider wire spellings. */
  readonly reasoningEfforts?: false | Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
}

/** Explicit one-off draft probe. No persisted credential or session may be resolved for it. */
export interface RuntimeModelProbeParams {
  readonly baseURL: string;
  readonly api: RuntimeOpenAIProtocol;
  readonly model: string;
  readonly apiKey?: string;
}

export interface RuntimeModelProbeResponse {
  readonly ok: boolean;
  readonly model: string;
  readonly elapsedMs: number;
  readonly error?: string;
}
export interface RuntimeSavedModelCheckParams {
  readonly provider: string;
  readonly model: string;
  readonly expectedRevision: number;
}

export interface RuntimeModelsDiscoverResponse {
  readonly models: readonly RuntimeDiscoveredModelView[];
}

export interface RuntimeStatusResponse {
  readonly engineId: string;
  readonly displayName: string;
  readonly version: string;
  readonly cwd: string;
  readonly provider: string | null;
  readonly model: string | null;
}
