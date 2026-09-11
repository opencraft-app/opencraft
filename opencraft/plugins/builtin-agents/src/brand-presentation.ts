export type Brand = "openai" | "anthropic" | "claude" | "deepseek" | "google" | "gemini" | "ollama" | "qwen";
const providers: Readonly<Record<string, Brand>> = {
  openai: "openai", "openai-codex": "openai", anthropic: "anthropic",
  deepseek: "deepseek", "deepseek-official": "deepseek", google: "google",
  "google-generative-ai": "google", ollama: "ollama", qwen: "qwen",
};
export function presentationBrand(id: string, model = false): Brand | undefined {
  const key = id.toLowerCase();
  if (!model) return providers[key];
  // Model family recognition is presentation-only, including routed model IDs.
  const family = key.split("/").at(-1) ?? key;
  if (/^claude(?:-|$)/.test(family)) return "claude";
  if (/^deepseek(?:-|$)/.test(family)) return "deepseek";
  if (/^gemini(?:-|$)/.test(family)) return "gemini";
  if (/^qwen(?:\d|-|$)/.test(family)) return "qwen";
  if (/^(?:gpt-|o[134](?:-|$))/.test(family)) return "openai";
  return undefined;
}
