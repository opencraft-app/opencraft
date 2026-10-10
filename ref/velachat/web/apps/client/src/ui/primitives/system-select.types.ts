import type {ReactNode, Ref} from "react";

export type OverlayCloseReason =
  | "escape"
  | "outside"
  | "selection"
  | "tab"
  | "cancel"
  | "action"
  | "nativeBack";

export interface FocusableHandle {
  focus(): void;
}

export interface OverlayTriggerProps {
  accessibilityControls: string;
  accessibilityExpanded: boolean;
  onPress(): void;
  ref: Ref<FocusableHandle>;
}

export interface ControlledOverlayProps {
  onOpenChange(open: boolean, reason?: OverlayCloseReason): void;
  open: boolean;
  overlayId: string;
  renderTrigger(props: OverlayTriggerProps): ReactNode;
}

export interface SystemSelectOption<T extends string> {
  accessibilityLabel?: string;
  disabled?: boolean;
  label: string;
  value: T;
}

export interface SystemSelectProps<T extends string> extends ControlledOverlayProps {
  accessibilityLabel: string;
  onChange(value: T): void;
  options: readonly SystemSelectOption<T>[];
  value: T | null;
}
