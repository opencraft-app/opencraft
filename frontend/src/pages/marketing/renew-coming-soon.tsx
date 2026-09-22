import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

const TOOLTIP_GAP = 8;
const TOOLTIP_VIEWPORT_MARGIN = 12;
const TOOLTIP_MAX_WIDTH = 240;

type TooltipPlacement = "top" | "bottom";

export type RenewComingSoonTooltipPosition = {
  left: number;
  top: number;
  placement: TooltipPlacement;
};

export const isRenewalAvailableForRegion = (
  globalRegion: boolean,
  paidBillingEnabled: boolean,
): boolean => !globalRegion || paidBillingEnabled;

export const getRenewComingSoonTooltipPosition = ({
  triggerRect,
  tooltipRect,
  viewportWidth,
  viewportHeight,
}: {
  triggerRect: DOMRect;
  tooltipRect: DOMRect;
  viewportWidth: number;
  viewportHeight: number;
}): RenewComingSoonTooltipPosition => {
  const tooltipWidth = Math.min(
    tooltipRect.width || TOOLTIP_MAX_WIDTH,
    Math.max(0, viewportWidth - TOOLTIP_VIEWPORT_MARGIN * 2),
  );
  const halfWidth = tooltipWidth / 2;
  const centeredLeft = triggerRect.left + triggerRect.width / 2;
  const minLeft = TOOLTIP_VIEWPORT_MARGIN + halfWidth;
  const maxLeft = Math.max(minLeft, viewportWidth - TOOLTIP_VIEWPORT_MARGIN - halfWidth);
  const left = Math.min(Math.max(centeredLeft, minLeft), maxLeft);
  const tooltipHeight = tooltipRect.height || 0;
  const hasTopSpace = triggerRect.top - TOOLTIP_GAP - tooltipHeight >= TOOLTIP_VIEWPORT_MARGIN;

  if (hasTopSpace) {
    return {
      left,
      top: triggerRect.top - TOOLTIP_GAP,
      placement: "top",
    };
  }

  return {
    left,
    top: Math.max(
      TOOLTIP_VIEWPORT_MARGIN,
      Math.min(triggerRect.bottom + TOOLTIP_GAP, viewportHeight - TOOLTIP_VIEWPORT_MARGIN - tooltipHeight),
    ),
    placement: "bottom",
  };
};

export function RenewComingSoonButton({
  label,
  tooltip,
  icon,
  ariaLabel,
  className,
  tooltipClassName,
  onBlockedClick,
}: {
  label: string;
  tooltip: string;
  icon?: ReactNode;
  ariaLabel?: string;
  className?: string;
  tooltipClassName?: string;
  onBlockedClick?: () => void;
}) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<RenewComingSoonTooltipPosition>({
    left: 0,
    top: 0,
    placement: "top",
  });

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const updatePosition = useCallback(() => {
    const triggerRect = triggerRef.current?.getBoundingClientRect();
    const tooltipRect = tooltipRef.current?.getBoundingClientRect();
    if (!triggerRect || !tooltipRect) return;

    setPosition(getRenewComingSoonTooltipPosition({
      triggerRect,
      tooltipRect,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }));
  }, []);

  const showTooltip = useCallback(() => {
    clearCloseTimer();
    setOpen(true);
  }, [clearCloseTimer]);

  const closeTooltip = useCallback(() => {
    clearCloseTimer();
    setOpen(false);
  }, [clearCloseTimer]);

  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 120);
  }, [clearCloseTimer]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition, tooltip]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeTooltip();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeTooltip, open]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  const placementClass = position.placement === "top"
    ? "-translate-x-1/2 -translate-y-full"
    : "-translate-x-1/2 translate-y-0";
  const arrowClass = position.placement === "top"
    ? "absolute left-1/2 top-full size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-r border-b border-[var(--border-subtle)] bg-white"
    : "absolute bottom-full left-1/2 size-2 -translate-x-1/2 translate-y-1/2 rotate-45 border-l border-t border-[var(--border-subtle)] bg-white";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-disabled="true"
        aria-label={ariaLabel}
        aria-describedby={open ? tooltipId : undefined}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onBlockedClick?.();
          showTooltip();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            showTooltip();
          }
        }}
        onMouseEnter={showTooltip}
        onMouseLeave={scheduleClose}
        onFocus={showTooltip}
        onBlur={scheduleClose}
        className={cn(
          "inline-flex cursor-not-allowed items-center justify-center gap-1.5 rounded-full bg-black/10 px-5 py-2.5 text-sm font-semibold text-black/35 transition-colors",
          className,
        )}
      >
        {icon}
        {label}
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
          <span
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            className={cn(
              "pointer-events-auto fixed z-50 max-w-[min(240px,calc(100vw-24px))] select-text rounded-md border border-[var(--border-subtle)] bg-white px-3 py-1.5 text-[11px] font-medium leading-relaxed text-black/80 shadow-[0_8px_24px_rgba(15,23,42,0.12)]",
              placementClass,
              tooltipClassName,
            )}
            style={{ left: position.left, top: position.top }}
            onMouseEnter={showTooltip}
            onMouseLeave={scheduleClose}
          >
            {tooltip}
            <span aria-hidden="true" className={arrowClass} />
          </span>,
          document.body,
        )
        : null}
    </>
  );
}
