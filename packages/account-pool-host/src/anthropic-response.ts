import { randomUUID } from "node:crypto";
import { ANTHROPIC_THINKING_PREFIX, record, type AnthropicTool } from "./anthropic-request.js";

type ObjectValue = Record<string, any>;
const MAX_RECORD = 2 * 1024 * 1024, MAX_OUTPUT = 64 * 1024 * 1024;
class AnthropicStreamError extends Error {}
type Block = { index: number; item: ObjectValue; source: ObjectValue; text: string; signature: string; closed: boolean; released?: boolean; tool?: AnthropicTool };
const count = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0 ? Number(n) : 0;

/** One request owns one converter. No session state or mutable provider defaults. */
class MessageEvents {
  private started = false;
  private stopReason: string | null = null;
  private usage: ObjectValue = {};
  private blocks = new Map<number, Block>();
  private outputs: ObjectValue[] = [];
  private sequence = 0;
  private bytes = 0;
  private id = "resp_" + randomUUID();
  terminal = false;
  response: ObjectValue | null = null;
  constructor(private readonly model: string, private readonly tools: Map<string, AnthropicTool>, private readonly observe: (reason: string) => void) {}
  private event(type: string, fields: ObjectValue = {}): ObjectValue { return { type, sequence_number: this.sequence++, ...fields }; }
  private snapshot(status: string): ObjectValue {
    const input = count(this.usage.input_tokens) + count(this.usage.cache_read_input_tokens) + count(this.usage.cache_creation_input_tokens);
    const output = count(this.usage.output_tokens);
    return { id: this.id, object: "response", model: this.model, status, output: this.outputs,
      usage: { input_tokens: input, output_tokens: output, total_tokens: input + output,
        input_tokens_details: { cached_tokens: count(this.usage.cache_read_input_tokens),
          cache_write_tokens: count(this.usage.cache_creation_input_tokens) } } };
  }
  fail(reason: string, code = "upstream_protocol_error"): ObjectValue[] {
    if (this.terminal) return [];
    this.terminal = true; this.observe(reason);
    const text = this.releaseText(null);
    this.response = { ...this.snapshot("failed"), error: { type: "invalid_request_error", code,
      message: `Anthropic response did not complete (${reason}).`, source_reason: reason } };
    return [...text, this.event("response.failed", { response: this.response })];
  }
  /**
   * Completed text is held until the provider commits the message, because only
   * then is it known whether tool calls follow. Codex' MessagePhase contract:
   * text followed by more work in the same response is commentary; the closing
   * text of a response that ended by itself (end_turn/stop_sequence) is the
   * final answer. Truncated or failed responses stay unknown (phase omitted).
   */
  private releaseText(stopReason: string | null): ObjectValue[] {
    const blocks = [...this.blocks.values()].sort((a, b) => a.index - b.index);
    const ended = stopReason === "end_turn" || stopReason === "stop_sequence";
    const work = (block: Block) => blocks.some(other => other.index > block.index && (other.tool || other.source.type === "text"));
    const events: ObjectValue[] = [];
    for (const block of blocks) {
      if (block.source.type !== "text" || !block.closed || block.released) continue;
      block.released = true;
      if (stopReason === "tool_use" || (ended && work(block))) block.item.phase = "commentary";
      else if (ended) block.item.phase = "final_answer";
      events.push(this.event("response.output_item.done", { output_index: block.index, item: structuredClone(block.item) }));
    }
    return events;
  }
  accept(raw: unknown): ObjectValue[] {
    const value = record(raw), events: ObjectValue[] = [];
    if (this.terminal) throw new AnthropicStreamError("Event after terminal receipt");
    if (value.type === "ping") return [];
    if (value.type === "error") {
      const type = value.error?.type;
      // Preserve transient categories. Explicit upstream filtering is never made successful.
      return this.fail(["refusal", "content_filter", "content_filtered", "permission_error"].includes(type) ? type : "upstream_error",
        type === "rate_limit_error" ? "rate_limit_exceeded" : type === "overloaded_error" ? "server_is_overloaded" : "invalid_prompt");
    }
    if (value.type === "message_start") {
      if (this.started) throw new AnthropicStreamError("Duplicate message start");
      this.started = true;
      const message = record(value.message);
      if (!message.id || message.role !== "assistant" || (message.content?.length ?? 0) !== 0) throw new AnthropicStreamError("Invalid message start");
      this.usage = record(message.usage ?? {});
      events.push(this.event("response.created", { response: this.snapshot("in_progress") }));
      return events;
    }
    if (!this.started) throw new AnthropicStreamError("Missing message start");
    if (value.type === "message_delta") {
      if (this.stopReason !== null) throw new AnthropicStreamError("Duplicate message delta");
      const reason = value.delta?.stop_reason;
      if (typeof reason !== "string") throw new AnthropicStreamError("Missing stop reason");
      this.stopReason = reason;
      this.usage = { ...this.usage, ...record(value.usage ?? {}) };
      return [];
    }
    if (value.type === "message_stop") {
      if (!this.stopReason || [...this.blocks.values()].some(block => !block.closed)) throw new AnthropicStreamError("Incomplete message receipt");
      if (["refusal", "content_filter", "content_filtered"].includes(this.stopReason)) return this.fail(this.stopReason, "invalid_prompt");
      if (!["end_turn", "stop_sequence", "tool_use", "max_tokens"].includes(this.stopReason)) return this.fail("unsupported_stop_reason", "invalid_prompt");
      if (this.stopReason === "tool_use" && !this.outputs.some(item => item.type === "function_call" || item.type === "custom_tool_call")) throw new AnthropicStreamError("Missing tool call");
      const hasTools = [...this.blocks.values()].some(block => block.tool);
      if (hasTools && !["tool_use", "max_tokens"].includes(this.stopReason)) throw new AnthropicStreamError("Contradictory tool stop reason");
      if (!hasTools && this.stopReason !== "max_tokens" && ![...this.blocks.values()].some(block => block.source.type === "text" && block.text.trim()))
        return this.fail("empty_response");
      this.terminal = true; this.observe(this.stopReason);
      const incomplete = this.stopReason === "max_tokens";
      this.response = { ...this.snapshot(incomplete ? "incomplete" : "completed"), error: null,
        ...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}) };
      events.push(...this.releaseText(this.stopReason));
      // Native Codex can execute immediately on output_item.done. Only release
      // tool receipts after the provider commits the whole message successfully.
      if (!incomplete) for (const block of this.blocks.values()) if (block.tool) {
        const common = { output_index: block.index, item_id: block.item.id };
        events.push(this.event(block.tool.custom ? "response.custom_tool_call_input.done" : "response.function_call_arguments.done",
          { ...common, ...(block.tool.custom ? { input: block.item.input } : { arguments: block.item.arguments }) }),
          this.event("response.output_item.done", { output_index: block.index, item: structuredClone(block.item) }));
      }
      events.push(this.event(incomplete ? "response.incomplete" : "response.completed", { response: this.response }));
      return events;
    }
    if (!Number.isSafeInteger(value.index) || value.index < 0) throw new AnthropicStreamError("Invalid content block index");
    if (this.stopReason) throw new AnthropicStreamError("Content after message delta");
    if (value.type === "content_block_start") {
      if (this.blocks.has(value.index)) throw new AnthropicStreamError("Duplicate block index");
      const source = record(value.content_block), index = this.outputs.length, id = "item_" + randomUUID();
      let item: ObjectValue, tool: AnthropicTool | undefined;
      if (source.type === "text") item = { type: "message", id, role: "assistant", status: "in_progress", content: [] };
      else if (source.type === "thinking" || source.type === "redacted_thinking") item = { type: "reasoning", id, summary: [] };
      else if (source.type === "tool_use") {
        tool = this.tools.get(source.name);
        if (!tool?.definition || typeof source.id !== "string" || !source.id) throw new AnthropicStreamError("Unknown upstream tool");
        if (this.outputs.some(item => item.call_id === source.id)) throw new AnthropicStreamError("Duplicate tool call ID");
        item = { type: tool.custom ? "custom_tool_call" : "function_call", id, call_id: source.id, name: tool.name,
          ...(tool.namespace ? { namespace: tool.namespace } : {}), ...(tool.custom ? { input: "" } : { arguments: "" }) };
      } else throw new AnthropicStreamError("Unsupported upstream content block");
      const block: Block = { index, item, source, tool, text: "", signature: "", closed: false };
      this.blocks.set(value.index, block); this.outputs.push(item);
      events.push(this.event("response.output_item.added", { output_index: index, item: structuredClone(item) }));
      if (source.type === "text") events.push(this.event("response.content_part.added", { output_index: index, item_id: id,
        content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
      if (source.type === "thinking") events.push(this.event("response.reasoning_summary_part.added", { output_index: index, item_id: id,
        summary_index: 0, part: { type: "summary_text", text: "" } }));
      if (source.type === "text" && source.text) events.push(...this.delta(block, "text_delta", source.text));
      if (source.type === "thinking" && source.thinking) events.push(...this.delta(block, "thinking_delta", source.thinking));
      if (source.signature !== undefined) {
        if (typeof source.signature !== "string") throw new AnthropicStreamError("Invalid thinking signature");
        block.signature = source.signature;
      }
      if (source.type === "tool_use" && source.input && Object.keys(record(source.input)).length) block.text = JSON.stringify(source.input);
      return events;
    }
    const block = this.blocks.get(value.index);
    if (!block || block.closed) throw new AnthropicStreamError("Invalid block lifecycle");
    if (value.type === "content_block_delta") {
      const delta = record(value.delta);
      if (delta.type === "signature_delta" && block.source.type === "thinking" && typeof delta.signature === "string") {
        block.signature += delta.signature; return [];
      }
      return this.delta(block, delta.type, delta.text ?? delta.thinking ?? delta.partial_json);
    }
    if (value.type !== "content_block_stop") throw new AnthropicStreamError("Unsupported Anthropic stream event");
    block.closed = true;
    const common = { output_index: block.index, item_id: block.item.id };
    if (block.source.type === "text") {
      const part = { type: "output_text", text: block.text, annotations: [] };
      block.item.content = [part]; block.item.status = "completed";
      events.push(this.event("response.output_text.done", { ...common, content_index: 0, text: block.text }),
        this.event("response.content_part.done", { ...common, content_index: 0, part }));
      return events; // output_item.done carries the phase; see releaseText.
    } else if (block.tool) {
      let args: ObjectValue;
      try { args = record(JSON.parse(block.text || "{}")); } catch { throw new AnthropicStreamError("Invalid tool argument JSON"); }
      if (block.tool.custom) {
        if (typeof args.input !== "string" || Object.keys(args).length !== 1) throw new AnthropicStreamError("Invalid freeform tool input");
        block.item.input = args.input;
      } else if (block.tool.argumentEnvelope) {
        if (Object.keys(args).length !== 1 || !Object.hasOwn(args, "arguments")) throw new AnthropicStreamError("Invalid tool argument envelope");
        block.item.arguments = JSON.stringify(record(args.arguments));
      } else block.item.arguments = block.text || "{}";
      return []; // Hold the executable receipt until message_stop; see above.
    } else {
      const original = block.source.type === "thinking"
        ? { type: "thinking", thinking: block.text, signature: block.signature }
        : { type: "redacted_thinking", data: block.source.data };
      if ((original.type === "thinking" && !block.signature) || (original.type === "redacted_thinking" && typeof original.data !== "string")) throw new AnthropicStreamError("Missing thinking signature");
      block.item.encrypted_content = ANTHROPIC_THINKING_PREFIX + Buffer.from(JSON.stringify(original)).toString("base64");
      block.item.summary = block.text ? [{ type: "summary_text", text: block.text }] : [];
    }
    events.push(this.event("response.output_item.done", { output_index: block.index, item: structuredClone(block.item) }));
    return events;
  }
  private delta(block: Block, type: string, value: unknown): ObjectValue[] {
    if (typeof value !== "string") throw new AnthropicStreamError("Invalid content delta");
    this.bytes += Buffer.byteLength(value);
    if (this.bytes > MAX_OUTPUT) throw new AnthropicStreamError("Upstream output limit exceeded");
    const expected = block.tool ? "input_json_delta" : block.source.type === "thinking" ? "thinking_delta" : "text_delta";
    if (type !== expected) throw new AnthropicStreamError("Mismatched content delta");
    block.text += value;
    if (block.tool?.custom || block.tool?.argumentEnvelope) return []; // Wire wrapping is not the native tool input.
    return [this.event(block.tool ? "response.function_call_arguments.delta" : block.source.type === "thinking"
      ? "response.reasoning_summary_text.delta" : "response.output_text.delta", {
        output_index: block.index, item_id: block.item.id, ...(block.source.type === "thinking" ? { summary_index: 0 } : { content_index: 0 }), delta: value,
      })];
  }
}

/** Parse bounded SSE records across UTF-8/chunk/CRLF boundaries; EOF is never success. */
async function* records(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line = "", data: string[] = [], size = 0, afterCR = false, totalBytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) throw new AnthropicStreamError("Upstream ended without message_stop");
    totalBytes += next.value.byteLength;
    if (totalBytes > MAX_OUTPUT) throw new AnthropicStreamError("Upstream stream limit exceeded");
    for (const char of decoder.decode(next.value, { stream: true })) {
      if (afterCR) { afterCR = false; if (char === "\n") continue; }
      if (char === "\r" || char === "\n") {
        afterCR = char === "\r";
        if (!line) {
          if (data.length) {
            let value: unknown;
            try { value = JSON.parse(data.join("\n")); } catch { throw new AnthropicStreamError("Malformed upstream SSE data"); }
            yield value;
          }
          data = []; size = 0;
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
        line = "";
      } else {
        size += char.length;
        if (size > MAX_RECORD) throw new AnthropicStreamError("Upstream SSE record limit exceeded");
        line += char;
      }
    }
  }
}

export function anthropicResponse(upstream: Response, model: string, tools: Map<string, AnthropicTool>, streaming: boolean,
  observe: (reason: string) => void): Response {
  if (!upstream.body || !upstream.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    void upstream.body?.cancel().catch(() => undefined);
    observe("invalid_stream_type");
    return Response.json({ error: { type: "invalid_request_error", message: "Anthropic upstream did not return an SSE stream" } }, { status: 502 });
  }
  const reader = upstream.body.getReader(), state = new MessageEvents(model, tools, observe), encoder = new TextEncoder();
  const iterator = (async function* () {
    try {
      for await (const value of records(reader)) {
        for (const event of state.accept(value)) yield event;
        if (state.terminal) return;
      }
    } catch {
      for (const event of state.fail("invalid_or_interrupted_stream")) yield event;
    } finally {
      void reader.cancel().catch(() => undefined); reader.releaseLock();
    }
  })();
  const headers = new Headers({ "content-type": streaming ? "text/event-stream" : "application/json", "cache-control": "no-store" });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!streaming) {
        for await (const _event of iterator) { /* collect the bounded terminal snapshot */ }
        controller.enqueue(encoder.encode(JSON.stringify(state.response))); controller.close(); return;
      }
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(`event: ${next.value.type}\ndata: ${JSON.stringify(next.value)}\n\n`));
    },
    async cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
      await iterator.return(undefined);
    },
  });
  return new Response(body, { headers });
}

/**
 * Provider wording for a prompt beyond the model's context window. Codex recovers (compacts or trims history and
 * retries) only from the Responses code context_length_exceeded, so a provider-specific code must not hide it.
 */
const CONTEXT_WINDOW_EXCEEDED = /prompt is too long|input is too long|exceeds? (?:the )?context (?:limit|window)/iu;

/** Bound provider error bodies; expose an actionable error to this authenticated caller only. */
export async function anthropicHttpError(upstream: Response, apiKey: string | undefined, requestId: string,
  observe?: (diagnostic: { category: string; keyword?: string }) => void, streaming = false): Promise<Response> {
  const reader = upstream.body?.getReader();
  let size = 0, raw = "";
  const decoder = new TextDecoder();
  try {
    if (reader) while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 64 * 1024) { raw = ""; break; }
      raw += decoder.decode(next.value, { stream: true });
    }
  } catch { raw = ""; }
  finally { if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); } }
  let code: string | undefined, detail: string | undefined;
  try {
    const body = record(JSON.parse(raw)), error = record(body.error ?? body);
    if (typeof error.code === "string" && /^[A-Za-z0-9_.-]{1,100}$/u.test(error.code)) code = error.code;
    if (typeof error.message === "string") detail = error.message;
  } catch { /* HTML or malformed provider bodies stay private. */ }
  // Log only fixed categories and vocabulary, never a provider body, schema path or prompt.
  const keyword = /property ['"](maxItems|minItems|minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf|minLength|maxLength|uniqueItems|minProperties|maxProperties)['"] is not supported/u.exec(detail ?? '')?.[1];
  const overflow = (upstream.status === 400 || upstream.status === 413) && CONTEXT_WINDOW_EXCEEDED.test(detail ?? "");
  observe?.({ category: keyword ? 'unsupported_schema_constraint' : overflow ? 'context_window_exceeded' : 'upstream_http_error', ...(keyword ? { keyword } : {}) });
  if (overflow) code = "context_length_exceeded";
  if (apiKey && detail) detail = detail.split(apiKey).join("[redacted]");
  detail = detail?.replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]+/giu, "[redacted]").slice(0,500);
  const error = { type: overflow ? "invalid_request_error" : "upstream_error", code,
    message: `Anthropic upstream returned HTTP ${upstream.status}.${detail ? " " + detail : ""}`, request_id: requestId };
  // A streaming Responses client classifies context-budget failures from response.failed; a bare HTTP 400 is an
  // ordinary invalid request to it. Other errors and non-streaming callers keep the provider status.
  if (overflow && streaming) {
    const response = { id: "resp_" + randomUUID(), object: "response", status: "failed", output: [], error };
    return new Response(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", sequence_number: 0, response })}\n\n`,
      { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  }
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  if (upstream.headers.has("retry-after")) headers.set("retry-after", upstream.headers.get("retry-after")!);
  return Response.json({ error }, { status: upstream.status, headers });
}
