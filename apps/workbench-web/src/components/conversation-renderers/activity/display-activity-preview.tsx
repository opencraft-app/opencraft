import { useContext } from "react";
import type { TimelineBlockRendererProps } from "@opencraft/timeline-render-react";
import { formatToolDuration, skillReadPresentation } from "@opencraft/chat-core";
import { useIntl } from "@opencraft/i18n/react";
import { ConversationDetailContext } from "../render-contexts";
import { ActivityDisclosure } from "./activity-disclosure";
import { activityIcon } from "./activity-icon";
const inert = () => {};

/** Same row geometry, without a detail loader, command, approval or app surface. */
export function DisplayActivityPreview({ block }: TimelineBlockRendererProps) {
  const detailLevel = useContext(ConversationDetailContext),
    intl = useIntl();
  if (!("displayPreview" in block) || !block.displayPreview) return null;
  const preview = block.displayPreview,
    p = preview.presentation;
  const skill = block.type === "command-execution" ? skillReadPresentation(block, detailLevel) : null;
  if (skill?.visible === false) return null;
  const terminal =
    block.type === "command-execution" && !(block.actions.length === 1 && block.actions[0]?.type !== "unknown");
  const elapsed = p.durationMs === null ? null : formatToolDuration(p.durationMs, intl.locale);
  const summary = terminal
    ? `${preview.commandSummary ?? p.summary}${elapsed ? ` ${p.state === "interrupted" ? "after" : "in"} ${elapsed}` : ""}`
    : (skill?.summary ?? p.summary);
  return (
    <div data-conversation-row="activity" data-display-activity={block.id}>
      <ActivityDisclosure
        icon={activityIcon(p.icon)}
        summary={summary}
        detail={skill?.detail ?? p.detail}
        running={false}
        status={p.state}
        open={false}
        onOpenChange={inert}
      />
    </div>
  );
}
