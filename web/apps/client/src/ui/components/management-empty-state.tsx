import type {LucideIcon} from "lucide-react-native";
import {InlineEmptyState} from "./management-workspace";

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
    <InlineEmptyState
      actionAccessibilityLabel={actionAccessibilityLabel}
      actionLabel={actionLabel}
      description={description}
      icon={Icon}
      onAction={onAction}
      testID="management-empty-state"
      title={title}
    />
  );
}
