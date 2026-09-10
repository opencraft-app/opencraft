import type { DshEvent } from "./dsh-client.js";
import { resolve } from "node:path";
import { classifyDshCommand } from "./dsh-command-actions.js";
type Value = Record<string, unknown>;
const object = (value: unknown): Value => value && typeof value === "object" ? value as Value : {};

/** Stateful identity join shared by live events and persisted history. */
export class DshToolProjection {
  constructor(private readonly cwd = "/") {}
  private readonly calls = new Map<string, { item: Value; startedAt: number; completed: boolean }>();
  project(sessionId: string, event: DshEvent): Value[] {
    const data = object(event.data);
    if (event.type === "tool/call") {
      if (typeof data.callId !== "string" || this.calls.has(data.callId)) return [];
      let args = data.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* Keep malformed arguments visible. */ } }
      const parameters = object(args);
      const command = typeof parameters.command === "string" ? parameters.command : typeof parameters.cmd === "string" ? parameters.cmd : "";
      const cwd = typeof parameters.workdir === "string" ? resolve(this.cwd, parameters.workdir) : this.cwd;
      const item: Value = data.name === "bash" && parameters.run_in_background !== true ? {
        type: "commandExecution", id: `dsh-tool-${sessionId}-${data.callId}`, command, cwd,
        processId: null, source: "agent", status: "inProgress", commandActions: classifyDshCommand(command, cwd),
        aggregatedOutput: null, exitCode: null, durationMs: null,
      } : { type: "dynamicToolCall", id: `dsh-tool-${sessionId}-${data.callId}`,
        namespace: "dsh", tool: data.name, arguments: args,
        status: "inProgress", contentItems: null, success: null, durationMs: null };
      this.calls.set(data.callId, { item, startedAt: event.time, completed: false });
      return [{ ...item }];
    }
    if (event.type !== "tool/result") return [];
    const message = object(data.message);
    const source = object(message.source);
    const call = typeof source.callId === "string" ? this.calls.get(source.callId) : undefined;
    if (!call || call.completed) return [];
    const results = Array.isArray(message.content) ? message.content.map(object).filter(block => block.type === "tool-result") : [];
    const blocks = results.flatMap(result => Array.isArray(result.content) ? result.content.map(object) : []);
    const failed = Boolean(data.error) || results.some(result => result.isError === true);
    call.completed = true;
    if (call.item.type === "commandExecution") {
      const text = blocks.filter(block => block.type === "text").map(block => String(block.text ?? "")).join("");
      const marker = text.match(/\[exit code:\s*(-?\d+)\]\s*$/iu);
      const terminated = /\[(?:timed out after|killed by signal:)/iu.test(text);
      const exitCode = marker ? Number(marker[1]) : failed || terminated ? null : 0;
      Object.assign(call.item, { aggregatedOutput: text, exitCode,
        status: failed || terminated || (exitCode !== null && exitCode !== 0) ? "failed" : "completed",
        durationMs: Math.max(0, event.time - call.startedAt) });
      return [{ ...call.item }];
    }
    Object.assign(call.item, { status: failed ? "failed" : "completed", success: !failed,
      durationMs: Math.max(0, event.time - call.startedAt),
      contentItems: blocks.flatMap<Value>(block => {
        if (block.type === "text" && typeof block.text === "string") return [{ type: "inputText", text: block.text }];
        if (block.type === "image" && typeof block.data === "string" && typeof block.mediaType === "string") return [{ type: "inputImage", imageUrl: `data:${block.mediaType};base64,${block.data}` }];
        if (block.type === "audio" && typeof block.data === "string" && typeof block.mediaType === "string") return [{ type: "inputAudio", audioUrl: `data:${block.mediaType};base64,${block.data}` }];
        return [];
      }),
    });
    return [{ ...call.item }];
  }
  settle(time: number, interrupted: boolean): Value[] {
    const result: Value[] = [];
    for (const call of this.calls.values()) if (!call.completed) {
      call.completed = true;
      // DynamicToolCallStatus has no interrupted variant; interruption belongs
      // to the owning Turn, while this unfinished invocation is unsuccessful.
      Object.assign(call.item, { status: "failed", durationMs: Math.max(0, time - call.startedAt) });
      if (call.item.type === "dynamicToolCall") Object.assign(call.item, { success: false,
        contentItems: [{ type: "inputText", text: interrupted ? "Tool interrupted before completion" : "Turn ended without a tool result" }] });
      result.push({ ...call.item });
    }
    this.calls.clear();
    return result;
  }
}
