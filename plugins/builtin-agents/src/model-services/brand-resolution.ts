/** Presentation only: never use these aliases to choose a connection or model. */
export type BrandKind = "provider" | "model";
const providerAliases = new Map(Object.entries({
  "deepseek-official": "deepseek", "openai-codex": "openai", "amazon-bedrock": "bedrock",
  "ant-ling": "antgroup", "azure-openai-responses": "azure", "google-vertex": "vertexai",
  "cloudflare-ai-gateway": "cloudflare", "cloudflare-workers-ai": "cloudflare",
  "github-copilot": "githubcopilot", "kimi-coding": "kimi", "z-ai": "zai",
  "ollama-cloud": "ollama",
}));
const modelFamilies: readonly [RegExp, string][] = [
  [/(?:^|[/:.])claude(?:[-_.\d]|$)/i, "claude"],
  [/(?:^|[/:.])deepseek(?:[-_.\d]|$)/i, "deepseek"],
  [/(?:^|[/:.])(?:gpt|o1|o3|o4)(?:[-_.\d]|$)/i, "openai"],
  [/(?:^|[/:.])gemini(?:[-_.\d]|$)/i, "gemini"],
  [/(?:^|[/:.])gemma(?:[-_.\d]|$)/i, "gemma"],
  [/(?:^|[/:.])(?:qwen|qwq)(?:[-_.\d]|$)/i, "qwen"],
  [/(?:^|[/:.])(?:meta-)?llama(?:[-_.\d]|$)/i, "meta"],
  [/(?:^|[/:.])(?:mistral|mixtral|codestral|devstral)(?:[-_.\d]|$)/i, "mistral"],
  [/(?:^|[/:.])(?:glm|chatglm)(?:[-_.\d]|$)/i, "chatglm"],
  [/(?:^|[/:.])(?:hunyuan|hy3|hy4)(?:[-_.\d]|$)/i, "hunyuan"],
  [/(?:^|[/:.])kimi(?:[-_.\d]|$)/i, "kimi"],
  [/(?:^|[/:.])moonshot(?:[-_.\d]|$)/i, "moonshot"],
  [/(?:^|[/:.])minimax(?:[-_.\d]|$)/i, "minimax"],
  [/(?:^|[/:.])grok(?:[-_.\d]|$)/i, "grok"],
  [/(?:^|[/:.])command(?:[-_.\d]|$)/i, "cohere"],
  [/(?:^|[/:.])doubao(?:[-_.\d]|$)/i, "doubao"],
  [/(?:^|[/:.])(?:ling|ring)(?:[-_.\d]|$)/i, "antgroup"],
];
export function resolveBrand(kind: BrandKind, id: string, available: ReadonlySet<string>): string | null {
  const normalized = id.trim().toLowerCase();
  const brand = kind === "provider" ? providerAliases.get(normalized) ?? normalized
    : modelFamilies.find(([pattern]) => pattern.test(normalized))?.[1];
  return brand && available.has(brand) ? brand : null;
}
