type Value = Record<string, any>;
type NativeCall = (type: string, params?: Value, timeoutMs?: number) => Promise<any>;
const record = (input: unknown): Value => input && typeof input === "object" && !Array.isArray(input) ? input as Value : {};
const modelId = (model: Value) => `${encodeURIComponent(model.provider)}:${encodeURIComponent(model.id)}`;

/** Adapts the installed Pi CLI's JSONL RPC to the existing connected-Agent owner.
 * The transport owns the sole native process; this adapter never spawns a peer.
 */
export class PiRpcAdapter {
  private state: Value = {};
  private models: Value[] = [];
  private active?: { resolve(value: Value): void; reject(error: Error): void; error?: Error; aborted: boolean };
  constructor(private readonly call: NativeCall, private readonly emit: (method: string, params: Value) => void) {}
  get hasActiveRun(): boolean { return this.active !== undefined; }
  async initialize(): Promise<Value> {
    await this.catalog();
    return { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} },
      promptCapabilities: { image: this.models.some(model => model.input?.includes("image")) } } };
  }
  private async catalog(): Promise<void> {
    const result = record(await this.call("get_available_models"));
    if (!Array.isArray(result.models) || result.models.some(model => typeof model?.id !== "string" || typeof model?.provider !== "string")) throw new Error("Invalid Pi model catalog");
    this.models = result.models;
  }
  private async setup(): Promise<Value> {
    this.state = record(await this.call("get_state"));
    if (typeof this.state.sessionId !== "string" || !this.state.sessionId) throw new Error("Pi did not provide a session identity");
    const levels = record(await this.call("get_available_thinking_levels")).levels;
    if (!Array.isArray(levels) || levels.some(level => typeof level !== "string")) throw new Error("Invalid Pi thinking options");
    const current = record(this.state.model);
    return { sessionId: this.state.sessionId,
      models: { currentModelId: current.id ? modelId(current) : null, availableModels: this.models.map(model => ({
        modelId: modelId(model), name: model.name || model.id,
        inputModalities: model.input?.includes("image") ? ["text", "image"] : ["text"],
      })) },
      configOptions: [
        { id: "model", category: "model", type: "select", currentValue: current.id ? modelId(current) : "",
          options: this.models.map(model => ({ value: modelId(model), name: model.name || model.id })) },
        { id: "reasoning_effort", category: "thought_level", type: "select", currentValue: this.state.thinkingLevel ?? "off",
          options: levels.map(value => ({ value, name: value })) },
      ],
    };
  }
  async request(method: string, params: Value): Promise<Value> {
    if (method === "session/new" || method === "session/resume" || method === "session/load") {
      if (Array.isArray(params.mcpServers) && params.mcpServers.length) throw new Error("Pi uses its native tools and MCP configuration");
      const result = await this.setup();
      if (method !== "session/new" && result.sessionId !== params.sessionId) throw new Error("Pi session identity changed; input was not sent");
      return result;
    }
    if (params.sessionId !== this.state.sessionId) throw new Error("Pi session is not loaded");
    if (method === "session/set_config_option") {
      if (params.configId === "model") {
        const model = this.models.find(model => modelId(model) === params.value);
        if (!model) throw new Error("Pi model is unavailable");
        await this.call("set_model", { provider: model.provider, modelId: model.id });
      } else if (params.configId === "reasoning_effort") await this.call("set_thinking_level", { level: params.value });
      else throw new Error("Unsupported Pi option");
      return this.setup();
    }
    if (method !== "session/prompt") throw new Error("Unsupported Pi operation");
    if (this.active) throw new Error("Pi is already running");
    if (!Array.isArray(params.prompt) || params.prompt.some(part => !part || !["text", "image"].includes(part.type))) throw new Error("Unsupported Pi content");
    this.state = record(await this.call("get_state"));
    const images = params.prompt.filter(part => part.type === "image");
    if (images.length && !this.state.model?.input?.includes("image")) throw new Error("This Pi model does not support image input");
    let resolve!: (value: Value) => void, reject!: (error: Error) => void;
    const completion = new Promise<Value>((yes, no) => { resolve = yes; reject = no; });
    const active = { resolve, reject, aborted: false }; this.active = active;
    // Attach a rejection handler immediately: a native exit can beat the ACK.
    void completion.catch(() => undefined);
    try {
      const result = record(await this.call("prompt", { message: params.prompt.filter(part => part.type === "text").map(part => part.text).join("\n"),
        ...(images.length ? { images: images.map(part => ({ type: "image", data: part.data, mimeType: part.mimeType })) } : {}) }, 0));
      if (result.disposition === "handled") { active.resolve({ stopReason: "end_turn" }); if (this.active === active) this.active = undefined; }
    } catch (error) { this.fail(error instanceof Error ? error : new Error("Pi rejected input")); }
    return completion;
  }
  async cancel(): Promise<void> { if (this.active) this.active.aborted = true; await this.call("abort", {}, 5000); }
  fail(error: Error): void { const active = this.active; this.active = undefined; active?.reject(error); }
  event(raw: unknown): void {
    const event = record(raw), active = this.active;
    if (!active) return;
    const update = (update: Value) => this.emit("session/update", { sessionId: this.state.sessionId, update });
    if (event.type === "message_update") {
      const delta = record(event.assistantMessageEvent);
      if (["text_delta", "thinking_delta"].includes(delta.type) && typeof delta.delta === "string") update({ sessionUpdate: delta.type === "text_delta" ? "agent_message_chunk" : "agent_thought_chunk", content: { type: "text", text: delta.delta } });
    } else if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type)) {
      update({ sessionUpdate: event.type === "tool_execution_start" ? "tool_call" : "tool_call_update", toolCallId: event.toolCallId,
        title: event.toolName, status: event.type === "tool_execution_end" ? event.isError ? "failed" : "completed" : "in_progress",
        ...(event.args ? { rawInput: event.args } : {}), ...(event.result || event.partialResult ? { rawOutput: event.result ?? event.partialResult } : {}) });
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      if (message.stopReason === "error") active.error = new Error("Pi generation failed");
      else if (message.stopReason !== "aborted") active.error = undefined;
      if (message.stopReason === "aborted") active.aborted = true;
      const usage = record(message.usage), used = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].reduce((sum, n) => sum + (Number.isSafeInteger(n) && n >= 0 ? n : 0), 0);
      if (used && Number.isSafeInteger(this.state.model?.contextWindow)) update({ sessionUpdate: "usage_update", used, size: this.state.model.contextWindow });
    } else if (event.type === "agent_settled") {
      this.active = undefined;
      if (active.error && !event.aborted && !active.aborted) active.reject(active.error);
      else active.resolve({ stopReason: event.aborted || active.aborted ? "cancelled" : "end_turn" });
    }
  }
}
