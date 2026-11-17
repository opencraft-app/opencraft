import { createHash } from "node:crypto";
import { anthropicToolSchema } from "./anthropic-tool-schema.js";
import { anthropicOutputSchema } from "./anthropic-output-schema.js";

type ObjectValue = Record<string, any>;
export const ANTHROPIC_THINKING_PREFIX = "opencraft-anthropic-v1:";
export class AnthropicInputError extends Error {}
export const ANTHROPIC_SUMMARY_PREFIX = "opencraft-anthropic-summary-v1:";
/** Wire envelope only, not encryption. Native owns checkpoint storage; the adapter owns its format. */
export function anthropicSummary(item: ObjectValue): string | null {
  if (!["compaction", "compaction_summary"].includes(item.type) || typeof item.encrypted_content !== "string"
      || !item.encrypted_content.startsWith(ANTHROPIC_SUMMARY_PREFIX)) return null;
  try {
    const summary = JSON.parse(Buffer.from(item.encrypted_content.slice(ANTHROPIC_SUMMARY_PREFIX.length), "base64").toString("utf8")).summary;
    if (typeof summary === "string" && summary.trim()) return "[Conversation summary]\n" + summary;
  } catch { /* A corrupt checkpoint cannot be discarded or silently treated as ordinary text. */ }
  throw new AnthropicInputError("Invalid Anthropic compaction checkpoint");
}
export function record(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AnthropicInputError("Expected an object");
  return value as ObjectValue;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new AnthropicInputError("Expected text");
  return value;
}
function jsonObject(value: unknown): ObjectValue {
  try { return record(JSON.parse(string(value))); }
  catch { throw new AnthropicInputError("Tool arguments must be a JSON object"); }
}
export interface AnthropicTool {
  name: string;
  namespace?: string;
  custom: boolean;
  wire: string;
  argumentEnvelope?: boolean;
  definition?: ObjectValue;
}
export interface AnthropicRequest {
  body: ObjectValue;
  tools: Map<string, AnthropicTool>;
}

/** Deterministic names also resolve historical calls when their tool is no longer advertised. */
function wireName(name: string, namespace?: string): string {
  if (!namespace && /^[a-zA-Z0-9_-]{1,64}$/u.test(name) && !name.startsWith("oc_bridge_")) return name;
  return "oc_bridge_" + createHash("sha256").update(JSON.stringify([namespace ?? null, name])).digest("hex").slice(0,40);
}
function content(value: unknown): ObjectValue[] {
  if (typeof value === "string") return value ? [{ type: "text", text: value }] : [];
  if (!Array.isArray(value)) throw new AnthropicInputError("Unsupported message content");
  // Anthropic rejects empty text blocks; Codex can record one for a turn that produced no visible text.
  return value.map(raw => {
    const part = record(raw);
    if (["input_text", "output_text", "text"].includes(part.type)) return { type: "text", text: string(part.text) };
    if (part.type === "refusal") return { type: "text", text: string(part.refusal) };
    if (part.type === "input_image") {
      const url = string(part.image_url), data = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/u.exec(url);
      if (data) return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
      if (/^https?:\/\//u.test(url)) {
        try {
          const parsed = new URL(url);
          if (!parsed.username && !parsed.password) return { type: "image", source: { type: "url", url } };
        } catch { /* Reject invalid image URLs with the other unsupported content. */ }
      }
    }
    throw new AnthropicInputError("Unsupported Anthropic message content type");
  }).filter(block => block.type !== "text" || block.text !== "");
}

/**
 * Anthropic asks callers to resend without earlier thinking blocks when it cannot verify their signature (for example
 * when a gateway serves the follow-up from another backend). Remove every thinking block, then drop assistant turns
 * left empty and merge the neighbouring user turns so the conversation stays well formed.
 */
export function withoutThinkingHistory(body: ObjectValue): ObjectValue | null {
  if (!Array.isArray(body.messages)) return null;
  let removed = false;
  const messages: ObjectValue[] = [];
  for (const message of body.messages as ObjectValue[]) {
    const content = Array.isArray(message.content)
      ? message.content.filter((block: ObjectValue) => {
        const thinking = message.role === "assistant" && (block?.type === "thinking" || block?.type === "redacted_thinking");
        if (thinking) removed = true;
        return !thinking;
      })
      : message.content;
    if (Array.isArray(content) && !content.length) continue;
    const previous = messages.at(-1);
    if (previous && previous.role === message.role && Array.isArray(previous.content) && Array.isArray(content)) previous.content = [...previous.content, ...content];
    else messages.push({ ...message, content: Array.isArray(content) ? [...content] : content });
  }
  return removed ? { ...body, messages } : null;
}

const PROMPT_CACHE_BREAKPOINTS = 4;
function cacheableBlock(message: ObjectValue | undefined): ObjectValue | undefined {
  const blocks: ObjectValue[] = Array.isArray(message?.content) ? message.content : [];
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (blocks[index]?.type !== "thinking" && blocks[index]?.type !== "redacted_thinking") return blocks[index];
  }
  return undefined;
}

/**
 * Anthropic caches only prefixes that end at an explicit breakpoint (tools, then system, then messages), and Codex
 * resends the complete conversation on every step. Mark the stable tail of each section, as Messages clients do: the
 * last tool, the last system block, the newest message and the previous user turn. The previous user turn is where the
 * preceding request placed its newest breakpoint, so long tool loops still hit beyond the provider's block lookback.
 * Thinking blocks cannot carry cache_control. Markers are additive transport hints and never change content; the
 * converter builds every block itself, so no caller-supplied marker shares the provider's four-breakpoint limit.
 */
export function withPromptCacheBreakpoints(body: ObjectValue): ObjectValue {
  let budget = PROMPT_CACHE_BREAKPOINTS;
  const mark = (block: ObjectValue | undefined) => {
    if (budget <= 0 || !block || block.cache_control) return;
    block.cache_control = { type: "ephemeral" }; budget--;
  };
  mark(Array.isArray(body.tools) ? body.tools.at(-1) : undefined);
  mark(Array.isArray(body.system) ? body.system.at(-1) : undefined);
  const messages: ObjectValue[] = Array.isArray(body.messages) ? body.messages : [];
  mark(cacheableBlock(messages.at(-1)));
  for (let index = messages.length - 2; index >= 0; index--) {
    if (messages[index].role === "user") { mark(cacheableBlock(messages[index])); break; }
  }
  return body;
}

/** Stateless wire adapter; configuration, credentials and conversation history keep their owners. */
export function anthropicRequest(payload: ObjectValue, configuredMaxTokens?: number): AnthropicRequest {
  if (payload.previous_response_id || payload.conversation || payload.background) throw new AnthropicInputError("Anthropic requires explicit full conversation input");
  const tools = new Map<string, AnthropicTool>();
  const register = (raw: ObjectValue, namespace?: string, advertised = false): AnthropicTool => {
    const name = string(raw.name);
    if (!name || name.length > 512) throw new AnthropicInputError("Invalid tool name");
    const wire = wireName(name, namespace), custom = raw.type === "custom" || raw.type === "custom_tool_call";
    const prior = tools.get(wire);
    if (prior && (prior.name !== name || prior.namespace !== namespace || prior.custom !== custom)) throw new AnthropicInputError("Conflicting tool names");
    const tool: AnthropicTool = prior ?? { name, namespace, custom, wire };
    if (advertised) {
      if (tool.definition) throw new AnthropicInputError("Duplicate tool definition");
      let description = raw.description === undefined ? "" : string(raw.description);
      if (custom && raw.format && raw.format.type !== "text") {
        if (raw.format.type !== "grammar" || typeof raw.format.definition !== "string") throw new AnthropicInputError("Unsupported freeform tool format");
        description += `\nThe input string must follow this ${raw.format.syntax ?? ""} grammar:\n${raw.format.definition}`;
      }
      const schema = anthropicToolSchema(custom ? { type: "object", properties: { input: { type: "string", description: "The complete freeform tool input" } }, required: ["input"], additionalProperties: false } : record(raw.parameters ?? { type: "object", properties: {} }));
      tool.argumentEnvelope = schema.enveloped;
      if (schema.enveloped) description += "\nPass the complete tool arguments object inside the arguments property.";
      tool.definition = { name: wire, description: namespace ? `${namespace}.${name}\n${description}` : description, input_schema: schema.schema };
    }
    tools.set(wire, tool); return tool;
  };
  const addDefinitions = (values: unknown, namespace?: string) => {
    if (!Array.isArray(values)) throw new AnthropicInputError("Invalid tool list");
    for (const value of values) {
      const tool = record(value);
      // The shared broker uses ChatGPT auth for OAuth sessions, so native can
      // attach its hosted web_search even for an API-key model. It is an
      // optional provider capability, not a client-executed function. Never
      // advertise it to Messages or substitute another account's search.
      if (tool.type === "web_search" && !namespace) continue;
      if (tool.type === "namespace" && !namespace) addDefinitions(tool.tools, string(tool.name));
      else if (tool.type === "function" || tool.type === "custom") register(tool, namespace, true);
      else throw new AnthropicInputError(`Anthropic bridge supports function and freeform tools only (unsupported type: ${typeof tool.type === "string" && /^[a-z_]{1,40}$/u.test(tool.type) ? tool.type : "unknown"})`);
    }
  };
  if (payload.tools !== undefined) addDefinitions(payload.tools);
  const system: ObjectValue[] = [], messages: ObjectValue[] = [];
  const append = (role: "user" | "assistant", blocks: ObjectValue[]) => {
    if (!blocks.length) return;
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  if (payload.instructions) system.push({ type: "text", text: string(payload.instructions) });
  const input = typeof payload.input === "string" ? [{ role: "user", content: payload.input }] : payload.input;
  if (!Array.isArray(input)) throw new AnthropicInputError("Explicit conversation input is required");
  const pendingTools = new Set<string>();
  for (const value of input) {
    const item = record(value);
    if (item.type === "message" || item.type === undefined) {
      const blocks = content(item.content);
      if (item.role === "developer" || item.role === "system") system.push(...blocks);
      else if (item.role === "user" || item.role === "assistant") append(item.role, blocks);
      else throw new AnthropicInputError("Unsupported conversation role");
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      const tool = register(item, item.namespace === undefined ? undefined : string(item.namespace));
      const id = string(item.call_id);
      if (pendingTools.has(id)) throw new AnthropicInputError("Duplicate tool call ID");
      pendingTools.add(id);
      append("assistant", [{ type: "tool_use", id, name: tool.wire,
        input: tool.custom ? { input: string(item.input) } : tool.argumentEnvelope ? { arguments: jsonObject(item.arguments) } : jsonObject(item.arguments) }]);
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const id = string(item.call_id);
      if (!pendingTools.delete(id)) throw new AnthropicInputError("Tool result has no matching call");
      append("user", [{ type: "tool_result", tool_use_id: id, content: content(item.output) }]);
    } else if (item.type === "reasoning") {
      // This is a wire-opaque envelope, not encryption or a new private history store.
      // Reasoning from another protocol (e.g. before a model switch) cannot be verified here; the visible
      // messages and tool results it accompanied are still replayed, so omit only the opaque state.
      if (typeof item.encrypted_content !== "string" || !item.encrypted_content.startsWith(ANTHROPIC_THINKING_PREFIX)) continue;
      const opaque = item.encrypted_content;
      let block: ObjectValue;
      try { block = record(JSON.parse(Buffer.from(opaque.slice(ANTHROPIC_THINKING_PREFIX.length), "base64").toString("utf8"))); }
      catch { throw new AnthropicInputError("Invalid Anthropic thinking history"); }
      if (block.type === "thinking" && typeof block.thinking === "string" && typeof block.signature === "string") {
        append("assistant", [{ type: "thinking", thinking: block.thinking, signature: block.signature }]);
      } else if (block.type === "redacted_thinking" && typeof block.data === "string") append("assistant", [{ type: "redacted_thinking", data: block.data }]);
      else throw new AnthropicInputError("Invalid Anthropic thinking history");
    } else if (item.type === "compaction" || item.type === "compaction_summary") {
      const summary = anthropicSummary(item);
      if (summary === null) throw new AnthropicInputError("This compaction checkpoint belongs to another provider; compact with that provider before switching to Anthropic");
      append("user", [{ type: "text", text: summary }]);
    } else throw new AnthropicInputError("Unsupported Responses history item for Anthropic");
  }
  // A response interrupted after its thinking block leaves thinking with no answer or tool call. Anthropic rejects
  // an assistant message that ends in thinking, and such a block carries nothing to act on, so omit it.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    while (["thinking", "redacted_thinking"].includes(message.content.at(-1)?.type)) message.content.pop();
    if (message.content.length) continue;
    messages.splice(index, 1);
    const previous = messages[index - 1], next = messages[index];
    if (previous && next && previous.role === next.role) { previous.content.push(...next.content); messages.splice(index, 1); }
  }
  if (pendingTools.size || !messages.length || messages[0].role !== "user") throw new AnthropicInputError("Conversation must start with user input and contain complete tool results");
  // Responses input contains prior output, not a Messages assistant prefill.
  // A continuation after visible assistant output must start a new response.
  // Keep this transport-only cue out of the caller's history; never manufacture
  // tool results or turn an incomplete tool exchange into a valid request.
  if (messages.at(-1)?.role === "assistant") append("user", [{ type: "text", text:
    "[Protocol continuation] Continue responding to the existing user request, following the existing instructions. "
    + "Treat the preceding assistant messages as history, not as a prefix to repeat. "
    + "Do not repeat completed work. This transport-generated cue is not a new user request or additional authorization." }]);
  const maximum = payload.max_output_tokens ?? configuredMaxTokens ?? 32768;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new AnthropicInputError("Invalid output token limit");
  const body: ObjectValue = { model: payload.model, messages, max_tokens: Math.min(maximum, configuredMaxTokens ?? maximum), stream: true };
  if (system.length) body.system = system;
  const definitions = [...tools.values()].flatMap(tool => tool.definition ? [tool.definition] : []);
  if (definitions.length) body.tools = definitions;
  let choice: ObjectValue | undefined;
  if (payload.tool_choice === "none" || payload.tool_choice === "auto") choice = { type: payload.tool_choice };
  else if (payload.tool_choice === "required") choice = { type: "any" };
  else if (payload.tool_choice !== undefined) {
    const selected = record(payload.tool_choice);
    if (!["function", "custom"].includes(selected.type)) throw new AnthropicInputError("Unsupported tool selection");
    const tool = tools.get(wireName(string(selected.name), selected.namespace));
    if (!tool?.definition) throw new AnthropicInputError("Selected tool is unavailable");
    choice = { type: "tool", name: tool.wire };
  }
  if (payload.parallel_tool_calls === false) choice = { ...(choice ?? { type: "auto" }), disable_parallel_tool_use: true };
  if (!definitions.length && choice && !["auto", "none"].includes(choice.type)) throw new AnthropicInputError("No available tool satisfies the explicit tool selection");
  if (choice && definitions.length) body.tool_choice = choice;
  const effort = payload.reasoning?.effort;
  if (effort !== undefined) {
    if (effort === "none" || effort === "off") body.thinking = { type: "disabled" };
    else if (["low", "medium", "high", "max"].includes(effort)) {
      body.thinking = { type: "adaptive" }; body.output_config = { effort };
    } else if (/^[0-9]+$/u.test(String(effort)) && Number(effort) >= 1024 && Number(effort) < body.max_tokens) {
      body.thinking = { type: "enabled", budget_tokens: Number(effort) };
    } else throw new AnthropicInputError("Unsupported declared Anthropic thinking effort");
  }
  const format = payload.text?.format;
  if (format && format.type !== "text") {
    if (format.type !== "json_schema") throw new AnthropicInputError("Unsupported Anthropic output format");
    body.output_config = { ...body.output_config, format: { type: "json_schema", schema: anthropicOutputSchema(record(format.schema)) } };
  }
  for (const key of ["temperature", "top_p"] as const) if (payload[key] !== undefined) body[key] = payload[key];
  return { body, tools };
}
