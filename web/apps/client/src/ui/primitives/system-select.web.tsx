import type {CSSProperties, KeyboardEvent, RefObject} from "react";
import {useEffect, useRef} from "react";
import Check from "lucide-react-native/icons/check";
import {ListBox, ListBoxItem} from "react-aria-components/ListBox";
import {Popover} from "react-aria-components/Popover";
import type {TextStyle} from "react-native";
import {useUnistyles} from "react-native-unistyles";

import type {
  FocusableHandle,
  OverlayCloseReason,
  SystemSelectProps,
} from "./system-select.types";

export type {
  ControlledOverlayProps,
  FocusableHandle,
  OverlayCloseReason,
  OverlayTriggerProps,
  SystemSelectOption,
  SystemSelectProps,
} from "./system-select.types";

export function SystemSelect<T extends string>({
  accessibilityLabel,
  onChange,
  onOpenChange,
  open,
  options,
  overlayId,
  renderTrigger,
  value,
}: SystemSelectProps<T>) {
  const {theme} = useUnistyles();
  const triggerRef = useRef<HTMLElement>(null);
  const closingReason = useRef<OverlayCloseReason | null>(null);
  const selectedKeys = value ? new Set([value]) : new Set<string>();

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
          boxShadow: cssBoxShadow(theme.shadows.overlay),
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
        <div onKeyDownCapture={handleKeyDown}>
          <ListBox
            aria-label={accessibilityLabel}
            autoFocus
            id={overlayId}
            onSelectionChange={selection => {
              if (selection === "all") return;
              const key = [...selection][0];
              if (typeof key !== "string") return;
              const option = options.find(item => item.value === key);
              if (!option || option.disabled) return;
              onChange(option.value);
              close("selection", true);
            }}
            selectedKeys={selectedKeys}
            selectionMode="single"
            style={{outline: "none"}}
          >
            {options.map(option => (
              <ListBoxItem
                aria-label={option.accessibilityLabel ?? option.label}
                id={option.value}
                isDisabled={option.disabled}
                key={option.value}
                style={({isDisabled, isFocusVisible, isHovered, isPressed, isSelected}) => ({
                  ...cssTypography(theme.semantic.typography.body),
                  alignItems: "center",
                  background: isSelected
                    ? theme.semantic.color.actionTonalSurface
                    : isPressed
                      ? theme.semantic.color.interactivePressedSurface
                      : isHovered
                        ? theme.semantic.color.interactiveHoverSurface
                        : theme.semantic.color.surfaceTransparent,
                  borderRadius: theme.semantic.radius.compactControl,
                  color: isSelected
                    ? theme.semantic.color.actionTonalText
                    : theme.semantic.color.textPrimary,
                  cursor: isDisabled ? "not-allowed" : "default",
                  display: "flex",
                  gap: theme.spacing.sm,
                  minHeight: theme.recipes.control.rowHeight,
                  opacity: isDisabled ? theme.semantic.interaction.disabledOpacity : 1,
                  outline: isFocusVisible
                    ? `${theme.semantic.stroke.statusRing}px solid ${theme.semantic.color.borderFocus}`
                    : "none",
                  outlineOffset: -2,
                  padding: `0 ${theme.spacing.md}px`,
                  userSelect: "none",
                  ...theme.semantic.motion.transition.control,
                })}
                textValue={option.label}
              >
                {({isSelected}) => (
                  <>
                    <span style={{flex: 1, minWidth: 0}}>{option.label}</span>
                    <span aria-hidden style={{display: "flex", opacity: isSelected ? 1 : 0}}>
                      <Check
                        color={theme.semantic.color.iconAccent}
                        size={theme.semantic.icon.size.small}
                        strokeWidth={theme.semantic.icon.stroke.emphasis}
                      />
                    </span>
                  </>
                )}
              </ListBoxItem>
            ))}
          </ListBox>
        </div>
      </Popover>
    </>
  );
}

function cssBoxShadow(shadow: {
  color: string;
  offsetY: number;
  radius: number;
}): string {
  return `0 ${shadow.offsetY}px ${shadow.radius}px ${shadow.color}`;
}

function cssTypography(typography: TextStyle): CSSProperties {
  return {
    ...(typography as CSSProperties),
    lineHeight: typeof typography.lineHeight === "number"
      ? `${typography.lineHeight}px`
      : typography.lineHeight,
  };
}
