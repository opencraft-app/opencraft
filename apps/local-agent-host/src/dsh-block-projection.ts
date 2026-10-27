import type { DshEvent } from "./dsh-client.js";

type Value = Record<string, any>;

/** Indexed native blocks supplement the imported envelope/turn interpreter.
 * This owner is shared by live projection and replay, and never mutates events.
 */
export class DshBlockProjection {
  private reasoning = new Map<number, Value>();
  private text = new Map<number, string>();
  private reasoningIndex: number | undefined;

  handle(event: DshEvent, active: Value, forward: (event: DshEvent) => void,
    notify: (method: string, params: Value) => void): boolean {
    const data = (event.data ?? {}) as Value;
    const chunk = data.chunk;
    const close = () => {
      forward({ ...event, type: "step/end", data: {} });
      this.reasoningIndex = undefined;
    };
    const complete = (index: number, text: string) => {
      const existing = this.reasoning.get(index);
      if (existing) {
        if (active.reasoningItem === existing) {
          active.reasoningText = text;
          close();
        } else if ((existing.content ?? []).join("") !== text) {
          // Authoritative correction updates the same Item, never a duplicate.
          existing.content = text ? [text] : [];
          notify("item/completed", { threadId: active.record.threadId,
            turnId: active.record.turn.id, item: existing, completedAtMs: event.time });
        }
      } else if (text) {
        close();
        forward({ ...event, type: "assistant/chunk", data: {
          chunk: { type: "reasoning-delta", index, text },
        } });
        this.reasoning.set(index, active.reasoningItem);
        close();
      }
    };
    if (event.type === "step/start" || event.type === "user/message") {
      this.reasoning.clear(); this.text.clear(); this.reasoningIndex = undefined;
      return false;
    }
    if (event.type === "assistant/chunk" && chunk) {
      const index = chunk.index ?? 0;
      if (chunk.type === "block-start") {
        if (chunk.blockType !== "reasoning" || this.reasoningIndex !== index) close();
        if (chunk.blockType === "text") this.text.set(index, "");
        return true;
      }
      if (chunk.type === "reasoning-delta") {
        if (this.reasoningIndex !== index) close();
        this.reasoningIndex = index;
        forward(event);
        if (active.reasoningItem) this.reasoning.set(index, active.reasoningItem);
        return true;
      }
      if (chunk.type === "text-delta") {
        close();
        this.text.set(index, (this.text.get(index) ?? "") + (chunk.text ?? ""));
        forward(event);
        return true;
      }
      if (chunk.type === "block-end") {
        if (chunk.block?.type === "reasoning") complete(index, chunk.block.text ?? "");
        else if (chunk.block?.type === "text") {
          close();
          this.text.set(index, chunk.block.text ?? "");
          const text = [...this.text].sort(([a], [b]) => a - b).map(([, value]) => value).join("");
          forward({ ...event, type: "assistant/message", data: {
            message: { content: [{ type: "text", text }] },
          } });
        }
        return true;
      }
    }
    if (event.type === "assistant/message" && Array.isArray(data.message?.content)) {
      data.message.content.forEach((block: Value, index: number) => {
        if (block.type === "reasoning") complete(index, block.text ?? "");
      });
      close();
      forward({ ...event, data: { ...data, message: { ...data.message,
        content: data.message.content.filter((block: Value) => block.type !== "reasoning"),
      } } });
      this.reasoning.clear(); this.text.clear();
      return true;
    }
    return false;
  }
}
