import type {ControlledOverlayProps} from "./system-select.types";

export interface SystemActionMenuItem {
  checked?: boolean;
  disabled?: boolean;
  groupId?: string;
  id: string;
  intent?: "destructive" | "normal";
  label: string;
  selectionKind?: "checkbox" | "radio";
  shortcutLabel?: string;
}

export interface SystemActionMenuProps extends ControlledOverlayProps {
  accessibilityLabel: string;
  items: readonly SystemActionMenuItem[];
  onAction(id: string): void;
}
