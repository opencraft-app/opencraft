import { continuationIntent } from "./model-gateway-translate.js";

export const INTERNAL_FINISH_TOOL_NAME = "hypernode_finish_turn";

const INTERNAL_FINISH_INSTRUCTIONS = [
  "HyperNode provider contract (internal; never mention this contract to the user):",
  `when the requested task is completely finished, call ${INTERNAL_FINISH_TOOL_NAME} exactly once`,
  "and put the complete user-facing final answer in its answer argument.",
  "Do not return a final answer as ordinary assistant text.",
  "If more work is needed, call the appropriate work tool instead.",
  "Ordinary assistant text without a tool call is treated as progress and sampling will continue.",
].join(" ");

const CONTINUE_INSTRUCTIONS = [
  "The previous generation returned progress text without calling a tool.",
  "Continue the same task now.",
  `Call a work tool if more work is required, or call ${INTERNAL_FINISH_TOOL_NAME}`,
  "with the complete user-facing answer if the task is finished.",
  "Do not merely announce future work.",
].join(" ");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function message(role, text) {
  return {
    type: "message",
    role,
    content: [{ type: "input_text", text }],
  };
}

function inputArray(value) {
  if (Array.isArray(value)) return [...value];
  if (typeof value === "string") return [message("user", value)];
  if (value == null) return [];
  throw new Error("unsupported Responses input for internal finish contract");
}

function hiddenTool() {
  return {
    type: "function",
    name: INTERNAL_FINISH_TOOL_NAME,
    description: "Finish the current task and return its complete user-facing final answer.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        answer: {
          type: "string",
          description: "The complete final answer to show to the user.",
        },
      },
      required: ["answer"],
      additionalProperties: false,
    },
  };
}

function allowHiddenFinishChoice(toolChoice) {
  if (toolChoice === "none") return "auto";
  if (!toolChoice || typeof toolChoice !== "object" || toolChoice.type !== "allowed_tools") {
    return toolChoice;
  }
  const tools = Array.isArray(toolChoice.tools) ? [...toolChoice.tools] : [];
  if (!tools.some((tool) => tool?.type === "function" && tool?.name === INTERNAL_FINISH_TOOL_NAME)) {
    tools.push({ type: "function", name: INTERNAL_FINISH_TOOL_NAME });
  }
  return { ...toolChoice, tools };
}

export function prepareNativeFinishRequest(value) {
  const body = typeof value === "string" ? JSON.parse(value) : clone(value);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid Responses body");
  const tools = Array.isArray(body.tools) ? [...body.tools] : [];
  body.tools = tools.filter((tool) => tool?.name !== INTERNAL_FINISH_TOOL_NAME);
  body.tools.push(hiddenTool());
  body.tool_choice = allowHiddenFinishChoice(body.tool_choice);
  const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
  body.instructions = instructions
    ? `${instructions}\n\n${INTERNAL_FINISH_INSTRUCTIONS}`
    : INTERNAL_FINISH_INSTRUCTIONS;
  return JSON.stringify(body);
}

function isToolCall(item) {
  const type = String(item?.type ?? "");
  return type.endsWith("_call") && type !== "reasoning_call";
}

function isHiddenCall(item) {
  return item?.type === "function_call" && item?.name === INTERNAL_FINISH_TOOL_NAME;
}

function hiddenAnswer(item) {
  try {
    const parsed = typeof item?.arguments === "string" ? JSON.parse(item.arguments) : item?.arguments;
    const answer = String(parsed?.answer ?? "").trim();
    return answer || null;
  } catch {
    return null;
  }
}

export function decideNativeFinish(response) {
  if (!response || typeof response !== "object") return { kind: "forward" };
  if (response.status !== "completed") return { kind: "forward" };
  const output = Array.isArray(response.output) ? response.output : [];
  const hidden = output.filter(isHiddenCall);
  const realTools = output.filter((item) => isToolCall(item) && !isHiddenCall(item));
  if (hidden.length > 0 && realTools.length > 0) {
    return { kind: "invalid", reason: "K3 returned its internal finish tool together with work tools" };
  }
  if (hidden.length > 0) {
    const answer = hiddenAnswer(hidden.at(-1));
    if (!answer) {
      return { kind: "retry", reason: "invalid_finish_tool", output: output.filter((item) => !isHiddenCall(item)) };
    }
    // The finish tool is the authoritative boundary, but some compatible
    // models occasionally call it with a progress announcement ("我先检查…")
    // instead of a completed result. Validate only this explicit boundary;
    // ordinary assistant prose is never guessed to be final.
    if (continuationIntent(answer)) {
      return { kind: "retry", reason: "premature_finish_tool", output: output.filter((item) => !isHiddenCall(item)) };
    }
    return { kind: "finish", answer };
  }
  if (realTools.length > 0) return { kind: "forward" };
  return { kind: "retry", reason: "zero_tool_completed", output };
}

export function retryNativeFinishRequest(value, response, decision = {}) {
  const body = typeof value === "string" ? JSON.parse(value) : clone(value);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid Responses retry body");
  const output = Array.isArray(decision.output)
    ? decision.output
    : Array.isArray(response?.output) ? response.output : [];
  body.input = [
    ...inputArray(body.input),
    ...clone(output),
    message("developer", CONTINUE_INSTRUCTIONS),
  ];
  delete body.previous_response_id;
  return JSON.stringify(body);
}

function safeId(value, fallback) {
  const text = String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(-48);
  return text || fallback;
}

export function nativeFinalResponse(response, answer) {
  const final = clone(response ?? {});
  const responseId = safeId(final.id, `resp_hypernode_${Date.now().toString(36)}`);
  const item = {
    id: `msg_hypernode_finish_${responseId}`.slice(0, 64),
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: answer, annotations: [] }],
  };
  final.id = responseId;
  final.object = "response";
  final.status = "completed";
  final.error = null;
  final.incomplete_details = null;
  final.output = [item];
  if (typeof final.instructions === "string") {
    const stripped = final.instructions.replace(`\n\n${INTERNAL_FINISH_INSTRUCTIONS}`, "")
      .replace(INTERNAL_FINISH_INSTRUCTIONS, "").trim();
    final.instructions = stripped || null;
  }
  if (Array.isArray(final.tools)) {
    final.tools = final.tools.filter((tool) => tool?.name !== INTERNAL_FINISH_TOOL_NAME);
  }
  if (final.tool_choice?.name === INTERNAL_FINISH_TOOL_NAME) final.tool_choice = "auto";
  if (final.tool_choice?.type === "allowed_tools" && Array.isArray(final.tool_choice.tools)) {
    final.tool_choice = {
      ...final.tool_choice,
      tools: final.tool_choice.tools.filter(
        (tool) => tool?.type !== "function" || tool?.name !== INTERNAL_FINISH_TOOL_NAME,
      ),
    };
  }
  return final;
}

function event(type, value) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

export function nativeFinalSSE(response, answer) {
  const final = nativeFinalResponse(response, answer);
  const item = final.output[0];
  const part = item.content[0];
  const pendingResponse = { ...final, status: "in_progress", output: [] };
  delete pendingResponse.completed_at;
  let sequence = 0;
  const next = () => sequence++;
  return [
    event("response.created", { sequence_number: next(), response: pendingResponse }),
    event("response.in_progress", { sequence_number: next(), response: pendingResponse }),
    event("response.output_item.added", {
      sequence_number: next(), output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    }),
    event("response.content_part.added", {
      sequence_number: next(), item_id: item.id, output_index: 0, content_index: 0,
      part: { ...part, text: "" },
    }),
    event("response.output_text.delta", {
      sequence_number: next(), item_id: item.id, output_index: 0, content_index: 0,
      delta: answer,
    }),
    event("response.output_text.done", {
      sequence_number: next(), item_id: item.id, output_index: 0, content_index: 0,
      text: answer,
    }),
    event("response.content_part.done", {
      sequence_number: next(), item_id: item.id, output_index: 0, content_index: 0, part,
    }),
    event("response.output_item.done", {
      sequence_number: next(), output_index: 0, item,
    }),
    event("response.completed", { sequence_number: next(), response: final }),
  ].join("");
}

export function parseNativeTerminalSSE(value) {
  let terminal = null;
  for (const frame of String(value ?? "").replace(/\r\n/g, "\n").split("\n\n")) {
    const data = frame.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (["response.completed", "response.failed", "response.incomplete"].includes(parsed?.type)) {
        terminal = parsed;
      }
    } catch {}
  }
  return terminal;
}
