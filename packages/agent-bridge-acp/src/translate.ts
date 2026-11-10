/**
 * ACP wire -> bridge semantic deltas.
 *
 * This translator never invents a final client event and never assigns a
 * canonical id. It only mints provider-native join keys (message ids, tool-call
 * ids) and lets the center assembler own turn/item identity and ordering.
 */

import { dirname } from "node:path";
import type { BridgeDelta, ItemShape } from "@opencraft/agent-bridge-protocol";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export interface AcpPromptImage {
  readonly mimeType: string;
  readonly data: string;
}

export interface AcpPromptInput {
  readonly text: string;
  readonly images: readonly AcpPromptImage[];
}

export interface PromptLimits {
  readonly maxBytes: number;
  readonly imagesAllowed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function base64Bytes(data: string): number {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(data) || data.length % 4 !== 0) {
    throw new Error("image data must be valid base64");
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/** Parse caller-supplied prompt content at the bridge edge. */
export function parsePromptInput(value: unknown, limits: PromptLimits): AcpPromptInput {
  if (!isRecord(value)) throw new Error("input must be an object with text and optional images");
  const text = stringValue(value.text) ?? "";
  const rawImages = value.images === undefined ? [] : value.images;
  if (!Array.isArray(rawImages)) throw new Error("input.images must be an array");
  if (rawImages.length > 8) throw new Error("at most 8 images are accepted");
  if (!limits.imagesAllowed && rawImages.length > 0) {
    throw new Error("the installed ACP agent did not declare image prompt support");
  }
  const images: AcpPromptImage[] = [];
  let total = Buffer.byteLength(text, "utf8");
  for (const raw of rawImages) {
    if (!isRecord(raw)) throw new Error("each image needs mimeType and base64 data");
    const mimeType = stringValue(raw.mimeType);
    const data = stringValue(raw.data);
    if (mimeType === undefined || data === undefined) throw new Error("each image needs mimeType and base64 data");
    if (!(IMAGE_TYPES as readonly string[]).includes(mimeType)) {
      throw new Error(`unsupported image type ${mimeType}`);
    }
    const bytes = base64Bytes(data);
    total += bytes;
    if (total > limits.maxBytes) throw new Error(`input exceeds ${limits.maxBytes} bytes`);
    images.push({ mimeType, data });
  }
  if (text.trim().length === 0 && images.length === 0) throw new Error("input is empty");
  if (total > limits.maxBytes) throw new Error(`input exceeds ${limits.maxBytes} bytes`);
  return { text, images };
}

export function toAcpPrompt(input: AcpPromptInput, imagesAllowed: boolean): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  if (input.text.length > 0) blocks.push({ type: "text", text: input.text });
  for (const image of input.images) {
    if (!imagesAllowed) throw new Error("the installed ACP agent did not declare image prompt support");
    blocks.push({ type: "image", mimeType: image.mimeType, data: image.data });
  }
  return blocks;
}

export function promptText(input: AcpPromptInput): string {
  return input.text;
}

function scope(threadId: string) {
  return { threadId };
}

function toolStatus(value: unknown): "inProgress" | "completed" | "failed" {
  if (value === "completed") return "completed";
  if (value === "failed") return "failed";
  return "inProgress";
}

function contentOutput(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    if (raw.type === "content" && isRecord(raw.content)) {
      const inner = raw.content;
      if (inner.type === "text" && typeof inner.text === "string") parts.push(inner.text);
    } else if (raw.type === "diff" && typeof raw.path === "string") {
      parts.push(`[diff ${raw.path}]`);
    } else if (raw.type === "terminal" && typeof raw.terminalId === "string") {
      parts.push(`[terminal ${raw.terminalId}]`);
    }
  }
  return parts.length === 0 ? null : parts.join("\n");
}

function rawOutputText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value).slice(0, 32 * 1024);
  } catch {
    return null;
  }
}

function locationCwd(raw: Record<string, unknown>, fallback: string): string {
  const locations = Array.isArray(raw.locations) ? raw.locations : [];
  for (const location of locations) {
    if (!isRecord(location) || typeof location.path !== "string") continue;
    return location.path.startsWith("/") ? dirname(location.path) : fallback;
  }
  return fallback;
}

type ToolShape = Extract<ItemShape, { kind: "tool" | "command" }>;

function toolShape(raw: Record<string, unknown>, fallbackCwd: string): ToolShape {
  const status = toolStatus(raw.status);
  const output = contentOutput(raw.content) ?? rawOutputText(raw.rawOutput);
  const name = stringValue(raw.name) ?? stringValue(raw.title) ?? stringValue(raw.kind) ?? "tool";
  const rawInput = isRecord(raw.rawInput) ? raw.rawInput : undefined;
  if (raw.kind === "execute") {
    const command = stringValue(rawInput?.command) ?? stringValue(raw.title) ?? name;
    const cwd = stringValue(rawInput?.cwd) ?? locationCwd(raw, fallbackCwd);
    return { kind: "command", command, cwd, status, output };
  }
  return { kind: "tool", name, status, output };
}

function planText(entries: unknown): string {
  if (!Array.isArray(entries)) return "";
  return entries.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.content !== "string") return [];
    return [`- [${stringValue(entry.status) ?? "pending"}] ${entry.content}`];
  }).join("\n");
}

interface TextStream {
  readonly key: string;
  readonly itemIdKey: string;
  readonly channel: "agentMessage" | "reasoning" | "plan";
  text: string;
  opened: boolean;
}

interface ToolStream {
  readonly key: string;
  shape: ToolShape;
  raw: Record<string, unknown>;
  opened: boolean;
}

export interface TranslatorOptions {
  readonly threadId: string;
  readonly nativeTurnId: string;
  readonly cwd: string;
  /** Notified for each `user_message_chunk` so the session can settle echo. */
  readonly onUserText?: (text: string) => void;
}

/** Stateful only for one native turn; `update` returns the deltas it implies. */
export class AcpDeltaTranslator {
  private readonly textStreams = new Map<string, TextStream>();
  private readonly tools = new Map<string, ToolStream>();
  private planOpen = false;
  private planText = "";

  constructor(private readonly options: TranslatorOptions) {}

  private base(): { scope: { threadId: string }; nativeTurnId: string } {
    return { scope: scope(this.options.threadId), nativeTurnId: this.options.nativeTurnId };
  }

  private openText(key: string, channel: TextStream["channel"]): BridgeDelta[] {
    const out: BridgeDelta[] = [];
    const existing = this.textStreams.get(key);
    if (existing !== undefined) return out;
    const stream: TextStream = { key, itemIdKey: key, channel, text: "", opened: false };
    this.textStreams.set(key, stream);
    out.push({
      ...this.base(),
      op: "item.open",
      nativeKey: key,
      shape: channel === "reasoning"
        ? { kind: "reasoning", text: "" }
        : channel === "plan" ? { kind: "plan", text: "" } : { kind: "agentMessage", text: "" },
    });
    stream.opened = true;
    return out;
  }

  private closeText(key: string): BridgeDelta[] {
    const stream = this.textStreams.get(key);
    if (stream === undefined) return [];
    this.textStreams.delete(key);
    if (stream.text.trim().length === 0) return [];
    return [{
      ...this.base(),
      op: "item.textClose",
      nativeKey: key,
      channel: stream.channel,
      text: stream.text,
    }];
  }

  private onChunk(
    raw: Record<string, unknown>,
    channel: TextStream["channel"],
    messageKey: string,
  ): BridgeDelta[] {
    const content = isRecord(raw.content) ? raw.content : undefined;
    const text = content?.type === "text" && typeof content.text === "string" ? content.text : "";
    if (text.length === 0) {
      return [{
        ...this.base(),
        op: "unhandled",
        reason: `ACP ${channel} chunk carried unsupported content`,
        source: "session/update",
      }];
    }
    const key = channel === "agentMessage" ? messageKey : channel;
    const out = this.openText(key, channel);
    const stream = this.textStreams.get(key)!;
    stream.text += text;
    out.push({ ...this.base(), op: "item.textDelta", nativeKey: key, channel, text });
    return out;
  }

  update(raw: Record<string, unknown>): BridgeDelta[] {
    const kind = stringValue(raw.sessionUpdate);
    switch (kind) {
      case "agent_message_chunk": {
        const messageId = stringValue(raw.messageId) ?? "assistant";
        return this.onChunk(raw, "agentMessage", `message:${messageId}`);
      }
      case "agent_thought_chunk":
        return this.onChunk(raw, "reasoning", "reasoning");
      case "user_message_chunk": {
        const content = isRecord(raw.content) ? raw.content : undefined;
        if (content?.type === "text" && typeof content.text === "string") this.options.onUserText?.(content.text);
        return [];
      }
      case "tool_call":
      case "tool_call_update": {
        const key = stringValue(raw.toolCallId);
        if (key === undefined) {
          return [{ ...this.base(), op: "unhandled", reason: "ACP tool update has no toolCallId", source: "session/update" }];
        }
        const out: BridgeDelta[] = [];
        const previous = this.tools.get(key);
        if (previous === undefined) {
          const shape = toolShape(raw, this.options.cwd);
          this.tools.set(key, { key, shape, raw, opened: true });
          out.push({ ...this.base(), op: "item.open", nativeKey: key, shape });
        } else {
          previous.raw = { ...previous.raw, ...raw };
          previous.shape = toolShape(previous.raw, this.options.cwd);
        }
        const current = this.tools.get(key);
        if (current !== undefined && current.shape.status !== "inProgress") {
          this.tools.delete(key);
          out.push({ ...this.base(), op: "item.close", nativeKey: key, shape: current.shape });
        }
        return out;
      }
      case "plan": {
        const text = planText(raw.entries);
        this.planText = text;
        const out: BridgeDelta[] = [];
        if (!this.planOpen) {
          this.planOpen = true;
          out.push({ ...this.base(), op: "item.open", nativeKey: "plan", shape: { kind: "plan", text: "" } });
        }
        out.push({ ...this.base(), op: "item.close", nativeKey: "plan", shape: { kind: "plan", text } });
        this.planOpen = false;
        return out;
      }
      case "usage_update": {
        const used = typeof raw.used === "number" ? raw.used : undefined;
        const size = typeof raw.size === "number" ? raw.size : undefined;
        if (used === undefined || size === undefined) {
          return [{ ...this.base(), op: "unhandled", reason: "ACP usage_update is missing used/size", source: "session/update" }];
        }
        return [{ ...this.base(), op: "contextWindow", usedTokens: used, modelContextWindow: size }];
      }
      case "current_mode_update":
        return [{
          ...this.base(),
          op: "extension.state",
          extensionKind: "acp.sessionMode",
          state: { currentModeId: raw.currentModeId ?? null },
        }];
      case "available_commands_update":
        return [{
          ...this.base(),
          op: "extension.state",
          extensionKind: "acp.commands",
          state: { availableCommands: Array.isArray(raw.availableCommands) ? raw.availableCommands : [] },
        }];
      case "config_option_update":
        return [{
          ...this.base(),
          op: "extension.state",
          extensionKind: "acp.configOptions",
          state: { configOptions: Array.isArray(raw.configOptions) ? raw.configOptions : [] },
        }];
      case "session_info_update":
        return [{
          ...this.base(),
          op: "extension.state",
          extensionKind: "acp.sessionInfo",
          state: { title: raw.title ?? null, updatedAt: raw.updatedAt ?? null },
        }];
      case "compaction_update":
      case "compaction_summary_chunk":
        return [{
          ...this.base(),
          op: "extension.state",
          extensionKind: "acp.compaction",
          state: { update: raw },
        }];
      case "plan_update":
      case "plan_removed":
        return [{
          ...this.base(),
          op: "extension.state",
          extensionKind: "acp.plan",
          state: { update: raw },
        }];
      default:
        return [{
          ...this.base(),
          op: "unhandled",
          reason: `unsupported ACP session update ${kind ?? "(missing sessionUpdate)"}`,
          source: "session/update",
        }];
    }
  }

  /** Close every open text/tool stream before the turn boundary. */
  closeAll(): BridgeDelta[] {
    const out: BridgeDelta[] = [];
    for (const key of [...this.textStreams.keys()]) out.push(...this.closeText(key));
    for (const tool of this.tools.values()) {
      out.push({
        ...this.base(),
        op: "item.close",
        nativeKey: tool.key,
        shape: tool.shape.status === "inProgress"
          ? { ...tool.shape, status: "failed" }
          : tool.shape,
      });
      if (tool.shape.status === "inProgress") {
        out.push({
          ...this.base(),
          op: "unhandled",
          reason: `tool ${tool.key} was still in progress at the ACP turn boundary`,
          source: "turn/boundary",
        });
      }
    }
    this.tools.clear();
    if (this.planOpen) {
      out.push({ ...this.base(), op: "item.close", nativeKey: "plan", shape: { kind: "plan", text: this.planText } });
      this.planOpen = false;
    }
    return out;
  }

  /** Deltas for a completed turn: close streams, mark main run idle, close turn. */
  finish(status: "completed" | "failed" | "interrupted"): BridgeDelta[] {
    return [
      ...this.closeAll(),
      { ...this.base(), op: "turn.mainRun", state: "idle" },
      { ...this.base(), op: "turn.close", nativeTurnId: this.options.nativeTurnId, status },
    ];
  }
}
