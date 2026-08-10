import type {LucideIcon} from "lucide-react-native";

import type {ActionContext} from "./action-button";
import {SystemIconButton} from "./system-button";

export interface IconActionButtonProps {
  accessibilityLabel: string;
  context?: ActionContext;
  disabled?: boolean;
  icon: LucideIcon;
  iconTestID?: string;
  onPress(): void;
  testID?: string;
}

/** @deprecated Prefer SystemIconButton. */
export function IconActionButton({
  accessibilityLabel,
  disabled,
  icon,
  iconTestID,
  onPress,
  testID,
}: IconActionButtonProps) {
  return (
    <SystemIconButton
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      icon={icon}
      iconTestID={iconTestID}
      onPress={onPress}
      testID={testID}
      variant="toolbar"
    />
  );
}
