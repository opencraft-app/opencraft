// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
"use client";

import { createPortal } from "react-dom";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

type TooltipPosition = {
  left: number;
  top: number;
  placement: "top" | "bottom" | "right";
};

const TOOLTIP_GAP = 8;
const VIEWPORT_MARGIN = 16;

export function ModelActionTooltip({
  children,
  content,
  preserveWrapper = false,
  focusable = true,
  side = "auto",
}: {
  children: ReactNode;
  content?: string;
  preserveWrapper?: boolean;
  focusable?: boolean;
  side?: "auto" | "right";
}) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition>({ left: 0, top: 0, placement: "top" });

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const showTooltip = useCallback(() => {
    if (!content) return;
    cancelClose();
    setOpen(true);
  }, [cancelClose, content]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 120);
  }, [cancelClose]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const triggerRect = trigger.getBoundingClientRect();
    const tooltipRect = tooltipRef.current?.getBoundingClientRect();
    if (side === "right") {
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const halfHeight = (tooltipRect?.height ?? 0) / 2;
      setPosition({
        left: triggerRect.right + TOOLTIP_GAP,
        top: Math.min(
          Math.max(triggerRect.top + triggerRect.height / 2, VIEWPORT_MARGIN + halfHeight),
          Math.max(VIEWPORT_MARGIN + halfHeight, viewportHeight - VIEWPORT_MARGIN - halfHeight),
        ),
        placement: "right",
      });
      return;
    }
    const halfWidth = (tooltipRect?.width ?? 0) / 2;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const centeredLeft = triggerRect.left + triggerRect.width / 2;
    const left = Math.min(
      Math.max(centeredLeft, VIEWPORT_MARGIN + halfWidth),
      Math.max(VIEWPORT_MARGIN + halfWidth, viewportWidth - VIEWPORT_MARGIN - halfWidth),
    );
    const placement = triggerRect.top >= (tooltipRect?.height ?? 0) + TOOLTIP_GAP ? "top" : "bottom";
    setPosition({
      left,
      top: placement === "top" ? triggerRect.top - TOOLTIP_GAP : triggerRect.bottom + TOOLTIP_GAP,
      placement,
    });
  }, [side]);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  useEffect(() => {
    if (content) return;
    cancelClose();
    setOpen(false);
  }, [cancelClose, content]);

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "Escape") return;
    cancelClose();
    setOpen(false);
  };

  if (!content && !preserveWrapper) return <>{children}</>;

  const interactive = Boolean(content);

  return (
    <span
      ref={triggerRef}
      role={interactive ? "group" : undefined}
      aria-label={content || undefined}
      aria-describedby={open ? tooltipId : undefined}
      className={`inline-flex rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black/30 ${preserveWrapper ? "w-full" : ""}`}
      tabIndex={interactive && focusable ? 0 : undefined}
      onMouseEnter={interactive ? showTooltip : undefined}
      onMouseLeave={interactive ? scheduleClose : undefined}
      onFocus={interactive ? showTooltip : undefined}
      onBlur={interactive ? scheduleClose : undefined}
      onKeyDown={interactive ? handleKeyDown : undefined}
    >
      {children}
      {open && typeof document !== "undefined"
        ? createPortal(
            <span
              ref={tooltipRef}
              id={tooltipId}
              role="tooltip"
              className={position.placement === "right"
                ? "lv-agent-rail-tooltip pointer-events-auto fixed z-[260] max-w-[min(16rem,calc(100vw-2rem))] -translate-y-1/2 select-text"
                : `pointer-events-auto fixed z-[260] w-max max-w-[min(16rem,calc(100vw-2rem))] -translate-x-1/2 select-text rounded-md border border-[var(--border-subtle)] bg-white px-3 py-1.5 text-[11px] font-medium leading-relaxed text-[var(--text-primary)] shadow-[0_8px_24px_rgba(15,23,42,0.12)] ${position.placement === "top" ? "-translate-y-full" : ""}`}
              style={{ left: position.left, top: position.top }}
              onMouseEnter={showTooltip}
              onMouseLeave={scheduleClose}
            >
              {content}
              {position.placement !== "right" && <span
                aria-hidden="true"
                className={`absolute left-1/2 size-2 -translate-x-1/2 rotate-45 border-[var(--border-subtle)] bg-white ${position.placement === "top" ? "top-full -translate-y-1/2 border-b border-r" : "bottom-full translate-y-1/2 border-l border-t"}`}
              />}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
