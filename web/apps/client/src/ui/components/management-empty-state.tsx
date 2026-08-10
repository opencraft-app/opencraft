import type {LucideIcon} from "lucide-react-native";
import {SystemEmptyState} from "../primitives/system-empty-state";

export interface ManagementEmptyStateProps {
  actionAccessibilityLabel?: string;
  actionLabel?: string;
  description: string;
  icon: LucideIcon;
  onAction?(): void;
  title: string;
}

export function ManagementEmptyState({
  actionAccessibilityLabel,
  actionLabel,
  description,
  icon: Icon,
  onAction,
  title,
}: ManagementEmptyStateProps) {
  return (
    <SystemEmptyState
      description={description}
      icon={Icon}
      kind="onboarding"
      primaryAction={
        actionLabel && onAction
          ? {
              accessibilityLabel: actionAccessibilityLabel,
              label: actionLabel,
              onPress: onAction,
              variant: "default",
            }
          : undefined
      }
      testID="management-empty-state"
      title={title}
    />
  );
}
