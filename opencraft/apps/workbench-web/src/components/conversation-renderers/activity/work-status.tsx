import {
  formatWorkDuration,
  workStatusLabelText,
  type WorkStatusItem,
} from "@opencraft/chat-core";
import { useWorkStatusLabel } from "@opencraft/timeline-render-react";
import { ChevronRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

export function WorkStatusLabel({ item }: { readonly item: WorkStatusItem }) {
  const label = useWorkStatusLabel(item);
  return (
    <span className="thread-work-status__label" data-work-status={item.status}>
      {workStatusLabelText(label)}
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
  if (item !== null) return <WorkStatusLabel item={item} />;
  return (
    <span>
      {durationMs !== null
        ? `Worked for ${formatWorkDuration(durationMs)}`
        : `${count} previous message${count === 1 ? "" : "s"}`}
    </span>
  );
}

/** r3562 _A: the rule is a separate, full-width row BELOW the toggle. */
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
  readonly onToggle: () => void;
}) {
  return (
    <div className="thread-agent-activity__turn-header">
      <div>
        <button aria-expanded={open} onClick={onToggle} type="button">
          <span>
            <ActivityDisclosureLabel
              item={item}
              durationMs={durationMs}
              count={count}
            />
          </span>
          <ChevronRight className={open ? "is-open" : undefined} size={12} />
        </button>
      </div>
      <div className="thread-agent-activity__rule-row">
        <div className="thread-work-status__rule" />
      </div>
    </div>
  );
}

/** r3562 ok: a standalone work divider, not the outer disclosure animation. */
export function WorkStatusDivider({ item }: { readonly item: WorkStatusItem }) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.div
      className="thread-work-status"
      initial={{ opacity: 0, height: 0 }}
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
