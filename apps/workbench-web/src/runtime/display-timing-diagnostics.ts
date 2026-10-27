import type { TimelineSnapshot } from "@opencraft/chat-core";

/** Counts only: the diagnostic transport never receives message identities or values. */
export function displayTimingCounts(timeline: TimelineSnapshot | null) {
  let messages = 0, timestamps = 0, workClocks = 0;
  for (const frame of timeline?.frames ?? []) {
    if (frame.workStatus?.type === "worked-for") workClocks++;
    for (const block of frame.blocks) {
      if (block.type !== "text" && block.type !== "user-message") continue;
      messages++;
      if (typeof block.sentAtMs === "number") timestamps++;
    }
  }
  return { messages, timestamps, workClocks, authoritative: Number(timeline?.authoritative === true) };
}

export function displayStorageFailure(error: unknown) {
  const name = typeof error === "object" && error !== null && "name" in error ? error.name : null;
  return name === "QuotaExceededError" ? 1 : name === "SecurityError" ? 2 : 3;
}

/** The exact bounded projection passed to the browser storage adapter. */
export function storedDisplayTimingCounts(value: string) {
  try {
    const messages = JSON.parse(value).messages as readonly Record<string, unknown>[];
    return { messages: messages.length,
      timestamps: messages.filter(message => typeof message.sentAtMs === "number").length,
      workClocks: messages.filter(message => message.workStatus != null).length };
  } catch { return { messages: 0, timestamps: 0, workClocks: 0 }; }
}
