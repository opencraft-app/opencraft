import { userMessageCompareKey, type TimelineSourceItem, type TimelineSourceTurn } from "@opencraft/chat-core";

interface SteeringIdentity {
  readonly clientMessageId: string;
  readonly input: unknown;
}
export type SteeringAcknowledgementResolver = (turn: TimelineSourceTurn, state: SteeringIdentity) => number;

interface AcknowledgementIndex {
  readonly byClientId: Map<string, number>;
  readonly byInput: Map<string, Map<number, number>>;
}

/** Runtime-owned, derived lookup only. Source Item arrays are immutable snapshots;
 * optimistic projection replaces its array after inserting a local Item. Keys are
 * weak so replaced history is not retained by this index. No delivery truth lives here. */
export function createSteeringAcknowledgementResolver(): SteeringAcknowledgementResolver {
  const indices = new WeakMap<readonly TimelineSourceItem[], AcknowledgementIndex>();
  return (turn, state) => {
    let index = indices.get(turn.items);
    if (!index) {
      const byClientId = new Map<string, number>();
      const byInput = new Map<string, Map<number, number>>();
      let followsAssistantOutput = false;
      for (let position = 0; position < turn.items.length; position++) {
        const candidate = turn.items[position]!;
        if (candidate.type !== "userMessage" && candidate.type !== "steeringUserMessage") {
          if (candidate.type !== "hookPrompt") followsAssistantOutput = true;
          continue;
        }
        const data = candidate.payload;
        if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
        const payload = data as Readonly<Record<string, unknown>>;
        const clientId =
          typeof payload.clientId === "string"
            ? payload.clientId
            : typeof payload.clientUserMessageId === "string"
              ? payload.clientUserMessageId
              : null;
        if (clientId !== null) {
          if (!byClientId.has(clientId)) byClientId.set(clientId, position);
        } else if (followsAssistantOutput) {
          // Id-less reconstructed history may match content only after an
          // assistant-owned boundary, never the primary Composer message.
          const key = userMessageCompareKey(payload.content ?? payload.input);
          let counts = byInput.get(key.rawText);
          if (!counts) {
            counts = new Map();
            byInput.set(key.rawText, counts);
          }
          if (!counts.has(key.imageCount)) counts.set(key.imageCount, position);
        }
      }
      index = { byClientId, byInput };
      indices.set(turn.items, index);
    }
    const explicit = index.byClientId.get(state.clientMessageId);
    if (!index.byInput.size) return explicit ?? -1;
    const key = userMessageCompareKey(state.input);
    const reconstructed = index.byInput.get(key.rawText)?.get(key.imageCount);
    // Preserve the original first matching Item, even when an id-less match
    // precedes an explicit-id match. A different explicit id never falls back.
    if (explicit === undefined) return reconstructed ?? -1;
    return reconstructed === undefined ? explicit : Math.min(explicit, reconstructed);
  };
}
