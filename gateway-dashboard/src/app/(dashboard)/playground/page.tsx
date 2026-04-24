"use client";

import { useState, useRef, useCallback, useMemo } from "react";
import {
  Send,
  Loader2,
  Eye,
  EyeOff,
  AlertCircle,
  Coins,
  ChevronDown,
  ChevronRight,
  Brain,
  Sparkles,
  Gem,
  Bot,
} from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePlans } from "@/lib/queries/use-plans";
import { useProviders } from "@/lib/queries/use-providers";
import { useModelMappings } from "@/lib/queries/use-model-mappings";
import { getPlayableModels } from "@/lib/playground-models";
import { extractPlaygroundFallbackInfo, type PlaygroundFallbackInfo } from "@/lib/playground-fallback";
import { ImageUpload, type ImageSource } from "@/components/shared/image-upload";

type ApiFormat = "openai" | "anthropic" | "gemini";

interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

function extractNextJSONObject(input: string, startAt: number) {
  const objectStart = input.indexOf("{", startAt);
  if (objectStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = objectStart; i < input.length; i++) {
    const char = input[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
      if (depth === 0) {
        return {
          json: input.slice(objectStart, i + 1),
          nextIndex: i + 1,
        };
      }
    }
  }

  return null;
}

const FORMAT_CONFIG: Record<
  ApiFormat,
  {
    label: string;
    icon: typeof Bot;
    placeholder: string;
    description: string;
    color: string;
    activeColor: string;
  }
> = {
  openai: {
    label: "OpenAI",
    icon: Bot,
    placeholder: "gpt-4o-mini",
    description: "/v1/chat/completions + Bearer auth",
    color: "text-muted-foreground",
    activeColor: "text-green-500 border-green-500 bg-green-500/10",
  },
  anthropic: {
    label: "Anthropic",
    icon: Sparkles,
    placeholder: "claude-3-opus-20240229",
    description: "/v1/messages + x-api-key auth",
    color: "text-muted-foreground",
    activeColor: "text-orange-500 border-orange-500 bg-orange-500/10",
  },
  gemini: {
    label: "Gemini",
    icon: Gem,
    placeholder: "gemini-pro",
    description: "/v1beta/models/{model} + ?key= auth",
    color: "text-muted-foreground",
    activeColor: "text-blue-500 border-blue-500 bg-blue-500/10",
  },
};

export default function PlaygroundPage() {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [message, setMessage] = useState("");
  const [images, setImages] = useState<ImageSource[]>([]);

  // 获取套餐中的模型列表
  const { data: plansData } = usePlans();
  const { data: providersData } = useProviders();
  const { data: mappingsData } = useModelMappings();
  const allModels = useMemo(() => {
    return getPlayableModels(
      plansData?.items,
      providersData?.items,
      mappingsData?.items
    );
  }, [mappingsData?.items, plansData?.items, providersData?.items]);
  const [showKey, setShowKey] = useState(false);
  const [apiFormat, setApiFormat] = useState<ApiFormat>("openai");
  const [systemPrompt, setSystemPrompt] = useState("");

  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState("");
  const [error, setError] = useState<{
    status?: number;
    message: string;
  } | null>(null);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [fallbackInfo, setFallbackInfo] = useState<PlaygroundFallbackInfo | null>(null);

  // 高级参数
  const [stream, setStream] = useState(true);
  const [temperature, setTemperature] = useState<number | undefined>(undefined);
  const [maxTokens, setMaxTokens] = useState<string>("");
  const [topP, setTopP] = useState<number | undefined>(undefined);

  // 思考模式
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [thinkingBudget, setThinkingBudget] = useState("10000");
  const [thinkingContent, setThinkingContent] = useState("");
  const [showThinking, setShowThinking] = useState(false);

  // 面板展开
  const [showAdvanced, setShowAdvanced] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  // 切换格式时更新 placeholder
  const handleFormatChange = useCallback((format: ApiFormat) => {
    setApiFormat(format);
    // 如果模型输入为空或是另一个格式的默认值，自动切换 placeholder
  }, []);

  /**
   * 解析 OpenAI 格式非流式响应
   */
  const parseOpenAINonStream = useCallback((data: Record<string, unknown>) => {
    const choices = data?.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    const msg = choice?.message as Record<string, string> | undefined;
    const text = msg?.content || JSON.stringify(data, null, 2);
    const thinking = msg?.reasoning_content;
    setResponse(text);
    if (thinking) setThinkingContent(thinking);
    if (data?.usage) {
      const u = data.usage as Record<string, number>;
      setUsage({
        prompt_tokens: u.prompt_tokens ?? 0,
        completion_tokens: u.completion_tokens ?? 0,
        total_tokens: u.total_tokens ?? 0,
      });
    }
  }, []);

  /**
   * 解析 Anthropic 格式非流式响应
   */
  const parseAnthropicNonStream = useCallback(
    (data: Record<string, unknown>) => {
      // Anthropic: { content: [{type:"text", text:"..."}], usage: {input_tokens, output_tokens} }
      const content = data?.content as
        | Array<Record<string, unknown>>
        | undefined;
      const text =
        content
          ?.filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("") || JSON.stringify(data, null, 2);
      setResponse(text);

      if (data?.usage) {
        const u = data.usage as Record<string, number>;
        setUsage({
          prompt_tokens: u.input_tokens ?? 0,
          completion_tokens: u.output_tokens ?? 0,
          total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
        });
      }
    },
    []
  );

  /**
   * 解析 Gemini 格式非流式响应
   */
  const parseGeminiNonStream = useCallback((data: Record<string, unknown>) => {
    // Gemini: { candidates: [{content:{parts:[{text}]}}], usageMetadata: {...} }
    const candidates = data?.candidates as
      | Array<Record<string, unknown>>
      | undefined;
    const candidate = candidates?.[0];
    const content = candidate?.content as Record<string, unknown> | undefined;
    const parts = content?.parts as Array<Record<string, string>> | undefined;
    const text = parts?.map((p) => p.text).join("") || JSON.stringify(data, null, 2);
    setResponse(text);

    if (data?.usageMetadata) {
      const u = data.usageMetadata as Record<string, number>;
      setUsage({
        prompt_tokens: u.promptTokenCount ?? 0,
        completion_tokens: u.candidatesTokenCount ?? 0,
        total_tokens: u.totalTokenCount ?? 0,
      });
    }
  }, []);

  /**
   * 解析 OpenAI SSE 流式数据
   */
  const parseOpenAIStreamLine = useCallback((data: string) => {
    if (data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data);
      const delta = parsed?.choices?.[0]?.delta;
      if (delta?.content) {
        setResponse((prev) => prev + delta.content);
      }
      if (delta?.reasoning_content) {
        setThinkingContent((prev) => prev + delta.reasoning_content);
      }
      if (parsed?.usage) {
        setUsage(parsed.usage);
      }
    } catch {
      // 忽略无法解析的行
    }
  }, []);

  /**
   * 解析 Anthropic SSE 流式数据
   * Anthropic SSE 格式: event: xxx\ndata: {...}\n\n
   */
  const parseAnthropicStream = useCallback(
    async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
      const decoder = new TextDecoder();
      let buffer = "";
      let inputTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // 解析 data: 行
          if (trimmed.startsWith("data: ")) {
            const data = trimmed.slice(6);
            try {
              const parsed = JSON.parse(data);

              switch (parsed.type) {
                case "message_start": {
                  // 提取 input_tokens
                  const msg = parsed.message;
                  if (msg?.usage?.input_tokens) {
                    inputTokens = msg.usage.input_tokens;
                  }
                  break;
                }
                case "content_block_delta": {
                  // 追加文本
                  const delta = parsed.delta;
                  if (delta?.type === "text_delta" && delta.text) {
                    setResponse((prev) => prev + delta.text);
                  }
                  break;
                }
                case "message_delta": {
                  // 更新用量 - message_delta 的 usage 包含完整的 input_tokens 和 output_tokens
                  const deltaUsage = parsed.usage;
                  if (deltaUsage?.input_tokens !== undefined) {
                    inputTokens = deltaUsage.input_tokens;
                  }
                  const outputTokens = deltaUsage?.output_tokens ?? 0;
                  setUsage({
                    prompt_tokens: inputTokens,
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens,
                  });
                  break;
                }
                // message_stop, content_block_start, content_block_stop — 无需处理
              }
            } catch {
              // 忽略无法解析的行
            }
          }
        }
      }
    },
    []
  );

  /**
   * 解析 Gemini 流式数据（JSON 数组格式 [{...},{...}]）
   */
  const parseGeminiStream = useCallback(
    async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
      const decoder = new TextDecoder();
      let buffer = "";
      let lastUsage: TokenUsage | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Gemini 流式返回 JSON 数组，尝试增量解析
        // 格式: [\n{chunk1},\n{chunk2},\n...\n]
        // 逐个提取完整的 JSON 对象
        let searchStart = 0;
        while (searchStart < buffer.length) {
          const extracted = extractNextJSONObject(buffer, searchStart);
          if (!extracted) break;

          const jsonStr = extracted.json;
          searchStart = extracted.nextIndex;

          try {
            const chunk = JSON.parse(jsonStr);
            // 提取文本
            const text =
              chunk?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
            if (text) {
              setResponse((prev) => prev + text);
            }
            // 提取用量
            if (chunk?.usageMetadata) {
              const u = chunk.usageMetadata;
              lastUsage = {
                prompt_tokens: u.promptTokenCount ?? 0,
                completion_tokens: u.candidatesTokenCount ?? 0,
                total_tokens: u.totalTokenCount ?? 0,
              };
            }
          } catch {
            // 忽略解析错误
          }
        }

        // 移除已处理的部分
        if (searchStart > 0) {
          buffer = buffer.slice(searchStart);
        }
      }

      if (lastUsage) {
        setUsage(lastUsage);
      }
    },
    []
  );

  const handleSend = useCallback(async () => {
    if (!apiKey || !model) return;
    if (!message && images.length === 0) return;

    // 重置状态
    setLoading(true);
    setResponse("");
    setError(null);
    setUsage(null);
    setFallbackInfo(null);
    setThinkingContent("");
    setShowThinking(false);

    abortRef.current = new AbortController();

    try {
      const maxTokensNum = maxTokens ? parseInt(maxTokens, 10) : undefined;
      const budgetNum = parseInt(thinkingBudget, 10) || 10000;

      const res = await fetch("/api/playground", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          api_format: apiFormat,
          model,
          message,
          images: images.length > 0 ? images : undefined,
          stream,
          ...(systemPrompt && { system_prompt: systemPrompt }),
          ...(temperature !== undefined && { temperature }),
          ...(maxTokensNum !== undefined &&
            !isNaN(maxTokensNum) && { max_tokens: maxTokensNum }),
          ...(topP !== undefined && { top_p: topP }),
          ...(thinkingEnabled && {
            thinking: { type: "enabled", budget_tokens: budgetNum },
          }),
        }),
        signal: abortRef.current.signal,
      });
      setFallbackInfo(extractPlaygroundFallbackInfo(res.headers));

      // 非流式错误响应
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const errMsg =
          data?.error?.message || data?.error || data?.message || `请求失败`;
        setError({ status: res.status, message: errMsg });
        setLoading(false);
        return;
      }

      const contentType = res.headers.get("content-type") || "";
      const isStreamResponse = contentType.includes("text/event-stream") ||
        (apiFormat === "gemini" && stream !== false && contentType.includes("application/json") && res.body);

      // 非流式成功响应
      if (!isStreamResponse) {
        const data = await res.json();
        switch (apiFormat) {
          case "anthropic":
            parseAnthropicNonStream(data);
            break;
          case "gemini":
            parseGeminiNonStream(data);
            break;
          default:
            parseOpenAINonStream(data);
            break;
        }
        setLoading(false);
        return;
      }

      // 流式解析
      const reader = res.body?.getReader();
      if (!reader) {
        setError({ message: "无法读取响应流" });
        setLoading(false);
        return;
      }

      if (apiFormat === "anthropic") {
        // Anthropic SSE 流（event: xxx + data: xxx 格式）
        await parseAnthropicStream(reader);
      } else if (apiFormat === "gemini") {
        // Gemini JSON 数组流
        await parseGeminiStream(reader);
      } else {
        // OpenAI SSE 流
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            parseOpenAIStreamLine(trimmed.slice(6));
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // 用户取消，不显示错误
      } else {
        setError({ message: String(err) });
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [
    apiKey,
    apiFormat,
    model,
    message,
    images,
    stream,
    systemPrompt,
    temperature,
    maxTokens,
    topP,
    thinkingEnabled,
    thinkingBudget,
    parseOpenAINonStream,
    parseAnthropicNonStream,
    parseGeminiNonStream,
    parseOpenAIStreamLine,
    parseAnthropicStream,
    parseGeminiStream,
  ]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const canSend = apiKey.trim() && model.trim() && (message.trim() || images.length > 0) && !loading;
  const formatConfig = FORMAT_CONFIG[apiFormat];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Playground"
        description="测试 API Key 是否能正常调用 AI 模型（支持 OpenAI / Anthropic / Gemini 格式）"
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 左侧：配置区 */}
        <Card>
          <CardHeader>
            <CardTitle>请求配置</CardTitle>
            <CardDescription>
              选择 API 格式，输入 API Key、模型名称和消息内容
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* API 格式选择器 */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                API 格式
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(Object.keys(FORMAT_CONFIG) as ApiFormat[]).map((format) => {
                  const config = FORMAT_CONFIG[format];
                  const Icon = config.icon;
                  const isActive = apiFormat === format;
                  return (
                    <button
                      key={format}
                      type="button"
                      onClick={() => handleFormatChange(format)}
                      className={`flex flex-col items-center gap-1.5 px-3 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                        isActive
                          ? config.activeColor
                          : "border-border text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      <span>{config.label}</span>
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                {formatConfig.description}
              </p>
            </div>

            {/* API Key */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                API Key
              </label>
              <div className="relative">
                <Input
                  type={showKey ? "text" : "password"}
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            {/* 模型 */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                模型名称
              </label>
              <Select value={model} onValueChange={(v) => v && setModel(v)}>
                <SelectTrigger>
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent>
                  {allModels.length > 0 ? (
                    allModels.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="" disabled>
                      暂无可用模型
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* System Prompt（所有格式都可用） */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                System Prompt{" "}
                <span className="text-muted-foreground font-normal">
                  （可选）
                </span>
              </label>
              <Textarea
                placeholder="输入系统提示词..."
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={2}
              />
            </div>

            {/* 消息 */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                消息内容
              </label>
              <Textarea
                placeholder="输入你的消息..."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={5}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSend) {
                    handleSend();
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                按 Ctrl+Enter / ⌘+Enter 发送
              </p>
            </div>

            {/* 图片上传（多模态 Vision） */}
            {apiFormat === "openai" && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">
                  图片{" "}
                  <span className="text-muted-foreground font-normal">
                    （可选，GPT-4o 等多模态模型支持）
                  </span>
                </label>
                <ImageUpload
                  images={images}
                  onChange={setImages}
                  maxImages={20}
                />
              </div>
            )}
            {apiFormat === "gemini" && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">
                  图片{" "}
                  <span className="text-muted-foreground font-normal">
                    （可选，Gemini 多模态模型支持）
                  </span>
                </label>
                <ImageUpload
                  images={images}
                  onChange={setImages}
                  maxImages={20}
                />
              </div>
            )}

            {/* Anthropic 图片上传 */}
            {apiFormat === "anthropic" && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">
                  图片{" "}
                  <span className="text-muted-foreground font-normal">
                    （可选，Claude 3.5 Sonnet 等多模态模型支持）
                  </span>
                </label>
                <ImageUpload
                  images={images}
                  onChange={setImages}
                  maxImages={20}
                />
              </div>
            )}

            {/* 高级参数折叠面板 */}
            <div className="border rounded-lg">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-2 w-full px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted/50 transition-colors rounded-lg"
              >
                {showAdvanced ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
                高级参数
                {(temperature !== undefined ||
                  maxTokens ||
                  topP !== undefined ||
                  !stream ||
                  thinkingEnabled) && (
                  <Badge variant="secondary" className="ml-auto text-xs">
                    已配置
                  </Badge>
                )}
              </button>

              {showAdvanced && (
                <div className="px-4 pb-4 space-y-4 border-t pt-4">
                  {/* Stream 开关 */}
                  <div className="flex items-center justify-between">
                    <Label
                      htmlFor="stream-toggle"
                      className="text-sm font-normal"
                    >
                      Stream 流式响应
                    </Label>
                    <Switch
                      id="stream-toggle"
                      checked={stream}
                      onCheckedChange={setStream}
                    />
                  </div>

                  {/* Temperature */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-normal">Temperature</Label>
                      <span className="text-xs text-muted-foreground font-mono">
                        {temperature !== undefined ? temperature.toFixed(1) : "默认"}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <Slider
                        value={[temperature ?? 0.7]}
                        onValueChange={(v) =>
                          setTemperature(Array.isArray(v) ? v[0] : v)
                        }
                        min={0}
                        max={2}
                        step={0.1}
                        className="flex-1"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => setTemperature(undefined)}
                      >
                        重置
                      </Button>
                    </div>
                  </div>

                  {/* Max Tokens */}
                  <div className="space-y-1.5">
                    <Label className="text-sm font-normal">Max Tokens</Label>
                    <Input
                      type="number"
                      placeholder={apiFormat === "anthropic" ? "4096（默认）" : "不限制"}
                      value={maxTokens}
                      onChange={(e) => setMaxTokens(e.target.value)}
                      min={1}
                      max={1000000}
                    />
                  </div>

                  {/* Top P */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-normal">Top P</Label>
                      <span className="text-xs text-muted-foreground font-mono">
                        {topP !== undefined ? topP.toFixed(2) : "默认"}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <Slider
                        value={[topP ?? 1.0]}
                        onValueChange={(v) =>
                          setTopP(Array.isArray(v) ? v[0] : v)
                        }
                        min={0}
                        max={1}
                        step={0.05}
                        className="flex-1"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => setTopP(undefined)}
                      >
                        重置
                      </Button>
                    </div>
                  </div>

                  {/* 思考模式分隔线 */}
                  <div className="relative py-2">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t" />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase">
                      <span className="bg-card px-2 text-muted-foreground flex items-center gap-1">
                        <Brain className="h-3 w-3" />
                        思考模式
                      </span>
                    </div>
                  </div>

                  {/* Thinking 开关 */}
                  <div className="flex items-center justify-between">
                    <div>
                      <Label
                        htmlFor="thinking-toggle"
                        className="text-sm font-normal"
                      >
                        启用 Thinking
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        仅 Claude 模型支持
                      </p>
                    </div>
                    <Switch
                      id="thinking-toggle"
                      checked={thinkingEnabled}
                      onCheckedChange={setThinkingEnabled}
                    />
                  </div>

                  {/* Budget Tokens（仅 thinking 开启时显示） */}
                  {thinkingEnabled && (
                    <div className="space-y-1.5">
                      <Label className="text-sm font-normal">
                        Budget Tokens
                      </Label>
                      <Input
                        type="number"
                        placeholder="10000"
                        value={thinkingBudget}
                        onChange={(e) => setThinkingBudget(e.target.value)}
                        min={1024}
                        max={100000}
                      />
                      <p className="text-xs text-muted-foreground">
                        思考过程的最大 token 数量
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 按钮 */}
            <div className="flex gap-2">
              <Button
                onClick={handleSend}
                disabled={!canSend}
                className="flex-1"
              >
                {loading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-2 h-4 w-4" />
                )}
                {loading ? "请求中..." : "发送"}
              </Button>
              {loading && (
                <Button variant="outline" onClick={handleStop}>
                  停止
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* 右侧：响应区 */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>响应结果</CardTitle>
                <CardDescription>
                  {loading
                    ? "正在接收响应..."
                    : response
                      ? "请求完成"
                      : "发送请求后查看结果"}
                </CardDescription>
              </div>
              {response && (
                <Badge variant="outline" className="text-xs">
                  {FORMAT_CONFIG[apiFormat].label} 格式
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* 错误信息 */}
            {error && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                  <div className="space-y-1">
                    {error.status && (
                      <Badge variant="destructive">HTTP {error.status}</Badge>
                    )}
                    <p className="text-sm text-destructive">{error.message}</p>
                  </div>
                </div>
              </div>
            )}

            {fallbackInfo?.fallbackApplied && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
                <p className="text-sm text-amber-900 dark:text-amber-100">
                  请求模型不可用，已自动降级到 <strong>{fallbackInfo.resolvedModel}</strong>
                  {fallbackInfo.originalModel !== fallbackInfo.resolvedModel && (
                    <span>（原始模型：{fallbackInfo.originalModel}）</span>
                  )}
                </p>
              </div>
            )}

            {/* 思考过程（折叠展示） */}
            {thinkingContent && (
              <div className="rounded-lg border border-blue-500/30 bg-blue-500/5">
                <button
                  type="button"
                  onClick={() => setShowThinking(!showThinking)}
                  className="flex items-center gap-2 w-full px-4 py-2.5 text-sm font-medium text-blue-400 hover:bg-blue-500/10 transition-colors rounded-lg"
                >
                  {showThinking ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                  <Brain className="h-4 w-4" />
                  思考过程
                  {loading && (
                    <Loader2 className="h-3 w-3 animate-spin ml-1" />
                  )}
                </button>
                {showThinking && (
                  <div className="px-4 pb-3 border-t border-blue-500/20">
                    <pre className="whitespace-pre-wrap text-sm leading-relaxed break-words font-sans text-muted-foreground pt-3">
                      {thinkingContent}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* 响应文本 */}
            {response && (
              <div className="rounded-lg border bg-muted/50 p-4">
                <pre className="whitespace-pre-wrap text-sm leading-relaxed break-words font-sans">
                  {response}
                </pre>
              </div>
            )}

            {/* 空状态 */}
            {!error && !response && !loading && !thinkingContent && (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Send className="h-8 w-8 mb-3 opacity-50" />
                <p className="text-sm">在左侧配置请求参数后点击发送</p>
              </div>
            )}

            {/* Loading 占位 */}
            {loading && !response && !thinkingContent && (
              <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">等待响应...</span>
              </div>
            )}

            {/* Token 用量（参考值） */}
            {usage && (
              <div className="rounded-lg border bg-muted/30 p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Coins className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Token 用量</span>
                  </div>
                  <Badge variant="outline" className="text-xs text-muted-foreground">
                    参考值
                  </Badge>
                </div>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div>
                    <p className="text-xs text-muted-foreground">输入</p>
                    <p className="text-sm font-mono font-medium">
                      {usage.prompt_tokens.toLocaleString()}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">输出</p>
                    <p className="text-sm font-mono font-medium">
                      {usage.completion_tokens.toLocaleString()}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">总计</p>
                    <p className="text-sm font-mono font-medium">
                      {usage.total_tokens.toLocaleString()}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
