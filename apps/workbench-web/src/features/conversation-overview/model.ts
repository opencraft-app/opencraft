import type { AppServerTurn } from "@opencraft/appserver-protocol";
import type { SidebarThread } from "../../components/sidebar";

export interface RecentTurnPreview {
  readonly id: string;
  readonly user: string;
  readonly assistant: string;
}

export const conversationKey = (thread: Pick<SidebarThread, "connectionHostId" | "id">): string =>
  JSON.stringify([thread.connectionHostId, thread.id]);

export function attentionPriority(thread: SidebarThread): number {
  if (thread.status === "review" || thread.status === "error" || thread.schedule?.needsReview) return 0;
  if (thread.unread) return 1;
  if (thread.status === "running" || thread.goalActive) return 2;
  return thread.pinned ? 3 : 4;
}

export function orderConversations(threads: readonly SidebarThread[], recentOnly = false): SidebarThread[] {
  return [...threads].sort((a, b) => (recentOnly ? 0 : attentionPriority(a) - attentionPriority(b))
    || b.updatedAt - a.updatedAt || conversationKey(a).localeCompare(conversationKey(b)));
}

const excerpt = (text: string): string => text.trim().slice(0, 600);

/** Summary pages arrive newest-first. Present the last two exchanges in reading order. */
export function recentTurnPreviews(turns: readonly AppServerTurn[]): RecentTurnPreview[] {
  return turns.slice(0, 2).reverse().map(turn => {
    const items = turn.items ?? [];
    const user = items.find(item => item.type === "userMessage");
    const assistant = [...items].reverse().find(item => item.type === "agentMessage");
    return {
      id: turn.id,
      user: excerpt(Array.isArray(user?.content) ? user.content.flatMap(input =>
        input?.type === "text" && typeof input.text === "string" ? [input.text]
          : input?.type === "mention" && typeof input.name === "string" ? [input.name] : []).join("\n") : ""),
      assistant: excerpt(typeof assistant?.text === "string" ? assistant.text : ""),
    };
  });
}
