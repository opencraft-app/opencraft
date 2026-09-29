import type { AsyncQuestion, TimelineSnapshot } from "./timeline";

export type AsyncQuestionState = "pending" | "sending" | "unconfirmed" | "answered" | "dismissed";

/** Codex's stable identity: JSON.stringify([tool name, AgentMessage item ID, index]). */
export function projectAsyncQuestions(messageId: string, value: unknown): readonly AsyncQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((entry, index): readonly AsyncQuestion[] => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const source = entry as Record<string, unknown>;
    const title = typeof source.title === "string" ? source.title.trim() : "";
    if (title.length === 0) return [];
    const options = Array.isArray(source.options)
      ? source.options.slice(0, 32).filter((option): option is string => typeof option === "string" && option.trim().length > 0 && option.length <= 512)
      : [];
    return [{
      id: JSON.stringify(["request_user_input_async", messageId, index]),
      title: title.slice(0, 4096),
      options,
    }];
  });
}

function boundedQuestionTitle(title: string): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let result = "";
  for (const character of title) {
    const size = encoder.encode(character).length;
    if (bytes + size > 512) break;
    bytes += size;
    result += character;
  }
  return result.replace(/[\n\r]/gu, " ");
}

/** A normal user submission, not an AppServer server-request response. */
export function renderAsyncQuestionReply(question: AsyncQuestion, answer: string): string {
  const text = answer.trim();
  if (text.length === 0) throw new Error("Question answer cannot be empty");
  const reply = [{
    questionItemId: question.id,
    question: boundedQuestionTitle(question.title),
    answer: text,
  }];
  const rendered = `<send_user_message_question_reply>\n${JSON.stringify(reply)}\n</send_user_message_question_reply>`;
  if ([...rendered].length > (1 << 20)) throw new Error("Answer is too long; shorten it before sending");
  return rendered;
}

export interface AsyncQuestionReply {
  readonly questionItemId: string;
  readonly question: string;
  readonly answer: string;
}

/** Recognize only Codex's complete reply envelope, including its IDE-context prefix. */
export function parseAsyncQuestionReply(text: string): readonly AsyncQuestionReply[] | null {
  let body = text.trim();
  if (body.startsWith("# Context from my IDE setup:\n")) {
    const marker = "\n## My request for Codex:\n";
    const index = body.lastIndexOf(marker);
    if (index < 0) return null;
    body = body.slice(index + marker.length).trim();
  }
  const open = "<send_user_message_question_reply>";
  const close = "</send_user_message_question_reply>";
  if (!body.startsWith(open) || !body.endsWith(close)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body.slice(open.length, -close.length)); }
  catch { return null; }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.length === 0 || entries.length > 16) return null;
  const replies = entries.flatMap((entry): readonly AsyncQuestionReply[] => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const source = entry as Record<string, unknown>;
    return typeof source.questionItemId === "string"
      && typeof source.question === "string"
      && typeof source.answer === "string"
      ? [{ questionItemId: source.questionItemId, question: source.question, answer: source.answer }]
      : [];
  });
  return replies.length === entries.length ? replies : null;
}

export function displayAsyncQuestionReply(text: string): string | null {
  const replies = parseAsyncQuestionReply(text);
  return replies === null ? null : replies.map((reply) => `> ${reply.question}\n\n${reply.answer}`).join("\n\n");
}

/** Derived from ordered Timeline Items, including another Client's accepted reply. */
export function deriveAsyncQuestionStates(timeline: Pick<TimelineSnapshot, "frames">): ReadonlyMap<string, AsyncQuestionState> {
  const states = new Map<string, AsyncQuestionState>();
  for (const frame of timeline.frames) {
    for (const block of frame.blocks) {
      if (block.type === "text") {
        for (const question of block.asyncQuestions ?? []) states.set(question.id, "pending");
        continue;
      }
      if (block.type !== "user-message" || block.messageKind === "hook-prompt") continue;
      if (block.deliveryStatus === "failed" || block.deliveryStatus === "not-sent") continue;
      const textParts = block.content.filter((part) => part.type === "text");
      const replies = block.content.length === 1 && textParts.length === 1
        ? parseAsyncQuestionReply(textParts[0]!.text)
        : null;
      if (replies !== null) {
        const next = block.deliveryStatus === "sending" ? "sending"
          : block.deliveryStatus === "unknown" ? "unconfirmed" : "answered";
        for (const reply of replies) if (states.has(reply.questionItemId)) states.set(reply.questionItemId, next);
      } else if (block.deliveryStatus !== "sending" && block.deliveryStatus !== "unknown") {
        for (const [id, state] of states) if (state === "pending") states.set(id, "dismissed");
      }
    }
  }
  return states;
}
