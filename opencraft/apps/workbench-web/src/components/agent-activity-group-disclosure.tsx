import { ChevronRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { OverlayDisclosureTrigger } from "./overlay-disclosure-trigger";
import { useDisclosureReflow } from "./use-disclosure-reflow";
import { useDisclosureHeight } from "./use-disclosure-height";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

export type AgentActivityDisclosurePhase = "collapsed" | "opening" | "expanded" | "closing";
export type AgentActivityDisclosureEvent = "toggle" | "animation-frame" | "animation-complete" | "disable";
export type AgentActivitySummaryTransition = "static" | "immediate" | "deferred";

const SUMMARY_DEFER_MS = 1_000;

export function reduceAgentActivityDisclosurePhase(
  phase: AgentActivityDisclosurePhase,
  event: AgentActivityDisclosureEvent,
): AgentActivityDisclosurePhase {
  if (event === "disable") return "collapsed";
  if (event === "animation-frame") return phase === "opening" ? "expanded" : phase;
  if (event === "animation-complete") return phase === "closing" ? "collapsed" : phase;
  if (phase === "opening" || phase === "expanded") return "closing";
  if (phase === "closing") return "expanded";
  return "opening";
}

function DeferredActivitySummary({
  children,
  summaryKey,
  transition,
}: {
  children: ReactNode;
  summaryKey: string;
  transition: Exclude<AgentActivitySummaryTransition, "static">;
}) {
  const [committed, setCommitted] = useState(() => ({ key: summaryKey, node: children }));
  const lastCommitAt = useRef<number | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const now = Date.now();
    lastCommitAt.current ??= now;
    if (committed.key === summaryKey) return;
    const next = { key: summaryKey, node: children };
    const commit = () => {
      timer.current = null;
      lastCommitAt.current = Date.now();
      setCommitted(next);
    };
    if (transition === "immediate") {
      if (timer.current !== null) window.clearTimeout(timer.current);
      commit();
      return;
    }
    const remaining = SUMMARY_DEFER_MS - (now - lastCommitAt.current);
    if (remaining <= 0) {
      commit();
      return;
    }
    timer.current = window.setTimeout(commit, remaining);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [children, committed.key, summaryKey, transition]);

  const visible = transition === "immediate" || committed.key === summaryKey
    ? children
    : committed.node;
  return <span className="thread-agent-activity__deferred-summary">{visible}</span>;
}

/**
 * Group-level disclosure reconstructed from Codex r2440's phase machine.
 *
 * It deliberately does not observe or tween scrollHeight. Once open, height
 * is `auto`, so streaming descendants grow as ordinary layout and the outer
 * Turn virtualizer receives one authoritative measurement per content change.
 */
export function AgentActivityGroupDisclosure({
  canExpand = true,
  children,
  defaultExpanded = false,
  collapsed,
  icon,
  onExpand,
  onCollapsedChange,
  shouldAnimateInitialCollapse = false,
  summary,
  summaryKey,
  summaryTransition = "static",
}: {
  canExpand?: boolean;
  children: ReactNode | (() => ReactNode);
  defaultExpanded?: boolean;
  collapsed?: boolean;
  icon?: ReactNode;
  onExpand?: () => void;
  onCollapsedChange?: (collapsed: boolean) => void;
  shouldAnimateInitialCollapse?: boolean;
  summary: ReactNode;
  summaryKey: string;
  summaryTransition?: AgentActivitySummaryTransition;
}) {
  const reduceMotion = useReducedMotion();
  const reflow = useDisclosureReflow();
  const summaryId = useId();
  const [phase, setPhase] = useState<AgentActivityDisclosurePhase>(() => {
    if (!canExpand) return "collapsed";
    if (collapsed === false || (collapsed === undefined && defaultExpanded)) return "expanded";
    return shouldAnimateInitialCollapse && typeof children !== "function"
      ? "closing"
      : "collapsed";
  });
  const expanded = phase === "opening" || phase === "expanded";
  const fullyExpanded = phase === "expanded";
  const animatedHeight = useDisclosureHeight(fullyExpanded ? "auto" : 0);

  useEffect(() => {
    if (phase !== "opening") return;
    const frame = window.requestAnimationFrame(() => {
      setPhase((current) => reduceAgentActivityDisclosurePhase(current, "animation-frame"));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [phase]);

  useEffect(() => {
    if (!canExpand) {
      reflow.cancel();
      setPhase((current) => reduceAgentActivityDisclosurePhase(current, "disable"));
    }
  }, [canExpand, reflow.cancel]);

  // The View owns the user's choice; this component only owns its animation.
  // Restore that choice when an outer work disclosure remounts this group.
  useEffect(() => {
    if (!canExpand || collapsed === undefined) return;
    setPhase(current => {
      const currentlyExpanded = current === "opening" || current === "expanded";
      return currentlyExpanded === !collapsed
        ? current
        : reduceAgentActivityDisclosurePhase(current, "toggle");
    });
  }, [canExpand, collapsed]);

  const toggle = useCallback((anchor: HTMLButtonElement) => {
    reflow.begin(anchor);
    if (!expanded) onExpand?.();
    onCollapsedChange?.(expanded);
    setPhase((current) => reduceAgentActivityDisclosurePhase(current, "toggle"));
  }, [expanded, onExpand, onCollapsedChange, reflow.begin]);

  const visibleSummary = summaryTransition === "static"
    ? summary
    : (
      <DeferredActivitySummary summaryKey={summaryKey} transition={summaryTransition}>
        {summary}
      </DeferredActivitySummary>
    );
  const body = canExpand && phase !== "collapsed"
    ? (
      <motion.div
        animate={fullyExpanded ? { height: "auto", opacity: 1 } : { height: 0, opacity: 0 }}
        aria-hidden={!fullyExpanded}
        className="thread-activity-item__body-clip"
        data-disclosure-phase={phase}
        initial={false}
        inert={!fullyExpanded}
        onAnimationComplete={(definition) => {
          if (phase === "opening" || typeof definition !== "object" || Array.isArray(definition)
            || definition.height !== (fullyExpanded ? "auto" : 0)) return;
          reflow.complete();
          setPhase((current) => reduceAgentActivityDisclosurePhase(current, "animation-complete"));
        }}
        style={{ height: animatedHeight, overflow: "hidden", pointerEvents: fullyExpanded ? "auto" : "none" }}
        transition={{ duration: reduceMotion ? 0 : 0.3, ease: [0.19, 1, 0.22, 1] }}
      >
        <div className="thread-activity-item__body">
          {typeof children === "function" ? children() : children}
        </div>
      </motion.div>
    )
    : null;

  return (
    <div
      className="thread-activity-item thread-agent-activity__group-disclosure"
      data-body-variant="group"
      data-disclosure-phase={phase}
      data-open={expanded || undefined}
    >
      <OverlayDisclosureTrigger
        buttonClassName="thread-activity-item__hit-target"
        className="thread-activity-item__header"
        contentClassName="thread-activity-item__header-content"
        interactive={canExpand}
        labelId={summaryId}
        onToggle={toggle}
        open={expanded}
        reflowOwned
      >
          {icon == null ? null : <span className="thread-activity-item__icon">{icon}</span>}
          <span className="thread-activity-item__summary" id={summaryId}>{visibleSummary}</span>
          {canExpand ? <ChevronRight aria-hidden="true" className="thread-activity-item__chevron" size={13} /> : null}
      </OverlayDisclosureTrigger>
      {body}
    </div>
  );
}
