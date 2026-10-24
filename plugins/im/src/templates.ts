import { parseConversationRef } from "@opencraft/appserver-protocol/collaboration";
export const sourceRoute = `function route(event) {
  if (event.chat.threadId) {
    return { key: ["thread", event.chat.id, event.chat.threadId] };
  }
  return { key: [event.chat.type, event.chat.id, event.sender.actorId] };
}`;
export function stewardRoute(reference: string) {
  if (!parseConversationRef(reference)) throw new Error("invalid_conversation");
  return `function route(event) {\n  return { conversationRef: ${JSON.stringify(reference)} };\n}`;
}

/** Derive preset presentation from exact generated source, with no second policy state. */
export function stewardReference(source: string | null): string | null {
  if (!source) return null;
  const literal = source.match(/conversationRef: ("(?:[^"\\]|\\.)*")/u)?.[1];
  if (!literal) return null;
  try {
    const ref = JSON.parse(literal);
    return parseConversationRef(ref) && source === stewardRoute(ref)
      ? ref
      : null;
  } catch {
    return null;
  }
}
