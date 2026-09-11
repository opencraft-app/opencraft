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
  placement: "top" | "bottom";
};

const TOOLTIP_GAP = 8;
const VIEWPORT_MARGIN = 16;

export function ModelActionTooltip({ children, content }: { children: ReactNode; content?: string }) {
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
  }, []);

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

  if (!content) return <>{children}</>;

  return (
    <span
      ref={triggerRef}
      role="group"
      aria-label={content}
      aria-describedby={open ? tooltipId : undefined}
      className="inline-flex rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black/30"
      tabIndex={0}
      onMouseEnter={showTooltip}
      onMouseLeave={scheduleClose}
      onFocus={showTooltip}
      onBlur={scheduleClose}
      onKeyDown={handleKeyDown}
    >
      {children}
      {open && typeof document !== "undefined"
        ? createPortal(
            <span
              ref={tooltipRef}
              id={tooltipId}
              role="tooltip"
              className={`lightvela-agent-console-portal pointer-events-auto fixed z-[260] w-max max-w-[min(16rem,calc(100vw-2rem))] -translate-x-1/2 select-text rounded-md border border-[var(--border-subtle)] bg-white px-3 py-1.5 text-[11px] font-medium leading-relaxed text-[var(--text-primary)] shadow-[0_8px_24px_rgba(15,23,42,0.12)] ${position.placement === "top" ? "-translate-y-full" : ""}`}
              style={{ left: position.left, top: position.top }}
              onMouseEnter={showTooltip}
              onMouseLeave={scheduleClose}
            >
              {content}
              <span
                aria-hidden="true"
                className={`absolute left-1/2 size-2 -translate-x-1/2 rotate-45 border-[var(--border-subtle)] bg-white ${position.placement === "top" ? "top-full -translate-y-1/2 border-b border-r" : "bottom-full translate-y-1/2 border-l border-t"}`}
              />
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
