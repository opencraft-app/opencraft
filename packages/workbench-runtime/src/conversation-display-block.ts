import type { ReasoningTimelineBlock, TextTimelineBlock, UserMessageTimelineBlock } from "@opencraft/chat-core";

/** The cache stores renderer input, not a second transcript made from excerpts. */
export type ConversationDisplayBlock = TextTimelineBlock | ReasoningTimelineBlock | UserMessageTimelineBlock;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown): value is string => typeof value === "string";
const nullableString = (value: unknown): value is string | null => value === null || string(value);
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const nullableNumber = (value: unknown): value is number | null => value === null || number(value);
const clock = (value: unknown): number | null => number(value) ? value : null;
const member = (value: unknown, values: readonly unknown[]) => values.includes(value);

/** Validate persisted presentation data at its storage boundary. No actions,
 * requests, Replica cursors or live execution state are restored here. */
export function parseConversationDisplayBlock(value: unknown): ConversationDisplayBlock | null {
  const b = record(value);
  if (!b || !string(b.id) || b.id.length > 256) return null;
  const base = { id: b.id, sourceItemIds: [] };
  if (b.type === "text") {
    if (!string(b.text) || !member(b.phase, [undefined, null, "commentary", "final_answer"])
      || !member(b.delivery, [undefined, null, "async"])
      || !member(b.completed, [undefined, true, false])
      || !member(b.hasStructuredOutput, [undefined, true, false])) return null;
    if (b.asyncQuestions !== undefined && (!Array.isArray(b.asyncQuestions) || b.asyncQuestions.length > 16
      || b.asyncQuestions.some(value => {
        const q = record(value);
        return !q || !string(q.id) || !string(q.title) || !Array.isArray(q.options)
          || q.options.length > 32 || !q.options.every(string);
      }))) return null;
    // The discriminated data above is validated; never spread unknown fields.
    const text = b as unknown as TextTimelineBlock;
    return { ...base, type: "text", text: text.text, streaming: false, phase: text.phase,
      completed: text.completed, sentAtMs: clock(text.sentAtMs), delivery: text.delivery,
      asyncQuestions: text.asyncQuestions?.map(q => ({ id: q.id, title: q.title, options: [...q.options] })),
      hasStructuredOutput: text.hasStructuredOutput };
  }
  if (b.type === "reasoning") {
    if (!string(b.summary) || !nullableString(b.detail)) return null;
    return { ...base, type: "reasoning", summary: b.summary, detail: b.detail, streaming: false };
  }
  if (b.type !== "user-message" || !string(b.message) || !Array.isArray(b.content) || !Array.isArray(b.attachments)
    || !member(b.messageKind, ["user", "steering", "hook-prompt"]) || !nullableString(b.clientId)
    || !member(b.steeringStatus, [null, "pending", "accepted", "declined", "cancelled"])
    || !member(b.deliveryStatus, [null, "sending", "sent", "not-sent", "failed", "unknown"])
    || !number(b.commentCount)
    || ["referencesPriorConversation", "reviewMode", "pullRequestFixMode", "autoResolveSync", "goal", "hookFeedback", "hasExternalAttachments"]
      .some(key => typeof b[key] !== "boolean")) return null;
  for (const value of b.content) {
    const p = record(value);
    if (!p) return null;
    switch (p.type) {
      case "text":
        if (!string(p.text) || !Array.isArray(p.textElements) || p.textElements.some(value => {
          const e = record(value), range = record(e?.byteRange);
          return !e || !range || !number(range.start) || !number(range.end)
            || range.end < range.start || !nullableString(e.placeholder);
        })) return null;
        break;
      case "image": case "local-image":
        if (!string(p.source) || !nullableString(p.detail)) return null;
        break;
      case "audio": case "local-audio": if (!string(p.source)) return null; break;
      case "skill": case "mention": if (!string(p.name) || !string(p.path)) return null; break;
      default: return null;
    }
  }
  for (const value of b.attachments) {
    const a = record(value);
    if (!a || !string(a.id) || !nullableString(a.target)) return null;
    switch (a.type) {
      case "file": if (!string(a.name) || !nullableString(a.mimeType) || !nullableNumber(a.startLine) || !nullableNumber(a.endLine)) return null; break;
      case "comment": if (!string(a.label) || !nullableString(a.body) || !nullableNumber(a.line)) return null; break;
      case "mcp-context": if (!string(a.label) || !nullableString(a.provider)) return null; break;
      default: return null;
    }
  }
  const user = b as unknown as UserMessageTimelineBlock;
  const sender = record(b.sender);
  return { ...base, type: "user-message", message: user.message,
    content: user.content, attachments: user.attachments, messageKind: user.messageKind,
    clientId: user.clientId, steeringStatus: user.steeringStatus, sentAtMs: clock(user.sentAtMs),
    deliveryStatus: user.deliveryStatus,
    sender: sender?.kind === "employee" && string(sender.loginName) && sender.loginName.trim() && sender.loginName.length <= 256
      ? { kind: "employee", loginName: sender.loginName } : null,
    referencesPriorConversation: user.referencesPriorConversation, reviewMode: user.reviewMode,
    pullRequestFixMode: user.pullRequestFixMode, autoResolveSync: user.autoResolveSync,
    goal: user.goal, hookFeedback: user.hookFeedback, commentCount: user.commentCount,
    hasExternalAttachments: user.hasExternalAttachments };
}
