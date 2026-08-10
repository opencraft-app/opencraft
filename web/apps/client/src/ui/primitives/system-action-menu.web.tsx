import type {KeyboardEvent, RefObject} from "react";
import {useEffect, useRef} from "react";
import Check from "lucide-react-native/icons/check";
import {Menu, MenuItem} from "react-aria-components/Menu";
import {Popover} from "react-aria-components/Popover";
import {useUnistyles} from "react-native-unistyles";

import type {
  FocusableHandle,
  OverlayCloseReason,
} from "./system-select.types";
import type {
  SystemActionMenuItem,
  SystemActionMenuProps,
} from "./system-action-menu.types";

export type {
  SystemActionMenuItem,
  SystemActionMenuProps,
} from "./system-action-menu.types";

export function SystemActionMenu({
  accessibilityLabel,
  items,
  onAction,
  onOpenChange,
  open,
  overlayId,
  renderTrigger,
}: SystemActionMenuProps) {
  const {theme} = useUnistyles();
  const triggerRef = useRef<HTMLElement>(null);
  const closingReason = useRef<OverlayCloseReason | null>(null);

  useEffect(() => {
    if (open) closingReason.current = null;
  }, [open]);

  const focusTrigger = () => {
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const close = (reason: OverlayCloseReason, restoreFocus: boolean) => {
    if (closingReason.current) return;
    closingReason.current = reason;
    onOpenChange(false, reason);
    if (restoreFocus) focusTrigger();
  };
  const activate = (item: SystemActionMenuItem) => {
    if (item.disabled) return;
    onAction(item.id);
    close("action", true);
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
        data-vela-material="menu"
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
          height: "max-content",
          maxHeight: "calc(100vh - 16px)",
          maxWidth: "min(360px, calc(100vw - 16px))",
          minWidth: theme.recipes.overlay.accountMenuWidth,
          outline: "none",
          overflowX: "hidden",
          overflowY: "auto",
          padding: theme.spacing.xs,
          WebkitBackdropFilter: theme.semantic.material.blur,
          zIndex: theme.semantic.layer.modal,
        }}
        triggerRef={triggerRef as RefObject<Element>}
      >
        <div onKeyDownCapture={handleKeyDown}>
          <Menu
            aria-label={accessibilityLabel}
            autoFocus="first"
            id={overlayId}
            style={{display: "flex", flexDirection: "column", outline: "none"}}
          >
            {items.map((item, index) => {
              const groupBreak = index > 0 && item.groupId !== items[index - 1]?.groupId;
              return (
                <MenuItem
                  aria-checked={item.selectionKind ? Boolean(item.checked) : undefined}
                  id={item.id}
                  isDisabled={item.disabled}
                  key={item.id}
                  onAction={() => activate(item)}
                  style={({isDisabled, isFocusVisible, isHovered, isPressed}) => ({
                    ...(theme.semantic.typography.bodyCompact as React.CSSProperties),
                    alignItems: "center",
                    background: isPressed
                      ? theme.semantic.color.interactivePressedSurface
                      : isHovered
                        ? theme.semantic.color.interactiveHoverSurface
                        : theme.semantic.color.surfaceTransparent,
                    borderRadius: theme.semantic.radius.compactControl,
                    borderTop: groupBreak
                      ? `${theme.semantic.stroke.hairline}px solid ${theme.semantic.color.separator}`
                      : "none",
                    color: item.intent === "destructive"
                      ? theme.semantic.color.statusDangerText
                      : theme.semantic.color.textPrimary,
                    cursor: isDisabled ? "not-allowed" : "default",
                    display: "flex",
                    flex: "none",
                    gap: theme.spacing.sm,
                    minHeight: theme.recipes.overlay.menuRowHeight,
                    opacity: isDisabled ? theme.semantic.interaction.disabledOpacity : 1,
                    outline: isFocusVisible
                      ? `${theme.semantic.stroke.statusRing}px solid ${theme.semantic.color.borderFocus}`
                      : "none",
                    outlineOffset: -2,
                    padding: `0 ${theme.spacing.md}px`,
                    userSelect: "none",
                  })}
                  textValue={item.label}
                >
                  <span aria-hidden style={{display: "flex", width: theme.semantic.icon.size.small}}>
                    {item.selectionKind && item.checked ? (
                      <Check
                        color={theme.semantic.color.iconAccent}
                        size={theme.semantic.icon.size.small}
                        strokeWidth={theme.semantic.icon.stroke.emphasis}
                      />
                    ) : null}
                  </span>
                  <span style={{flex: 1, minWidth: 0}}>{item.label}</span>
                  {item.shortcutLabel ? (
                    <span style={{color: theme.semantic.color.textMuted}}>{item.shortcutLabel}</span>
                  ) : null}
                </MenuItem>
              );
            })}
          </Menu>
        </div>
      </Popover>
    </>
  );
}
