export type RecognizedProtocol = "openai-responses" | "openai-completions" | "anthropic-messages";

export interface RecognizedVendor {
  readonly vendorId: string;
  readonly vendorName: string;
  readonly protocol: RecognizedProtocol;
  readonly normalizedBaseUrl: string;
  readonly matched: boolean;
}

interface VendorRule {
  readonly vendorId: string;
  readonly vendorName: string;
  readonly protocol: RecognizedProtocol;
  readonly matchHost: (host: string, path: string) => boolean;
}

const VENDOR_RULES: readonly VendorRule[] = [
  {
    vendorId: "deepseek",
    vendorName: "DeepSeek",
    protocol: "openai-completions",
    matchHost: (h) => h === "api.deepseek.com" || h.endsWith(".deepseek.com"),
  },
  {
    vendorId: "openai",
    vendorName: "OpenAI",
    protocol: "openai-responses",
    matchHost: (h) => h === "api.openai.com" || h.endsWith(".openai.com"),
  },
  {
    vendorId: "anthropic",
    vendorName: "Anthropic",
    protocol: "anthropic-messages",
    matchHost: (h) => h === "api.anthropic.com" || h.endsWith(".anthropic.com"),
  },
  {
    vendorId: "openrouter",
    vendorName: "OpenRouter",
    protocol: "openai-completions",
    matchHost: (h) => h === "openrouter.ai" || h.endsWith(".openrouter.ai"),
  },
  {
    vendorId: "google",
    vendorName: "Google Gemini",
    protocol: "openai-completions",
    matchHost: (h) => h === "generativelanguage.googleapis.com",
  },
  {
    vendorId: "qwen",
    vendorName: "通义千问 Qwen",
    protocol: "openai-completions",
    matchHost: (h) => h === "dashscope.aliyuncs.com" || h === "dashscope-intl.aliyuncs.com",
  },
  {
    vendorId: "doubao",
    vendorName: "火山方舟 Doubao",
    protocol: "openai-completions",
    matchHost: (h) => h.endsWith(".volces.com") && h.startsWith("ark."),
  },
  {
    vendorId: "moonshot",
    vendorName: "Moonshot Kimi",
    protocol: "openai-completions",
    matchHost: (h) => h === "api.moonshot.cn" || h === "api.moonshot.ai",
  },
  {
    vendorId: "minimax",
    vendorName: "MiniMax",
    protocol: "openai-completions",
    matchHost: (h) => h === "api.minimaxi.com" || h === "api.minimax.chat",
  },
  {
    vendorId: "zhipu",
    vendorName: "智谱 GLM",
    protocol: "openai-completions",
    matchHost: (h) => h === "open.bigmodel.cn" || h === "api.z.ai",
  },
  {
    vendorId: "groq",
    vendorName: "Groq",
    protocol: "openai-completions",
    matchHost: (h) => h === "api.groq.com",
  },
  {
    vendorId: "xai",
    vendorName: "xAI Grok",
    protocol: "openai-completions",
    matchHost: (h) => h === "api.x.ai",
  },
  {
    vendorId: "ollama",
    vendorName: "Ollama",
    protocol: "openai-completions",
    matchHost: (h, _p) => h.startsWith("localhost:11434") || h.startsWith("127.0.0.1:11434") || h.includes("ollama"),
  },
];

export function normalizeProviderBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    const cleanedPath = url.pathname
      .replace(/\/(chat\/completions|responses|messages|models)\/?$/u, "")
      .replace(/\/+$/u, "");
    return `${url.origin}${cleanedPath}`;
  } catch {
    return trimmed.replace(/\/+$/u, "");
  }
}

export function recognizeVendorFromUrl(rawUrl: string): RecognizedVendor | null {
  const normalizedBaseUrl = normalizeProviderBaseUrl(rawUrl);
  if (!normalizedBaseUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(normalizedBaseUrl);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return null;
  const host = parsed.host.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  for (const rule of VENDOR_RULES) {
    if (rule.matchHost(host, path)) {
      return {
        vendorId: rule.vendorId,
        vendorName: rule.vendorName,
        protocol: rule.protocol,
        normalizedBaseUrl,
        matched: true,
      };
    }
  }

  const protocol: RecognizedProtocol =
    path.includes("/anthropic") || path.endsWith("/messages") ? "anthropic-messages" : "openai-completions";
  return {
    vendorId: "custom",
    vendorName: parsed.hostname,
    protocol,
    normalizedBaseUrl,
    matched: false,
  };
}

export function formatContextWindow(tokens?: number): string | undefined {
  if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return undefined;
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const k = Math.round(tokens / 1_000);
    return `${k}K`;
  }
  return String(tokens);
}
