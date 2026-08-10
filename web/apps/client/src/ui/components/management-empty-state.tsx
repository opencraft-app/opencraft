import {Text, View} from "react-native";
import {StyleSheet} from "react-native-unistyles";

import {SystemButton} from "../primitives/system-button";

export interface ManagementEmptyStateProps {
  actionAccessibilityLabel?: string;
  actionLabel?: string;
  description: string;
  onAction?(): void;
  title: string;
}

export function ManagementEmptyState({
  actionAccessibilityLabel,
  actionLabel,
  description,
  onAction,
  title,
}: ManagementEmptyStateProps) {
  return (
    <View style={styles.container} testID="management-empty-state">
      <View style={styles.row} testID="management-empty-state-row">
        <View style={styles.copy}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.description}>{description}</Text>
        </View>
        {actionLabel && onAction ? (
          <View style={styles.action} testID="management-empty-state-action-slot">
            <SystemButton
              accessibilityLabel={actionAccessibilityLabel}
              label={actionLabel}
              onPress={onAction}
              testID="management-empty-state-action"
              variant="secondary"
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  action: {
    flexShrink: 0,
    marginLeft: "auto",
  },
  container: {
    alignSelf: "center",
    marginVertical: theme.spacing.xl,
    maxWidth: theme.recipes.managementWorkspace.preferenceContentMaxWidth,
    width: "100%",
  },
  copy: {
    flex: 1,
    gap: theme.spacing.xxs,
    minWidth: theme.recipes.managementWorkspace.resourceActionCopyMinWidth,
  },
  description: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodySmall,
  },
  row: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.sectionSurface,
    borderColor: theme.semantic.color.separator,
    borderRadius: theme.semantic.radius.section,
    borderWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.md,
    minHeight: theme.recipes.managementWorkspace.resourceActionMinHeight,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  title: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.sectionTitle,
  },
}));
