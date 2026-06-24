import { useSwitchState } from "../../../../vela-ui/src";

export interface ShellSwitchProps {
  ariaLabel: string;
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export function ShellSwitch({
  ariaLabel,
  checked,
  defaultChecked = false,
  disabled = false,
  onCheckedChange,
}: ShellSwitchProps) {
  const switchState = useSwitchState({
    checked,
    defaultChecked,
    disabled,
    onCheckedChange,
  });

  return (
    <button
      {...switchState.getSwitchProps()}
      aria-label={ariaLabel}
      className="vela-shell-switch"
      data-state={switchState.checked ? "checked" : "unchecked"}
    >
      <span className="vela-shell-switch-thumb" />
    </button>
  );
}

