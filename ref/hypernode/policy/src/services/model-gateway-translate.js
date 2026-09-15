function responseKey(tool) {
  return `${tool.namespace ?? ""}\0${tool.name ?? ""}\0${tool.kind ?? "function"}`;
}

// This is a user-facing compatibility boundary, not a malformed request.
// Codex subscription rollouts can contain provider-owned encrypted compaction
// state. A Chat Completions provider cannot decrypt or faithfully replay it,
// so fail closed with an actionable explanation instead of exposing the
// internal Responses item name.
export const OPAQUE_CODEX_HISTORY_MESSAGE =
  "由于 Codex 原生历史包含加密压缩内容，已无法无损切换到其他模型。请切回原 Codex 模型继续，或新建会话使用该模型。";

export class OpaqueCodexHistoryError extends Error {
  constructor() {
    super(OPAQUE_CODEX_HISTORY_MESSAGE);
    this.name = "OpaqueCodexHistoryError";
  }
}

function sanitizeToolName(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
}

// Responses accepts a wider range of historical call ids than several
// Chat-compatible gateways do when they reconstruct Responses items. Keep a
// deterministic request-local spelling so an assistant tool call and its
// later tool output always retain the same relationship.
function chatToolCallId(value) {
  const original = String(value ?? "");
  if (/^[A-Za-z0-9_-]+$/.test(original) && original.length <= 64) return original;
  let hash = 0x811c9dc5;
  for (let index = 0; index < original.length; index += 1) {
    hash ^= original.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const hint = original.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 44) || "call";
  return `hn_${hint}_${hash.toString(16).padStart(8, "0")}`;
}

export class ToolCodec {
  constructor() {
    this.byChatName = new Map();
    this.byResponse = new Map();
  }

  register(tool) {
    const key = responseKey(tool);
    const existing = this.byResponse.get(key);
    if (existing) return existing;
    let base = tool.namespace && tool.namespace !== "functions"
      ? `${tool.namespace}__${tool.name}`
      : tool.name;
    base = sanitizeToolName(base) || "hypernode_tool";
    if (base.length > 55) base = `${base.slice(0, 55)}_${crypto.sha256(key).slice(0, 8)}`;
    let name = base;
    for (let suffix = 2; this.byChatName.has(name) && responseKey(this.byChatName.get(name)) !== key; suffix += 1) {
      name = `${base}_${suffix}`;
    }
    const detached = { name: tool.name, namespace: tool.namespace ?? "", kind: tool.kind ?? "function" };
    this.byChatName.set(name, detached);
    this.byResponse.set(key, name);
    return name;
  }

  chatName(tool) {
    return this.byResponse.get(responseKey(tool)) ?? this.register(tool);
  }
}

function responseToolToChat(value, namespace, codec) {
  if (!value || typeof value !== "object") return [];
  const type = value.type;
  if (type === "namespace") {
    return (Array.isArray(value.tools) ? value.tools : [])
      .flatMap((child) => responseToolToChat(child, String(value.name ?? ""), codec));
  }
  if (type === "tool_search" || type === "web_search") return [];
  if (type !== "function" && type !== "custom") {
    throw new Error(`unsupported Responses tool type ${JSON.stringify(type)}`);
  }
  const name = String(value.name ?? "");
  if (!name) throw new Error(`Responses ${type} tool has no name`);
  const chatName = codec.register({ name, namespace, kind: type });
  const parameters = type === "custom" ? {
    type: "object",
    properties: { input: { type: "string", description: "Raw input for the custom tool." } },
    required: ["input"],
    additionalProperties: false,
  } : value.parameters;
  let description = String(value.description ?? "");
  if (namespace && namespace !== "functions") description = `[${namespace}.${name}] ${description}`;
  return [{ type: "function", function: { name: chatName, description, parameters } }];
}

function responseToolsToChat(input, codec) {
  const output = [];
  const seen = new Set();
  const append = (specs) => {
    for (const raw of Array.isArray(specs) ? specs : []) {
      for (const item of responseToolToChat(raw, "", codec)) {
        const name = item?.function?.name;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        output.push(item);
      }
    }
  };
  append(input.tools);
  for (const item of Array.isArray(input.input) ? input.input : []) {
    if (item?.type === "additional_tools") append(item.tools);
  }
  return output;
}

export const TEXT_ONLY_IMAGE_PLACEHOLDER =
  "[Historical image omitted: the selected model accepts text only.]";

function responseContent(value, options = {}) {
  const supportsImages = options.supportsImages !== false;
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    if (["input_text", "output_text", "text"].includes(part.type)) {
      return [{ type: "text", text: part.text }];
    }
    if (part.type === "input_image") {
      if (!supportsImages) {
        return [{ type: "text", text: TEXT_ONLY_IMAGE_PLACEHOLDER }];
      }
      return [{ type: "image_url", image_url: { url: part.image_url } }];
    }
    throw new Error(`unsupported Responses content type ${JSON.stringify(part.type)}`);
  });
}

function chatToolOutput(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  const parts = Array.isArray(value) ? value : [value];
  return parts.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return String(part ?? "");
    if (["input_text", "output_text", "text"].includes(part.type) && typeof part.text === "string") {
      return part.text;
    }
    if (part.type === "input_image" && typeof part.image_url === "string") {
      return `[image: ${part.image_url}]`;
    }
    try {
      return JSON.stringify(part);
    } catch {
      return String(part);
    }
  }).filter(Boolean).join("\n");
}

function responseReasoningText(item) {
  const content = Array.isArray(item?.content)
    ? item.content.map((part) => typeof part?.text === "string" ? part.text : "").filter(Boolean)
    : [];
  if (content.length > 0) return content.join("\n\n");
  const summary = Array.isArray(item?.summary)
    ? item.summary.map((part) => typeof part?.text === "string" ? part.text : "").filter(Boolean)
    : [];
  return summary.join("\n\n");
}

function responseReasoningItem(id, text, status = "completed") {
  return {
    id,
    type: "reasoning",
    status,
    summary: [],
    content: text ? [{ type: "reasoning_text", text }] : [],
    encrypted_content: null,
  };
}

function responseInputToMessages(value, codec, options = {}) {
  if (typeof value === "string") return [{ role: "user", content: value }];
  if (value != null && !Array.isArray(value)) throw new Error("unsupported Responses input");
  const messages = [];
  let pendingReasoning = "";
  const attachReasoning = (message) => {
    if (!pendingReasoning || message.role !== "assistant") return message;
    const output = { ...message, reasoning_content: pendingReasoning };
    pendingReasoning = "";
    return output;
  };
  for (const item of value ?? []) {
    if (!item || typeof item !== "object") continue;
    switch (item.type ?? "") {
      case "additional_tools":
        break;
      case "reasoning": {
        const text = responseReasoningText(item);
        if (text) pendingReasoning += `${pendingReasoning ? "\n\n" : ""}${text}`;
        break;
      }
      case "compaction":
        // OpenAI remote compaction is encrypted provider state. Silently
        // dropping it would turn a provider switch into hidden context loss.
        throw new OpaqueCodexHistoryError();
      case "message":
      case "":
        messages.push(attachReasoning({
          role: item.role === "developer" ? "system" : item.role,
          content: responseContent(item.content, options),
        }));
        break;
      case "function_call": {
        const name = codec.chatName({
          name: String(item.name ?? ""), namespace: String(item.namespace ?? ""), kind: "function",
        });
        messages.push(attachReasoning({ role: "assistant", tool_calls: [{
          id: chatToolCallId(item.call_id), type: "function", function: { name, arguments: item.arguments },
        }] }));
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output":
        messages.push({
          role: "tool",
          tool_call_id: chatToolCallId(item.call_id),
          content: chatToolOutput(item.output),
        });
        break;
      case "custom_tool_call": {
        const name = codec.chatName({
          name: String(item.name ?? ""), namespace: String(item.namespace ?? ""), kind: "custom",
        });
        messages.push(attachReasoning({ role: "assistant", tool_calls: [{
          id: chatToolCallId(item.call_id), type: "function",
          function: { name, arguments: JSON.stringify({ input: item.input }) },
        }] }));
        break;
      }
      default:
        throw new Error(`unsupported Responses input item type ${JSON.stringify(item.type)}`);
    }
  }
  return messages;
}

const INTERRUPTED_TOOL_OUTPUT =
  "Tool execution was interrupted before HyperNode recorded a result. Do not assume that it succeeded.";

function completeToolTranscript(messages) {
  const output = [];
  let pending = null;
  let repairs = 0;
  const flushMissing = () => {
    if (!pending) return;
    for (const callId of pending.callIds) {
      output.push({ role: "tool", tool_call_id: callId, content: INTERRUPTED_TOOL_OUTPUT });
      repairs += 1;
    }
    pending = null;
  };

  for (const message of messages) {
    const calls = message.role === "assistant" && Array.isArray(message.tool_calls)
      ? message.tool_calls.filter((call) => typeof call?.id === "string" && call.id)
      : [];
    if (calls.length > 0) {
      // Responses represents parallel calls as adjacent items, whereas Chat
      // Completions requires one assistant message followed by all matching
      // tool results. Coalesce that run before validating its outputs.
      if (pending && !pending.sawTool) {
        output[pending.assistantIndex].tool_calls.push(...calls);
        for (const call of calls) pending.callIds.add(call.id);
        continue;
      }
      flushMissing();
      output.push({ ...message, tool_calls: [...calls] });
      pending = {
        assistantIndex: output.length - 1,
        callIds: new Set(calls.map((call) => call.id)),
        sawTool: false,
      };
      continue;
    }
    if (message.role === "tool") {
      if (pending?.callIds.has(message.tool_call_id)) {
        output.push(message);
        pending.callIds.delete(message.tool_call_id);
        pending.sawTool = true;
        if (pending.callIds.size === 0) pending = null;
      } else {
        // An orphaned result is equally invalid in Chat Completions. It has no
        // safe call to attach to, so omit it rather than corrupting the turn.
        repairs += 1;
      }
      continue;
    }
    flushMissing();
    output.push(message);
  }
  flushMissing();
  return { messages: output, repairs };
}

export function responsesToChat(value, options = {}) {
  const input = typeof value === "string" ? JSON.parse(value) : value;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid JSON body");
  const codec = new ToolCodec();
  const output = {};
  for (const key of ["model", "temperature", "top_p", "parallel_tool_calls", "tool_choice", "user"]) {
    if (Object.prototype.hasOwnProperty.call(input, key)) output[key] = input[key];
  }
  const stream = input.stream === true;
  output.stream = stream;
  if (stream) output.stream_options = { include_usage: true };
  if (Object.prototype.hasOwnProperty.call(input, "max_output_tokens")) {
    output.max_completion_tokens = input.max_output_tokens;
  }
  const messages = [];
  if (typeof input.instructions === "string" && input.instructions) {
    messages.push({ role: "system", content: input.instructions });
  }
  messages.push(...responseInputToMessages(input.input, codec, options));
  const transcript = completeToolTranscript(messages);
  output.messages = transcript.messages;
  const tools = responseToolsToChat(input, codec);
  if (tools.length) output.tools = tools;
  return { body: JSON.stringify(output), stream, codec, toolTranscriptRepairs: transcript.repairs };
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function translateUsage(value) {
  if (!value || typeof value !== "object") return null;
  const input = number(value.prompt_tokens);
  const output = number(value.completion_tokens);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: number(value.prompt_tokens_details?.cached_tokens) },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: number(value.completion_tokens_details?.reasoning_tokens) },
    total_tokens: number(value.total_tokens) || input + output,
  };
}

function customToolInput(argumentsText) {
  try {
    const decoded = JSON.parse(argumentsText);
    if (typeof decoded?.input === "string") return decoded.input;
  } catch {}
  return argumentsText;
}

function responseToolCall(codec, id, chatName, argumentsText, status) {
  const tool = codec.byChatName.get(chatName) ?? { name: chatName, namespace: "", kind: "function" };
  const item = { id, status, call_id: id, name: tool.name };
  if (tool.namespace) item.namespace = tool.namespace;
  if (tool.kind === "custom") {
    item.type = "custom_tool_call";
    item.input = customToolInput(argumentsText);
  } else {
    item.type = "function_call";
    item.arguments = argumentsText;
  }
  return item;
}

let generatedId = 0;
function newAccumulator() {
  return {
    id: "", model: "", created: Math.floor(Date.now() / 1000), text: "", textAnnounced: false,
    reasoning: "", reasoningAnnounced: false, tools: new Map(), usage: null,
    finishReason: null, endTurn: null, terminalStatus: null,
  };
}

function responseId(acc) {
  if (acc.id.startsWith("resp_")) return acc.id;
  if (acc.id) return `resp_${acc.id}`;
  generatedId += 1;
  return `resp_hypernode_${Date.now().toString(36)}_${generatedId.toString(36)}`;
}

function responseEnvelope(acc, status, output, details = {}) {
  const envelope = {
    id: responseId(acc), object: "response", created_at: acc.created, status,
    model: acc.model, output, error: null,
    incomplete_details: details.incompleteReason ? { reason: details.incompleteReason } : null,
    usage: acc.usage,
  };
  if (typeof details.endTurn === "boolean") envelope.end_turn = details.endTurn;
  return envelope;
}

function sse(event, value) {
  return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
}

function terminalDecision(acc) {
  const tools = [...acc.tools.values()];
  if (tools.length > 0) return { status: "completed", endTurn: false };
  if (acc.finishReason === "length") {
    return { status: "incomplete", incompleteReason: "max_output_tokens" };
  }
  if (acc.finishReason === "content_filter") {
    return { status: "incomplete", incompleteReason: "content_filter" };
  }
  if (acc.finishReason === "stop") return { status: "completed", endTurn: true };
  if (acc.finishReason && !["tool_calls", "function_call"].includes(acc.finishReason)) {
    return { status: "incomplete", incompleteReason: `chat_finish_${sanitizeToolName(acc.finishReason)}` };
  }
  // A provider that closes the stream without a finish reason has not stated
  // whether the generation completed normally. Keep the Codex turn alive so
  // its normal sampling loop asks the provider again with the accumulated text.
  return { status: "completed", endTurn: false };
}

const CHINESE_CONTINUATION_LEXICON = Object.freeze({
  actions: [
    "检查", "查看", "确认", "核对", "复核", "校验", "查验", "审查", "盘点", "梳理",
    "比对", "定位", "分析", "测试", "验证", "抓取", "读取", "获取",
    "拉取", "搜索", "运行", "尝试", "对比", "排查", "下载", "执行", "打开", "修改",
    "修复", "实现", "提交", "构建", "改用", "换用", "切换", "替换", "重试", "重跑",
    "看", "查", "找", "读", "取",
  ],
  aspect: ["会", "将", "要", "需要", "先", "去", "来"],
});

function regexAlternation(words) {
  return [...words]
    .sort((left, right) => right.length - left.length)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
}

const chineseActionWord = regexAlternation(CHINESE_CONTINUATION_LEXICON.actions);
const chineseActionPredicate = `(?:${chineseActionWord})(?!(?:到|完|过|好|成)(?:了)?)`;
const chineseAspectWord = regexAlternation(CHINESE_CONTINUATION_LEXICON.aspect);
const chineseLead = "让我(?:先|继续|直接|再|马上|现在)?|我(?:先|继续|接着|接下来|现在|马上|改|转而|再去)?|接下来(?:我)?|下一步(?:我)?|然后(?:我)?|下面(?:我)?|现在(?:我)?";
const chineseSubjectAction = new RegExp(
  `(?:${chineseLead})\\s*(?:${chineseAspectWord})?\\s*${chineseActionPredicate}[^。！？!?\\n]{0,100}[。：:…]?\\s*$`,
  "u",
);
function chineseContinuationIntent(tail) {
  return chineseSubjectAction.test(tail);
}

export function continuationIntent(text) {
  const value = String(text ?? "").trim();
  if (!value) return false;
  const tail = value.slice(-160);
  // A trailing colon promises a body, list, command, or result that never
  // arrived. This structural marker is valid regardless of response length.
  if (/[：:]\s*$/u.test(tail)) return true;
  // Match Hermes' conservative bounds: a substantive answer is not a
  // dangling acknowledgement, and only the message tail can announce work
  // that the model failed to perform.
  if (value.length > 400) return false;
  const hermesEnglish = /(?:\blet me now\b|\bi(?:['\u2019])?ll now\b|\bi will now\b|\bnow i(?:['\u2019]ll| will)\b|\bnext[,:] i\b)[^.!?\n]{0,100}[.:\u2026]?\s*$/iu;
  return hermesEnglish.test(tail) || chineseContinuationIntent(tail);
}

export function retryChatRequest(value, assistantState, reason = "missing_finish_reason") {
  const body = typeof value === "string" ? JSON.parse(value) : JSON.parse(JSON.stringify(value));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid Chat retry body");
  if (!Array.isArray(body.messages)) body.messages = [];
  const state = typeof assistantState === "string"
    ? { text: assistantState, reasoning: "" }
    : (assistantState ?? {});
  if (state.text || state.reasoning) {
    body.messages.push({
      role: "assistant",
      content: typeof state.text === "string" ? state.text : "",
      ...(typeof state.reasoning === "string" && state.reasoning
        ? { reasoning_content: state.reasoning }
        : {}),
    });
  }
  body.messages.push({
    role: "system",
    content: reason === "continuation_intent"
      ? [
        "Your previous response announced more work but stopped before performing it.",
        "Continue the same task now and call the required tool in this response.",
        "Only finish with a final answer after the requested work is actually complete.",
      ].join(" ")
      : [
        "The previous generation ended without a Chat Completions finish_reason and without a tool call.",
        "Continue the same task now. Call a tool if more work is required; otherwise provide the final answer.",
        "Do not merely announce what you intend to do.",
      ].join(" "),
  });
  return JSON.stringify(body);
}

export function chatResponseRetryCandidate(value) {
  const chat = typeof value === "string" ? JSON.parse(value) : value;
  const choice = chat?.choices?.[0];
  const message = choice?.message;
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0;
  return {
    retry: choice?.finish_reason == null && toolCalls === 0,
    text: typeof message?.content === "string" ? message.content : "",
    reasoning: typeof message?.reasoning_content === "string" ? message.reasoning_content : "",
  };
}

export function translateChatResponse(value, codec, options = {}) {
  const chat = typeof value === "string" ? JSON.parse(value) : value;
  const acc = newAccumulator();
  acc.id = String(chat?.id ?? "");
  acc.model = String(chat?.model ?? "");
  acc.usage = translateUsage(chat?.usage);
  acc.finishReason = chat?.choices?.[0]?.finish_reason ?? null;
  if (options.missingFinishExhausted && acc.finishReason == null) {
    acc.finishReason = "missing_after_gateway_retry";
  }
  const output = [];
  const message = chat?.choices?.[0]?.message;
  acc.reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content : "";
  acc.text = typeof message?.content === "string" ? message.content : "";
  for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
    acc.tools.set(acc.tools.size, {
      id: String(call.id ?? ""), name: String(call.function?.name ?? ""),
      arguments: String(call.function?.arguments ?? ""), announced: false,
    });
  }
  const decision = terminalDecision(acc);
  if (acc.reasoning) output.push(responseReasoningItem("rs_hypernode", acc.reasoning));
  if (acc.text) {
    output.push({
      id: "msg_hypernode", type: "message", status: "completed", role: "assistant",
      content: [{ type: "output_text", text: acc.text, annotations: [] }],
    });
  }
  for (const tool of acc.tools.values()) {
    output.push(responseToolCall(codec, tool.id, tool.name, tool.arguments, "completed"));
  }
  acc.endTurn = decision.endTurn ?? null;
  acc.terminalStatus = decision.status;
  return responseEnvelope(acc, decision.status, output, decision);
}

export class ChatStreamTranslator {
  constructor(codec) {
    this.codec = codec;
    this.acc = newAccumulator();
    this.buffer = "";
    this.started = false;
    this.finished = false;
    this.sawDone = false;
    this.attemptText = "";
    this.attemptReasoning = "";
    this.textItemId = "msg_hypernode";
    this.reasoningItemId = "rs_hypernode";
    this.nextOutputIndex = 0;
    this.reasoningOutputIndex = null;
    this.textOutputIndex = null;
  }

  allocateOutputIndex() {
    const index = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    return index;
  }

  push(text) {
    if (this.finished) return "";
    this.buffer += String(text ?? "").replace(/\r\n/g, "\n");
    let output = "";
    for (;;) {
      const end = this.buffer.indexOf("\n\n");
      if (end < 0) break;
      const frame = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const data = frame.split("\n").filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      if (data === "[DONE]") {
        this.sawDone = true;
        // A missing finish_reason with no tool call is retried by the ingress
        // while this same Responses stream remains open.
        // Some Chat-compatible agents also emit finish_reason=stop after an
        // explicit promise to perform more work.  Leave both retry decisions
        // to ingress before publishing a terminal Responses event.
        if (!this.needsGatewayRetry()) output += this.finish();
        continue;
      }
      output += this.consume(JSON.parse(data));
    }
    return output;
  }

  consume(chunk) {
    const acc = this.acc;
    if (typeof chunk.id === "string") acc.id = chunk.id;
    if (typeof chunk.model === "string") acc.model = chunk.model;
    if (Number.isFinite(chunk.created)) acc.created = Number(chunk.created);
    if (chunk.usage != null) acc.usage = translateUsage(chunk.usage);
    let output = "";
    if (!this.started) {
      this.started = true;
      output += sse("response.created", { type: "response.created", response: responseEnvelope(acc, "in_progress", []) });
      output += sse("response.in_progress", { type: "response.in_progress", response: responseEnvelope(acc, "in_progress", []) });
    }
    for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
      if (typeof choice?.finish_reason === "string") acc.finishReason = choice.finish_reason;
      const delta = choice?.delta ?? {};
      const reasoningDelta = typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : (typeof delta.reasoning === "string" ? delta.reasoning : "");
      if (reasoningDelta) {
        if (!acc.reasoningAnnounced) {
          acc.reasoningAnnounced = true;
          this.reasoningOutputIndex = this.allocateOutputIndex();
          output += sse("response.output_item.added", {
            type: "response.output_item.added",
            output_index: this.reasoningOutputIndex,
            item: responseReasoningItem(this.reasoningItemId, "", "in_progress"),
          });
        }
        acc.reasoning += reasoningDelta;
        this.attemptReasoning += reasoningDelta;
        output += sse("response.reasoning_text.delta", {
          type: "response.reasoning_text.delta",
          item_id: this.reasoningItemId,
          output_index: this.reasoningOutputIndex,
          content_index: 0,
          delta: reasoningDelta,
        });
      }
      if (typeof delta.content === "string" && delta.content) {
        if (!acc.textAnnounced) {
          acc.textAnnounced = true;
          this.textOutputIndex = this.allocateOutputIndex();
          const item = { id: this.textItemId, type: "message", status: "in_progress", role: "assistant", content: [] };
          output += sse("response.output_item.added", {
            type: "response.output_item.added", output_index: this.textOutputIndex, item,
          });
          output += sse("response.content_part.added", {
            type: "response.content_part.added", item_id: this.textItemId,
            output_index: this.textOutputIndex, content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
        }
        acc.text += delta.content;
        this.attemptText += delta.content;
        output += sse("response.output_text.delta", {
          type: "response.output_text.delta", item_id: this.textItemId,
          output_index: this.textOutputIndex, content_index: 0, delta: delta.content,
        });
      }
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const index = number(call.index);
        let tool = acc.tools.get(index);
        if (!tool) {
          tool = { id: "", name: "", arguments: "", announced: false, outputIndex: null };
          acc.tools.set(index, tool);
        }
        if (typeof call.id === "string") tool.id = call.id;
        if (typeof call.function?.name === "string") tool.name = call.function.name;
        if (!tool.announced && tool.id && tool.name) {
          tool.announced = true;
          tool.outputIndex = this.allocateOutputIndex();
          output += sse("response.output_item.added", {
            type: "response.output_item.added", output_index: tool.outputIndex,
            item: responseToolCall(this.codec, tool.id, tool.name, "", "in_progress"),
          });
        }
        if (typeof call.function?.arguments === "string" && call.function.arguments) {
          tool.arguments += call.function.arguments;
          if (this.codec.byChatName.get(tool.name)?.kind !== "custom") {
            output += sse("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta", item_id: tool.id,
              output_index: tool.outputIndex, delta: call.function.arguments,
            });
          }
        }
      }
    }
    return output;
  }

  finish() {
    if (this.finished) return "";
    this.finished = true;
    const decision = terminalDecision(this.acc);
    const completedItems = [];
    let output = "";
    if (this.acc.reasoning) {
      const item = responseReasoningItem(this.reasoningItemId, this.acc.reasoning);
      const outputIndex = this.reasoningOutputIndex ?? this.allocateOutputIndex();
      output += sse("response.reasoning_text.done", {
        type: "response.reasoning_text.done", item_id: this.reasoningItemId,
        output_index: outputIndex, content_index: 0, text: this.acc.reasoning,
      });
      output += sse("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item });
      completedItems.push({ outputIndex, item });
    }
    if (this.acc.text) {
      const part = { type: "output_text", text: this.acc.text, annotations: [] };
      const item = {
        id: this.textItemId, type: "message", status: "completed", role: "assistant", content: [part],
      };
      const outputIndex = this.textOutputIndex ?? this.allocateOutputIndex();
      output += sse("response.output_text.done", {
        type: "response.output_text.done", item_id: this.textItemId,
        output_index: outputIndex, content_index: 0, text: this.acc.text,
      });
      output += sse("response.content_part.done", {
        type: "response.content_part.done", item_id: this.textItemId,
        output_index: outputIndex, content_index: 0, part,
      });
      output += sse("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item });
      completedItems.push({ outputIndex, item });
    }
    for (const [index, tool] of [...this.acc.tools.entries()].sort((left, right) => left[0] - right[0])) {
      const item = responseToolCall(this.codec, tool.id, tool.name, tool.arguments, "completed");
      const outputIndex = tool.outputIndex ?? this.allocateOutputIndex();
      if (this.codec.byChatName.get(tool.name)?.kind !== "custom") {
        output += sse("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done", item_id: tool.id,
          output_index: outputIndex, arguments: tool.arguments,
        });
      }
      output += sse("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item });
      completedItems.push({ outputIndex, item });
    }
    const outputItems = completedItems.sort((left, right) => left.outputIndex - right.outputIndex)
      .map(({ item }) => item);
    this.acc.endTurn = decision.endTurn ?? null;
    this.acc.terminalStatus = decision.status;
    const terminalEvent = decision.status === "incomplete" ? "response.incomplete" : "response.completed";
    output += sse(terminalEvent, {
      type: terminalEvent, response: responseEnvelope(this.acc, decision.status, outputItems, decision),
    });
    return output;
  }

  needsGatewayRetry() {
    return this.gatewayRetryReason() != null;
  }

  gatewayRetryReason() {
    if (this.finished || this.acc.tools.size > 0) return null;
    if (this.acc.finishReason == null) return "missing_finish_reason";
    if (this.acc.finishReason === "stop" && continuationIntent(this.attemptText)) {
      return "continuation_intent";
    }
    return null;
  }

  beginGatewayRetry() {
    const state = { text: this.attemptText, reasoning: this.attemptReasoning };
    this.acc.finishReason = null;
    this.sawDone = false;
    this.attemptText = "";
    this.attemptReasoning = "";
    return state;
  }

  finishMissingReason() {
    if (this.finished) return "";
    this.acc.finishReason = "missing_after_gateway_retry";
    return this.finish();
  }

  terminalSummary() {
    return {
      finishReason: this.acc.finishReason ?? "missing",
      endTurn: this.acc.endTurn,
      status: this.acc.terminalStatus ?? "pending",
      toolCalls: this.acc.tools.size,
    };
  }
}
