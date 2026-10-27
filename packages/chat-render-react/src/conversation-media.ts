import { resolveStandardChatResource } from "./resource-target";
import type { ChatResourceDecision } from "./contracts";

export interface ChatConversationMediaResolution {
  readonly decision: ChatResourceDecision;
  readonly directSource: string | null;
  readonly loadThroughHost: boolean;
}

/** One semantic decision for conversation images outside Markdown documents. */
export function resolveChatConversationMediaSource(
  source: string,
  cwd: string | null,
  directSource: string | null,
  hasHostLoader: boolean,
): ChatConversationMediaResolution {
  const decision = resolveStandardChatResource(source, { cwd, externalResourcePolicy: "allow" });
  const loadThroughHost = directSource === null
    && hasHostLoader
    && decision.allowed
    && decision.target !== null
    && (decision.kind === "file" || decision.kind === "workspace-file" || decision.kind === "resource");
  return { decision, directSource, loadThroughHost };
}
