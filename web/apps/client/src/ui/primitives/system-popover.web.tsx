import type {KeyboardEvent, RefObject} from "react";
import {useEffect, useRef} from "react";
import {Popover} from "react-aria-components/Popover";
import {useUnistyles} from "react-native-unistyles";

import type {
  FocusableHandle,
  OverlayCloseReason,
} from "./system-select.types";
import type {SystemPopoverProps} from "./system-popover.types";

export type {SystemPopoverProps} from "./system-popover.types";

export function SystemPopover({
  accessibilityLabel,
  children,
  initialFocusId,
  onOpenChange,
  open,
  overlayId,
  renderTrigger,
}: SystemPopoverProps) {
  const {theme} = useUnistyles();
  const triggerRef = useRef<HTMLElement>(null);
  const closingReason = useRef<OverlayCloseReason | null>(null);

  useEffect(() => {
    if (!open) return;
    closingReason.current = null;
    if (!initialFocusId) return;
    requestAnimationFrame(() => document.getElementById(initialFocusId)?.focus());
  }, [initialFocusId, open]);

  const focusTrigger = () => {
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const close = (reason: OverlayCloseReason, restoreFocus: boolean) => {
    if (closingReason.current) return;
    closingReason.current = reason;
    onOpenChange(false, reason);
    if (restoreFocus) focusTrigger();
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close("escape", true);
    } else if (event.key === "Tab") {
      close("tab", false);
    }
  };
  const trigger = renderTrigger({
    accessibilityControls: overlayId,
    accessibilityExpanded: open,
    onPress: () => onOpenChange(!open),
    ref: triggerRef as RefObject<FocusableHandle>,
  });

  return (
    <>
      {trigger}
      <Popover
        aria-label={accessibilityLabel}
        isOpen={open}
        offset={8}
        onOpenChange={next => {
          if (!next && open && !closingReason.current) close("outside", false);
        }}
        placement="bottom start"
        shouldFlip
        style={{
          backdropFilter: theme.semantic.material.blur,
          background: theme.semantic.material.composerFill,
          border: `${theme.semantic.stroke.hairline}px solid ${theme.semantic.color.borderOverlay}`,
          borderRadius: theme.semantic.radius.overlay,
          boxShadow: `0 ${theme.shadows.overlay.offsetY}px ${theme.shadows.overlay.radius}px ${theme.shadows.overlay.color}`,
          boxSizing: "border-box",
          maxHeight: "min(640px, calc(100vh - 16px))",
          maxWidth: "min(480px, calc(100vw - 16px))",
          minWidth: 240,
          outline: "none",
          overflow: "auto",
          padding: theme.spacing.xs,
          WebkitBackdropFilter: theme.semantic.material.blur,
          zIndex: 1000,
        }}
        triggerRef={triggerRef as RefObject<Element>}
      >
        <div id={overlayId} onKeyDownCapture={handleKeyDown}>
          {children}
        </div>
      </Popover>
    </>
  );
}
