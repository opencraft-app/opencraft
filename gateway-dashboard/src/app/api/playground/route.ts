import { NextRequest, NextResponse } from "next/server.js";
import {
  buildProxyResponseHeaders,
  buildGeminiRequest,
  type PlaygroundRequestPayload as PlaygroundRequest,
} from "./route-helpers";

const GATEWAY_API_URL = process.env.GATEWAY_API_URL;
type ApiFormat = "openai" | "anthropic" | "gemini";

/**
 * 构建 OpenAI 格式请求（支持多模态图片）
 */
function buildOpenAIRequest(body: PlaygroundRequest): {
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
} {
  const { api_key, model, message, images, stream, temperature, max_tokens, top_p, thinking, system_prompt } = body;

  const hasImages = images && images.length > 0;

  // 构建 messages
  const messages: Array<Record<string, unknown>> = [];
  if (system_prompt) {
    // system prompt 始终为纯文本
    messages.push({ role: "system", content: system_prompt });
  }

  // user message：有无图片都构建 content 字段
  if (hasImages) {
    // 多模态：content 为 block 数组
    const content: Array<Record<string, unknown>> = [];
    if (message) {
      content.push({ type: "text", text: message });
    }
    for (const img of images) {
      if (img.type === "url") {
        content.push({
          type: "image_url",
          image_url: { url: img.data, detail: "auto" },
        });
      } else {
        // base64
        content.push({
          type: "image_url",
          image_url: { url: img.data, detail: "auto" },
        });
      }
    }
    messages.push({ role: "user", content });
  } else {
    // 纯文本
    messages.push({ role: "user", content: message });
  }

  const payload: Record<string, unknown> = {
    model,
    messages,
    stream: stream ?? true,
  };
  if (temperature !== undefined) payload.temperature = temperature;
  if (max_tokens !== undefined) payload.max_tokens = max_tokens;
  if (top_p !== undefined) payload.top_p = top_p;
  if (thinking) payload.thinking = thinking;

  return {
    url: new URL("/v1/chat/completions", GATEWAY_API_URL).toString(),
    headers: {
      Authorization: `Bearer ${api_key}`,
      "Content-Type": "application/json",
    },
    payload,
  };
}

/**
 * 构建 Anthropic Messages 格式请求（支持多模态图片）
 */
function buildAnthropicRequest(body: PlaygroundRequest): {
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
} {
  const { api_key, model, message, images, stream, temperature, max_tokens, top_p, system_prompt, thinking } = body;

  const hasImages = images && images.length > 0;

  // 构建 content 字段
  let content: string | Array<Record<string, unknown>>;
  if (hasImages) {
    // 多模态：content 为 block 数组
    content = [];
    if (message) {
      content.push({ type: "text", text: message });
    }
    for (const img of images) {
      if (img.type === "base64") {
        // data:image/jpeg;base64,xxxxx → image/jpeg + base64 data
        const match = img.data.match(/^data:([^;]+);base64,/);
        const mediaType = match ? match[1] : "image/jpeg";
        const base64Data = img.data.replace(/^data:[^;]+;base64,/, "");
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: base64Data,
          },
        });
      } else {
        // Anthropic 支持 URL 类型的图片 source
        content.push({
          type: "image",
          source: {
            type: "url",
            url: img.data,
          },
        });
      }
    }
  } else {
    content = message;
  }

  const payload: Record<string, unknown> = {
    model,
    max_tokens: max_tokens ?? 4096,
    messages: [{ role: "user", content }],
    stream: stream ?? true,
  };
  if (system_prompt) payload.system = system_prompt;
  if (temperature !== undefined) payload.temperature = temperature;
  if (top_p !== undefined) payload.top_p = top_p;
  if (thinking) payload.thinking = thinking;

  return {
    url: new URL("/v1/messages", GATEWAY_API_URL).toString(),
    headers: {
      "x-api-key": api_key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    payload,
  };
}

export async function POST(req: NextRequest) {
  if (!GATEWAY_API_URL) {
    return NextResponse.json(
      { error: "GATEWAY_API_URL is not configured" },
      { status: 500 }
    );
  }

  let body: PlaygroundRequest;

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }

  const { api_key, model, message, images } = body;

  if (!api_key || !model) {
    return NextResponse.json(
      { error: "Missing required fields: api_key, model" },
      { status: 400 }
    );
  }

  // 至少要有 message 或 images 其中之一
  if (!message && (!images || images.length === 0)) {
    return NextResponse.json(
      { error: "Missing required field: message or images" },
      { status: 400 }
    );
  }

  const apiFormat: ApiFormat = body.api_format || "openai";

  // 根据 API 格式构建不同的请求
  let requestConfig: { url: string; headers: Record<string, string>; payload: Record<string, unknown> };
  try {
      switch (apiFormat) {
        case "anthropic":
          requestConfig = buildAnthropicRequest(body);
          break;
        case "gemini":
          requestConfig = await buildGeminiRequest(body, GATEWAY_API_URL);
          break;
      default:
        requestConfig = buildOpenAIRequest(body);
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid playground request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const upstream = await fetch(requestConfig.url, {
      method: "POST",
      headers: requestConfig.headers,
      body: JSON.stringify(requestConfig.payload),
    });

    // 非 2xx 响应，返回错误信息
    if (!upstream.ok) {
      const errorText = await upstream.text();
      let errorData;
      try {
        errorData = errorText ? JSON.parse(errorText) : { error: `Gateway error (${upstream.status})` };
      } catch {
        errorData = { error: errorText || `Gateway error (${upstream.status})` };
      }
      return NextResponse.json(errorData, { status: upstream.status });
    }

    const contentType = upstream.headers.get("content-type") || "";

    // 检查是否为流式响应（SSE 或 Gemini JSON 数组流式）
    const isStreamResponse =
      contentType.includes("text/event-stream") ||
      (apiFormat === "gemini" && body.stream !== false && upstream.body);

    if (!isStreamResponse || !upstream.body) {
      // 非流式响应，直接返回
      const data = await upstream.text();
      return new NextResponse(data, {
        status: upstream.status,
        headers: buildProxyResponseHeaders(upstream, contentType),
      });
    }

    // 流式转发：将上游流 pipe 给客户端
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const reader = upstream.body.getReader();

    // 后台持续读取上游并写入客户端
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      } catch (err) {
        console.error("Stream pipe error:", err);
      } finally {
        await writer.close();
      }
    })();

    // 根据格式设置合适的 Content-Type
    let streamContentType = "text/event-stream";
    if (apiFormat === "gemini") {
      streamContentType = contentType || "application/json";
    } else if (apiFormat === "anthropic") {
      streamContentType = "text/event-stream";
    }

    return new NextResponse(readable, {
      status: 200,
      headers: (() => {
        const headers = buildProxyResponseHeaders(upstream, streamContentType);
        headers.set("Cache-Control", "no-cache");
        headers.set("Connection", "keep-alive");
        return headers;
      })(),
    });
  } catch (error) {
    console.error("Playground proxy error:", error);
    return NextResponse.json(
      { error: "Gateway backend is unreachable" },
      { status: 502 }
    );
  }
}
