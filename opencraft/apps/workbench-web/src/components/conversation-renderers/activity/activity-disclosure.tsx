import { ChevronRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** Live and settled disclosure state are independent, matching Codex. */
export function useCodexActivityOpen(
  running: boolean,
  defaultExpanded = false,
): readonly [boolean, (next: boolean) => void] {
  const [runningCollapsed, setRunningCollapsed] = useState(false);
  const [settledExpanded, setSettledExpanded] = useState(defaultExpanded);
  const open = running ? !runningCollapsed : settledExpanded;
  const setOpen = useCallback((next: boolean) => {
    if (running) setRunningCollapsed(!next);
    else setSettledExpanded(next);
  }, [running]);
  return [open, setOpen];
}

/** Readable base text plus one 1s sweep every 4s. */
export function CadencedShimmer({
  active,
  children,
  className,
  id,
}: {
  readonly active: boolean;
  readonly children: ReactNode;
  readonly className?: string;
  readonly id?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!active || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const element = ref.current;
    if (element === null) return;
    let clearActiveTimer: number | undefined;
    const clearActive = () => {
      if (clearActiveTimer !== undefined) window.clearTimeout(clearActiveTimer);
      clearActiveTimer = undefined;
    };
    const sweep = () => {
      clearActive();
      element.classList.remove("is-shimmer-active");
      element.classList.add("is-shimmer-active");
      clearActiveTimer = window.setTimeout(() => {
        element.classList.remove("is-shimmer-active");
        clearActiveTimer = undefined;
      }, 1_000);
    };
    const initialTimer = window.setTimeout(sweep, 600);
    const interval = window.setInterval(sweep, 4_000);
    return () => {
      clearActive();
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
      element.classList.remove("is-shimmer-active");
    };
  }, [active]);
  const classes = [className, active ? "is-shimmering" : null].filter(Boolean).join(" ");
  return (
    <span className={classes || undefined} id={id} ref={active ? ref : undefined}>
      {children}
      {active ? <span aria-hidden="true" className="is-shimmering__sweep"><span className="is-shimmering__highlight">{children}</span></span> : null}
    </span>
  );
}

export interface ActivityDisclosureProps {
  readonly accessory?: ReactNode;
  readonly bodyVariant?: "default" | "group" | "grouped" | "unindented";
  readonly children?: ReactNode;
  readonly detail?: ReactNode;
  readonly icon: ReactNode;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly running: boolean;
  readonly status?: "running" | "completed" | "failed" | "interrupted";
  readonly summary: ReactNode;
  readonly trailing?: ReactNode;
  readonly unmountBodyWhenCollapsed?: boolean;
}

export function ActivityDisclosure({
  accessory,
  bodyVariant = "default",
  children,
  detail,
  icon,
  onOpenChange,
  open,
  running,
  status = running ? "running" : "completed",
  summary,
  trailing,
  unmountBodyWhenCollapsed = false,
}: ActivityDisclosureProps) {
  const prefersReducedMotion = useReducedMotion();
  const summaryId = useId();
  const hasBody = children !== null && children !== undefined;
  const [bodyMounted, setBodyMounted] = useState(!unmountBodyWhenCollapsed || open);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyHeightPx, setBodyHeightPx] = useState(0);
  useLayoutEffect(() => {
    if (open && !bodyMounted) setBodyMounted(true);
  }, [bodyMounted, open]);
  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (element === null || !bodyMounted) return;
    const measure = () => setBodyHeightPx((current) => {
      const next = element.scrollHeight;
      return current === next ? current : next;
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [bodyMounted]);
  return (
    <div className="thread-activity-item" data-body-variant={bodyVariant} data-open={open || undefined} data-status={status}>
      <div className="thread-activity-item__header" data-interactive={hasBody || undefined}>
        {hasBody ? (
          <button
            aria-expanded={open}
            aria-labelledby={summaryId}
            className="thread-activity-item__hit-target"
            onClick={() => {
              if (!open && unmountBodyWhenCollapsed) setBodyMounted(true);
              onOpenChange(!open);
            }}
            type="button"
          />
        ) : null}
        <span className="thread-activity-item__header-content">
          {icon == null ? null : <span className="thread-activity-item__icon">{icon}</span>}
          <CadencedShimmer active={running} className="thread-activity-item__summary" id={summaryId}>{summary}</CadencedShimmer>
          {detail ? <span className="thread-activity-item__detail">{detail}</span> : null}
          {trailing ? <span className="thread-activity-item__trailing">{trailing}</span> : null}
          {accessory ? <span className="thread-activity-item__accessory">{accessory}</span> : null}
          {hasBody ? <ChevronRight aria-hidden="true" className="thread-activity-item__chevron" size={13} /> : null}
        </span>
      </div>
      {hasBody ? (
        <motion.div
          animate={{ height: open ? bodyHeightPx : 0, opacity: open ? 1 : 0 }}
          aria-hidden={!open}
          className="thread-activity-item__body-clip"
          initial={false}
          inert={!open}
          onAnimationComplete={() => {
            if (!open && unmountBodyWhenCollapsed) setBodyMounted(false);
          }}
          style={{ overflow: open ? "visible" : "hidden", pointerEvents: open ? "auto" : "none" }}
          transition={{ duration: prefersReducedMotion ? 0 : 0.3, ease: [0.19, 1, 0.22, 1] }}
        >
          <div className="thread-activity-item__body" ref={bodyRef}>{bodyMounted ? children : null}</div>
        </motion.div>
      ) : null}
    </div>
  );
}
