import { ChevronRightIcon as ChevronRight } from "@opencraft/design-system-web/action-icons";
import React, { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { motion, useReducedMotion } from "motion/react";
import { ActivityRowContent } from "./conversation-renderers/activity/activity-row-content";
import { OverlayDisclosureTrigger } from "./overlay-disclosure-trigger";
import { useDisclosureHeight } from "./use-disclosure-height";
import { useDisclosureReflow } from "./use-disclosure-reflow";

export type AgentActivityDisclosurePhase = "collapsed" | "opening" | "expanded" | "closing";
export type AgentActivityDisclosureEvent = "toggle" | "animation-frame" | "animation-complete" | "disable";
export type AgentActivitySummaryTransition = "static" | "immediate" | "deferred";


export function reduceAgentActivityDisclosurePhase(
  phase: AgentActivityDisclosurePhase,
  event: AgentActivityDisclosureEvent,
): AgentActivityDisclosurePhase {
  if (event === "disable") return "collapsed";
  if (event === "toggle") {
    const toggled: Record<AgentActivityDisclosurePhase, AgentActivityDisclosurePhase> = {
      collapsed: "opening", opening: "closing", expanded: "closing", closing: "expanded",
    };
    return toggled[phase];
  }
  if (phase === "opening" && event === "animation-frame") return "expanded";
  if (phase === "closing" && event === "animation-complete") return "collapsed";
  return phase;
}

export function AgentActivityGroupDisclosure({
  canExpand = true, children, defaultExpanded = false, collapsed, icon,
  onExpand, onCollapsedChange, shouldAnimateInitialCollapse = false,
  summary, summaryKey, summaryTransition = "static", running = false, hasRunningRows = false, standalone = false,
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
  running?: boolean;
  hasRunningRows?: boolean;
  standalone?: boolean;
}) {
  const reduced = useReducedMotion();
  const labelId = useId();
  const [phase, setPhase] = useState<AgentActivityDisclosurePhase>(() => {
    if (!canExpand) return "collapsed";
    if (collapsed === false || (collapsed === undefined && defaultExpanded)) return "expanded";
    // Lazy bodies have no prior visible layout to collapse. Restore their
    // folded state immediately instead of exposing commands for one paint.
    return shouldAnimateInitialCollapse && typeof children !== "function" ? "closing" : "collapsed";
  });
  const previousCollapsed = useRef(collapsed);
  const previousCanExpand = useRef(canExpand);
  const reflow = useDisclosureReflow();
  const height = useDisclosureHeight(phase === "expanded" ? "auto" : 0);
  const open = phase === "opening" || phase === "expanded";
  const bodyExpanded = standalone || open;

  useEffect(() => {
    if (!canExpand) { reflow.cancel(); setPhase("collapsed"); }
    else if ((previousCollapsed.current !== collapsed || previousCanExpand.current !== canExpand) && collapsed !== undefined) {
      setPhase(current => collapsed ? current === "collapsed" ? current : "closing" : "expanded");
    }
    previousCollapsed.current = collapsed;
    previousCanExpand.current = canExpand;
  }, [canExpand, collapsed, reflow.cancel]);

  useEffect(() => {
    if (phase !== "opening") return;
    const frame = requestAnimationFrame(() => setPhase(current => reduceAgentActivityDisclosurePhase(current, "animation-frame")));
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  // Live text for this key need not replace its committed snapshot while a
  // later key waits for the next summary slot.
  const [label, setLabel] = useState({ key: summaryKey, content: summary });
  const lastLabelCommit = useRef(Date.now());
  useEffect(() => {
    if (label.key === summaryKey) return;
    const remaining = 1000 - (Date.now() - lastLabelCommit.current);
    if (summaryTransition !== "deferred" || remaining <= 0) {
      lastLabelCommit.current = Date.now();
      setLabel({ key: summaryKey, content: summary });
      return;
    }
    const timer = setTimeout(() => {
      lastLabelCommit.current = Date.now();
      setLabel({ key: summaryKey, content: summary });
    }, remaining);
    return () => clearTimeout(timer);
  }, [summary, summaryKey, summaryTransition, reduced, label.key]);

  const toggle = (anchor: HTMLButtonElement) => {
    reflow.begin(anchor);
    const next = reduceAgentActivityDisclosurePhase(phase, "toggle");
    const nextOpen = next === "opening" || next === "expanded";
    setPhase(next);
    if (nextOpen) onExpand?.();
    onCollapsedChange?.(!nextOpen);
  };
  return (
    <div className="thread-activity-item thread-agent-activity__group-disclosure"
      data-conversation-row="activity" data-body-variant="group"
      style={standalone ? { display: "contents" } : undefined}
      data-disclosure-phase={phase} data-open={open || undefined}>
      {standalone ? null : <OverlayDisclosureTrigger
        className="thread-activity-item__header" contentClassName="thread-activity-item__header-content"
        buttonClassName="thread-activity-item__hit-target" interactive={canExpand}
        labelId={labelId} open={open} onToggle={toggle} reflowOwned>
        <ActivityRowContent icon={icon} running={running}
          iconRunning={running && !(phase === "expanded" && hasRunningRows)} summaryId={labelId}
          summary={summaryTransition === "static" ? summary : <span className="thread-agent-activity__deferred-summary">{label.key === summaryKey || summaryTransition === "immediate" ? summary : label.content}</span>} />
        {canExpand ? <ChevronRight size={13} className="thread-activity-item__chevron" aria-hidden="true" /> : null}
      </OverlayDisclosureTrigger>}
      {standalone || phase !== "collapsed" ? (
        <motion.div className="thread-activity-item__body-clip" data-disclosure-phase={phase}
          aria-hidden={!(standalone || phase === "expanded")} inert={!(standalone || phase === "expanded")} initial={false}
          style={{ display: standalone ? "contents" : undefined, height, overflow: "hidden", pointerEvents: standalone || phase === "expanded" ? "auto" : "none" }}
          animate={{ height: standalone || phase === "expanded" ? "auto" : 0, opacity: standalone || phase === "expanded" ? 1 : 0 }}
          transition={{ duration: standalone || reduced ? 0 : 0.15, ease: [0.4, 0, 0.2, 1] }}
          onAnimationComplete={() => {
            setPhase(current => reduceAgentActivityDisclosurePhase(current, "animation-complete"));
            reflow.complete();
          }}>
          <div className="thread-activity-item__body" style={standalone ? { display: "contents" } : undefined}>{typeof children === "function" ? children() : children}</div>
        </motion.div>
      ) : null}
    </div>
  );
}
