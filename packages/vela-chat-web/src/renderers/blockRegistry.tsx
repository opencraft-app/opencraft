import type { WebBlock } from "../adapters/toWebBlocks";
import { AgentWorkGroupRenderer } from "./blocks/AgentWorkGroupRenderer";
import { AgentWorkRenderer } from "./blocks/AgentWorkRenderer";
import { AssistantMarkdownRenderer } from "./blocks/AssistantMarkdownRenderer";
import { StatusRenderer } from "./blocks/StatusRenderer";
import { TurnMetaRenderer } from "./blocks/TurnMetaRenderer";
import { UserMessageRenderer } from "./blocks/UserMessageRenderer";
import { agentWorkVisualStatus } from "./blocks/agentWorkLabel";

export function renderWebBlock(block: WebBlock) {
  switch (block.kind) {
    case "user_message":
      return <UserMessageRenderer block={block} />;
    case "assistant_markdown":
      return <AssistantMarkdownRenderer block={block} />;
    case "turn_meta":
      return <TurnMetaRenderer block={block} />;
    case "agent_work":
      return <AgentWorkRenderer block={block} />;
    case "agent_work_group":
      return <AgentWorkGroupRenderer block={block} />;
    case "status":
      return agentWorkVisualStatus(block)
        ? <AgentWorkRenderer block={block} />
        : <StatusRenderer block={block} />;
  }
}
