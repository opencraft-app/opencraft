import type {
  AssistantTimelineFrame,
  CompactionTimelineBlock,
  TextTimelineBlock,
  TodoTimelineBlock,
} from "./timeline";
import type { CommandExecutionTimelineBlock } from "./timeline";
import { parseSkillPath } from "./skill-path";

export type ConversationDetailLevel =
  "STEPS_PROSE" | "STEPS_COMMANDS" | "STEPS_EXECUTION";

export function skillReadPresentation(
  block: CommandExecutionTimelineBlock,
  detailLevel: ConversationDetailLevel,
) {
  const action = block.actions.length === 1 ? block.actions[0] : undefined;
  if (action?.type !== "read") return null;
  const skill = parseSkillPath(action.path || action.name, block.cwd);
  if (!skill?.isSkillDefinitionFile) return null;
  const running = block.status === "running" || block.status === "pending";
  return {
    visible: !running || detailLevel === "STEPS_PROSE",
    summary: running && detailLevel === "STEPS_PROSE" ? "Reading" : "Read",
    detail: `${skill.skillName} skill`,
  };
}

export function compactionLabel(
  block: CompactionTimelineBlock,
  workMode = false,
): string {
  if (block.summary && block.completed) return block.summary;
  if (block.source === "manual")
    return block.completed ? "Context compacted" : "Compacting context";
  if (workMode)
    return block.completed
      ? "Optimized the conversation"
      : "Optimizing the conversation";
  return block.completed
    ? "Context automatically compacted"
    : "Context automatically compacting";
}

export function todoSummary(block: TodoTimelineBlock): string {
  const active = block.entries.findIndex(
    (entry) => entry.status === "in-progress",
  );
  const unfinished = block.entries.findIndex(
    (entry) => entry.status !== "complete",
  );
  const index =
    active >= 0
      ? active
      : unfinished >= 0
        ? unfinished
        : block.entries.length - 1;
  return `Step ${index + 1} / ${block.entries.length}`;
}

/** The final message owns action eligibility, independently of Turn failure. */
export function assistantMessageActions(frame: AssistantTimelineFrame): {
  readonly message: TextTimelineBlock;
  readonly copyText: string;
  readonly completed: boolean;
  readonly sentAtMs: number | null;
} | null {
  const messages = frame.blocks.filter(
    (block): block is TextTimelineBlock =>
      block.type === "text" && block.phase !== "commentary",
  );
  const message = messages[messages.length - 1];
  if (!message) return null;
  return {
    message,
    copyText: messages
      .map((block) => block.text)
      .join("\n\n")
      .trim(),
    completed: message.completed ?? !message.streaming,
    sentAtMs: message.sentAtMs ?? null,
  };
}
