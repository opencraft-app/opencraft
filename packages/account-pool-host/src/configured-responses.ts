/** Optional projection of installation-owned model configuration. No storage or defaults live here. */
export interface ConfiguredCodexResponses {
  catalog(): Promise<readonly Record<string, unknown>[]>;
  resolve(model: string): Promise<{
    baseUrl: string;
    model: string;
    /** Absent preserves existing Responses projections. */
    protocol?: "openai-responses" | "anthropic-messages";
    maxTokens?: number;
    apiKey?: string;
    reasoningEfforts?: false | Readonly<Record<string, string | null>>;
  } | null>;
}

export const CONFIGURED_CODEX_MODEL_PREFIX = "configured/";
