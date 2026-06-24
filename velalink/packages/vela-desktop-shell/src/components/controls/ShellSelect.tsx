import type { ReactNode } from "react";
import { useCallback, useId, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import {
  type FloatingLayerPlacement,
  useControllableState,
  useDismissableLayer,
  useFloatingLayer,
  useListboxNavigation,
} from "../../../../vela-ui/src";

export interface ShellSelectOption {
  description?: string;
  disabled?: boolean;
  id: string;
  label: string;
  leading?: ReactNode;
}

export interface ShellSelectProps {
  ariaLabel: string;
  disabled?: boolean;
  density?: "field" | "compact";
  emptyLabel?: string;
  leading?: ReactNode;
  options: ShellSelectOption[];
  placement?: FloatingLayerPlacement;
  placeholder?: string;
  tone?: "neutral" | "accent";
  value?: string;
  onValueChange: (value: string) => void;
}

export function ShellSelect({
  ariaLabel,
  disabled = false,
  density = "field",
  emptyLabel = "No options",
  leading,
  options,
  placement = "bottom-end",
  placeholder = "Select",
  tone = "neutral",
  value,
  onValueChange,
}: ShellSelectProps) {
  const listboxId = useId();
  const [isOpen, setIsOpen] = useControllableState({
    defaultValue: false,
  });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const selectedIndex = options.findIndex((option) => option.id === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;
  const canUsePortal = typeof document !== "undefined";
  const close = useCallback(() => setIsOpen(false), [setIsOpen]);
  const open = useCallback(() => {
    if (!disabled) setIsOpen(true);
  }, [disabled, setIsOpen]);
  const selectIndex = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || option.disabled) return;
      onValueChange(option.id);
      close();
    },
    [close, onValueChange, options],
  );
  const { activeIndex, onKeyDown, setActiveIndex } = useListboxNavigation({
    isOpen,
    itemCount: options.length,
    onClose: close,
    onOpen: open,
    onSelectIndex: selectIndex,
    selectedIndex,
  });
  const popoverStyle = useFloatingLayer({
    anchorRef: triggerRef,
    boundaryPadding: 12,
    enabled: isOpen && canUsePortal,
    estimatedSize: {
      width: density === "compact" ? 360 : 280,
    },
    offset: 8,
    placement,
  });

  useDismissableLayer({
    enabled: isOpen,
    refs: [triggerRef, popoverRef],
    onDismiss: close,
  });

  const popover = useMemo(
    () => (
      <div
        className="vela-shell-select-popover vela-motion-popover"
        data-density={density}
        data-layer={canUsePortal ? "portal" : "inline"}
        data-state="open"
        data-tone={tone}
        ref={popoverRef}
        style={popoverStyle ?? undefined}
      >
        <div
          className="vela-shell-select-list"
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
        >
          {options.length === 0 ? (
            <div className="vela-shell-select-empty">{emptyLabel}</div>
          ) : (
            options.map((option, index) => (
              <button
                className="vela-shell-select-option"
                data-active={index === activeIndex ? "true" : undefined}
                key={option.id}
                type="button"
                role="option"
                aria-selected={option.id === value}
                disabled={option.disabled}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectIndex(index)}
              >
                <span className="vela-shell-select-option-leading">
                  {option.leading ?? null}
                </span>
                <span className="vela-shell-select-option-text">
                  <span className="vela-shell-select-option-label">{option.label}</span>
                  {option.description ? (
                    <span className="vela-shell-select-option-description">
                      {option.description}
                    </span>
                  ) : null}
                </span>
                <span className="vela-shell-select-check" aria-hidden>
                  {option.id === value ? <Check size={14} /> : null}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    ),
    [
      activeIndex,
      ariaLabel,
      canUsePortal,
      density,
      emptyLabel,
      listboxId,
      options,
      popoverStyle,
      selectIndex,
      setActiveIndex,
      tone,
      value,
    ],
  );

  return (
    <div className="vela-shell-select" data-density={density} data-tone={tone}>
      <button
        className="vela-shell-select-trigger"
        type="button"
        aria-label={ariaLabel}
        aria-controls={isOpen ? listboxId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        disabled={disabled}
        ref={triggerRef}
        onClick={() => setIsOpen((openValue) => !openValue)}
        onKeyDown={onKeyDown}
      >
        {leading ? (
          <span className="vela-shell-select-trigger-leading" aria-hidden>
            {leading}
          </span>
        ) : null}
        <span className="vela-shell-select-trigger-label">
          {selectedOption?.label ?? placeholder}
        </span>
        <ChevronDown size={15} aria-hidden />
      </button>
      {isOpen ? (canUsePortal ? createPortal(popover, document.body) : popover) : null}
    </div>
  );
}
