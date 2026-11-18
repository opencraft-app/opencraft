import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/** Explicit app-configured endpoint/model; no model discovery or credential-file fallback. */
export function compatibleProvider(config) {
  const url = new URL(config.baseUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error(
      "Compatible endpoint requires HTTPS or loopback HTTP, without credentials/query",
    );
  if (
    typeof config.modelId !== "string" ||
    !config.modelId.trim() ||
    config.modelId.length > 200
  )
    throw new Error("Explicit compatible model ID required");
  if (
    config.thinking !== undefined &&
    !["disabled", "enabled"].includes(config.thinking)
  )
    throw new Error("thinking must be enabled or disabled");
  const baseUrl = url.href.replace(/\/+$/, "");
  const api = openAICompletionsApi();
  const options = (value, model) => ({
    ...value,
    ...(config.thinking
      ? {
          onPayload: async (payload) => {
            const transformed = await value?.onPayload?.(payload, model);
            return {
              ...(transformed ?? payload),
              thinking: { type: config.thinking },
            };
          },
        }
      : {}),
  });
  return createProvider({
    id: "openai-compatible",
    name: "Explicit OpenAI-compatible endpoint",
    baseUrl,
    auth: {
      apiKey: envApiKeyAuth("Explicit evaluation API key", [
        "OPENCRAFT_EVAL_API_KEY",
      ]),
    },
    models: [
      {
        id: config.modelId,
        name: config.modelId,
        provider: "openai-compatible",
        api: "openai-completions",
        baseUrl,
        input: ["text"],
        reasoning: false,
        // Client caps, not claims about the upstream model's advertised capabilities/prices.
        contextWindow: 65536,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsUsageInStreaming: true,
          maxTokensField: "max_tokens",
        },
      },
    ],
    api: {
      stream: (model, context, value) =>
        api.stream(model, context, options(value, model)),
      streamSimple: (model, context, value) =>
        api.streamSimple(model, context, options(value, model)),
    },
  });
}
