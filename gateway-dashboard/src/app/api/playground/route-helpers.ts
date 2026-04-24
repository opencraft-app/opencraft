export interface PlaygroundImageSource {
  id: string;
  type: "base64" | "url";
  data: string;
  filename?: string;
}

export interface PlaygroundRequestPayload {
  api_key: string;
  model: string;
  message: string;
  images?: PlaygroundImageSource[];
  api_format?: "openai" | "anthropic" | "gemini";
  system_prompt?: string;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  thinking?: {
    type: "enabled";
    budget_tokens: number;
  };
}

const FORWARDED_GATEWAY_HEADERS = [
  "x-ai-gateway-original-model",
  "x-ai-gateway-resolved-model",
  "x-ai-gateway-model-fallback",
  "x-ai-gateway-fallback-reason",
];

export function buildProxyResponseHeaders(upstream: Response, contentType: string) {
  const headers = new Headers({
    "Content-Type": contentType || "application/json",
  });
  for (const headerName of FORWARDED_GATEWAY_HEADERS) {
    const value = upstream.headers.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }
  return headers;
}

export async function buildGeminiRequest(
  body: PlaygroundRequestPayload,
  gatewayApiURL: string
): Promise<{
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}> {
  const { api_key, model, message, images, stream, temperature, max_tokens, top_p, system_prompt } = body;

  const isStream = stream ?? true;
  const action = isStream ? "streamGenerateContent" : "generateContent";
  const url = new URL(`/v1beta/models/${model}:${action}`, gatewayApiURL);
  url.searchParams.set("key", api_key);

  const hasImages = images && images.length > 0;

  const parts: Array<Record<string, unknown>> = [];
  if (message) {
    parts.push({ text: message });
  }
  if (hasImages) {
    for (const img of images) {
      if (img.type === "base64") {
        const match = img.data.match(/^data:([^;]+);base64,/);
        const mimeType = match ? match[1] : "image/jpeg";
        const base64Data = img.data.replace(/^data:[^;]+;base64,/, "");
        parts.push({
          inlineData: {
            mimeType,
            data: base64Data,
          },
        });
      } else {
        throw new Error("URL images are not allowed for Gemini; upload the image as a file instead");
      }
    }
  }

  const payload: Record<string, unknown> = {
    contents: [{ parts }],
  };

  if (system_prompt) {
    payload.systemInstruction = { parts: [{ text: system_prompt }] };
  }

  const genConfig: Record<string, unknown> = {};
  if (temperature !== undefined) genConfig.temperature = temperature;
  if (max_tokens !== undefined) genConfig.maxOutputTokens = max_tokens;
  if (top_p !== undefined) genConfig.topP = top_p;
  if (Object.keys(genConfig).length > 0) {
    payload.generationConfig = genConfig;
  }

  return {
    url: url.toString(),
    headers: {
      "Content-Type": "application/json",
    },
    payload,
  };
}
