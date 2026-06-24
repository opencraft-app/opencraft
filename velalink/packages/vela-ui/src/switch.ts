import { useCallback, type KeyboardEvent } from "react";
import { useControllableState } from "./controllableState";

export interface SwitchStateOptions {
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export interface SwitchState {
  checked: boolean;
  disabled: boolean;
  getSwitchProps: () => {
    "aria-checked": boolean;
    disabled: boolean | undefined;
    onClick: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
    role: "switch";
    type: "button";
  };
  setChecked: (checked: boolean) => void;
  toggle: () => void;
}

export function useSwitchState({
  checked,
  defaultChecked = false,
  disabled = false,
  onCheckedChange,
}: SwitchStateOptions): SwitchState {
  const [currentChecked, setCurrentChecked] = useControllableState({
    defaultValue: defaultChecked,
    value: checked,
    onChange: onCheckedChange,
  });

  const setChecked = useCallback(
    (nextChecked: boolean) => {
      if (!disabled) setCurrentChecked(nextChecked);
    },
    [disabled, setCurrentChecked],
  );

  const toggle = useCallback(() => {
    if (!disabled) setCurrentChecked((value) => !value);
  }, [disabled, setCurrentChecked]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle();
    },
    [disabled, toggle],
  );

  const getSwitchProps = useCallback(
    () => ({
      "aria-checked": currentChecked,
      disabled: disabled || undefined,
      onClick: toggle,
      onKeyDown,
      role: "switch" as const,
      type: "button" as const,
    }),
    [currentChecked, disabled, onKeyDown, toggle],
  );

  return {
    checked: currentChecked,
    disabled,
    getSwitchProps,
    setChecked,
    toggle,
  };
}

