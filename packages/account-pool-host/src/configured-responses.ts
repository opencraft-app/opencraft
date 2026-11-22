/** Optional projection of installation-owned model configuration. No storage or defaults live here. */
export interface ConfiguredCodexResponses {
  catalog(): Promise<readonly Record<string, unknown>[]>;
  resolve(model: string): Promise<{
    baseUrl: string;
    model: string;
    /** Absent preserves existing Responses projections. `openai-completions` is provider passthrough only. */
    protocol?: "openai-responses" | "anthropic-messages" | "openai-completions";
    maxTokens?: number;
    apiKey?: string;
    reasoningEfforts?: false | Readonly<Record<string, string | null>>;
  } | null>;
}

export const CONFIGURED_CODEX_MODEL_PREFIX = "configured/";

/** Write-only model credential owner for engine callers in proxy mode. There is deliberately no value readback. */
export interface ConfiguredModelCredentials {
  configured(reference: string): Promise<boolean>;
  set(reference: string, value: string): Promise<void>;
  remove(reference: string): Promise<void>;
}
