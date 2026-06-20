import type { WebBlock } from "../adapters/toWebBlocks";
import { ActivityRenderer } from "./blocks/ActivityRenderer";
import { AssistantMarkdownRenderer } from "./blocks/AssistantMarkdownRenderer";
import { StatusRenderer } from "./blocks/StatusRenderer";
import { UserMessageRenderer } from "./blocks/UserMessageRenderer";
import { activityVisualStatus } from "./blocks/activityLabel";

export function renderWebBlock(block: WebBlock) {
  switch (block.kind) {
    case "user_message":
      return <UserMessageRenderer block={block} />;
    case "assistant_markdown":
      return <AssistantMarkdownRenderer block={block} />;
    case "agent_work":
      return <ActivityRenderer block={block} />;
    case "status":
      return activityVisualStatus(block)
        ? <ActivityRenderer block={block} />
        : <StatusRenderer block={block} />;
  }
}
