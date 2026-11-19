/** Personal conversation identity, independent of the selected model or Agent. */
export const conversationIconNames = [
  "chat",
  "folder",
  "chart",
  "book",
  "code",
  "terminal",
  "pencil",
  "palette",
  "globe",
  "target",
  "briefcase",
  "calendar",
  "lightning",
  "brain",
  "people",
  "tool",
  "image",
  "star",
] as const;
export type ConversationIconName = (typeof conversationIconNames)[number];
export const conversationColorNames = [
  "default",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
] as const;
export interface ConversationAppearance {
  readonly icon: ConversationIconName;
  readonly color: string;
}
export type ConversationAppearances = Readonly<Record<string, ConversationAppearance>>;
export function conversationAppearanceKey(scope: string, hostId: string, threadId: string): string {
  return JSON.stringify([scope, hostId, threadId]);
}
export function parseConversationAppearances(value: unknown): ConversationAppearances | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 4096) return null;
  const result: [string, ConversationAppearance][] = [];
  for (const [key, appearance] of entries) {
    if (!key || key.length > 4096 || !appearance || typeof appearance !== "object" || Array.isArray(appearance))
      return null;
    const { icon, color } = appearance as Record<string, unknown>;
    if (
      !conversationIconNames.includes(icon as ConversationIconName) ||
      typeof color !== "string" ||
      !(
        conversationColorNames.includes(color as (typeof conversationColorNames)[number]) ||
        /^#[0-9a-f]{6}$/i.test(color)
      )
    )
      return null;
    result.push([key, { icon: icon as ConversationIconName, color: color.toLowerCase() }]);
  }
  return Object.fromEntries(result);
}
