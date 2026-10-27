import { ChevronRightIcon as ChevronRight } from "@opencraft/design-system-web/action-icons";
import {
  formatWorkDuration,
  type WorkStatusItem,
} from "@opencraft/chat-core";
import { useWorkStatusLabel } from "@opencraft/timeline-render-react";
import { useIntl } from "@opencraft/i18n/react";
import { defineMessages } from "@opencraft/i18n";

import { motion, useReducedMotion } from "motion/react";
import { useContext, useId } from "react";
import { ConversationEntryMotionContext } from "../../conversation/entry-motion";
import { OverlayDisclosureTrigger } from "../../overlay-disclosure-trigger";

const statusMessages = defineMessages({
  working: { id: "chat.working", defaultMessage: "Working" },
  workingFor: { id: "chat.workingFor", defaultMessage: "Working for {time}" },
  workedFor: { id: "chat.workedFor", defaultMessage: "Worked for {time}" },
  stoppedAfter: { id: "chat.stoppedAfter", defaultMessage: "You stopped after {time}" },
});

export function WorkStatusLabel({ item }: { readonly item: WorkStatusItem }) {
  const intl = useIntl();
  const label = useWorkStatusLabel(item, intl.locale);
  return (
    <span className="thread-work-status__label" data-work-status={item.status}>
      {intl.formatMessage(statusMessages[label.messageId], { time: label.time })}
    </span>
  );
}

export function ActivityDisclosureLabel({
  item,
  durationMs,
  count,
}: {
  readonly item: WorkStatusItem | null;
  readonly durationMs: number | null;
  readonly count: number;
}) {
  const intl = useIntl();
  if (item !== null) return <WorkStatusLabel item={item} />;
  return (
    <span data-work-duration={durationMs ?? undefined}>
      {durationMs !== null
        ? intl.formatMessage(statusMessages.workedFor, { time: formatWorkDuration(durationMs, intl.locale) })
        : intl.formatMessage({ id: "chat.previousMessages", defaultMessage: "{count, plural, one {# previous message} other {# previous messages}}" }, { count })}
    </span>
  );
}

/** The rule is a separate, full-width row BELOW the toggle. */
export function ActivityDisclosureHeader({
  item,
  durationMs,
  count,
  open,
  onToggle,
}: {
  readonly item: WorkStatusItem | null;
  readonly durationMs: number | null;
  readonly count: number;
  readonly open: boolean;
  readonly onToggle?: (anchor: HTMLButtonElement) => void;
}) {
  const labelId = useId();
  return (
    <div className="thread-agent-activity__turn-header">
      <OverlayDisclosureTrigger
        className="thread-agent-activity__turn-toggle"
        contentClassName="thread-agent-activity__turn-toggle-content"
        labelId={labelId}
        interactive={onToggle !== undefined}
        onToggle={(anchor) => onToggle?.(anchor)}
        open={open}
        reflowOwned
      >
          <span id={labelId}>
            <ActivityDisclosureLabel item={item} durationMs={durationMs} count={count} />
          </span>
          {onToggle ? <ChevronRight aria-hidden="true" className={open ? "is-open" : undefined} size={12} /> : null}
      </OverlayDisclosureTrigger>
      <div className="thread-agent-activity__rule-row">
        <div className="thread-work-status__rule" />
      </div>
    </div>
  );
}

/** A standalone work divider, not the outer disclosure animation. */
export function WorkStatusDivider({ item }: { readonly item: WorkStatusItem }) {
  const reducedMotion = useReducedMotion();
  const allowEntryMotion = useContext(ConversationEntryMotionContext);
  return (
    <motion.div
      className="thread-work-status"
      initial={allowEntryMotion ? { opacity: 0, height: 0 } : false}
      animate={{ opacity: 1, height: "auto" }}
      transition={{
        duration: reducedMotion ? 0 : 0.3,
        ease: [0.19, 1, 0.22, 1],
      }}
    >
      <div className="thread-work-status__content">
        <WorkStatusLabel item={item} />
        <div className="thread-work-status__rule" />
      </div>
    </motion.div>
  );
}
