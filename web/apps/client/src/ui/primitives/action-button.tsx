import type {LucideIcon} from "lucide-react-native";

import {
  SystemButton,
  type SystemButtonVariant,
} from "./system-button";

/** @deprecated Prefer SystemButton with an explicit semantic variant. */
export type ActionContext = "compact" | "default" | "header";
/** @deprecated Prefer SystemButtonVariant. */
export type ActionImportance = "danger" | "primary" | "secondary" | "tonal";
export type ActionAlign = "center" | "start" | "stretch";

export interface ActionButtonProps {
  accessibilityLabel?: string;
  align?: ActionAlign;
  busy?: boolean;
  context?: ActionContext;
  disabled?: boolean;
  icon?: LucideIcon;
  iconTestID?: string;
  importance: ActionImportance;
  label: string;
  onPress(): void;
  testID?: string;
}

function systemVariant(
  importance: ActionImportance,
  context: ActionContext,
): SystemButtonVariant {
  if (context === "header" && importance !== "danger") return "toolbar";
  if (importance === "primary") return "default";
  if (importance === "secondary") return "secondary";
  if (importance === "tonal") return "accentedSecondary";
  return "destructive";
}

/**
 * Compatibility bridge for existing screens. New code must use SystemButton so
 * toolbar/default/destructive semantics are explicit at the call site.
 */
export function ActionButton({
  accessibilityLabel,
  align,
  busy,
  context = "default",
  disabled,
  icon,
  iconTestID,
  importance,
  label,
  onPress,
  testID,
}: ActionButtonProps) {
  return (
    <SystemButton
      accessibilityLabel={accessibilityLabel}
      align={align}
      busy={busy}
      disabled={disabled}
      icon={icon}
      iconTestID={iconTestID}
      label={label}
      onPress={onPress}
      testID={testID}
      variant={systemVariant(importance, context)}
    />
  );
}
