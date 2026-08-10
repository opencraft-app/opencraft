import type {LucideIcon} from "lucide-react-native";
import {Text, View} from "react-native";
import {StyleSheet, useUnistyles} from "react-native-unistyles";

import {SystemButton} from "./system-button";

export interface SystemEmptyStateAction {
  accessibilityLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  label: string;
  onPress(): void;
  variant: "default" | "secondary";
}

export interface SystemEmptyStateProps {
  description: string;
  icon?: LucideIcon;
  kind: "canvas" | "list" | "onboarding";
  primaryAction?: SystemEmptyStateAction;
  secondaryAction?: SystemEmptyStateAction;
  testID?: string;
  title: string;
}

export function SystemEmptyState({
  description,
  icon: Icon,
  kind,
  primaryAction,
  secondaryAction,
  testID = "system-empty-state",
  title,
}: SystemEmptyStateProps) {
  const {theme} = useUnistyles();
  return (
    <View
      style={[
        styles.container,
        kind === "list" && styles.list,
        kind === "canvas" && styles.canvas,
        kind === "onboarding" && styles.onboarding,
      ]}
      testID={testID}
    >
      {Icon ? (
        <View
          style={[
            styles.icon,
            kind === "onboarding" && styles.iconOnboarding,
          ]}
          testID={`${testID}-icon`}
        >
          <Icon
            color={theme.semantic.color.iconAccent}
            size={
              kind === "onboarding"
                ? theme.semantic.icon.size.medium
                : theme.semantic.icon.size.small
            }
            strokeWidth={theme.semantic.icon.stroke.regular}
          />
        </View>
      ) : null}
      <View style={styles.copy}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.description}>{description}</Text>
      </View>
      {primaryAction || secondaryAction ? (
        <View style={styles.actions} testID={`${testID}-action`}>
          {primaryAction ? (
            <SystemButton
              accessibilityLabel={primaryAction.accessibilityLabel}
              busy={primaryAction.busy}
              disabled={primaryAction.disabled}
              label={primaryAction.label}
              onPress={primaryAction.onPress}
              variant={primaryAction.variant}
            />
          ) : null}
          {secondaryAction ? (
            <SystemButton
              accessibilityLabel={secondaryAction.accessibilityLabel}
              busy={secondaryAction.busy}
              disabled={secondaryAction.disabled}
              label={secondaryAction.label}
              onPress={secondaryAction.onPress}
              variant={secondaryAction.variant}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create(theme => ({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  canvas: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.xl,
  },
  container: {
    alignItems: "flex-start",
    backgroundColor: theme.semantic.color.surfaceTransparent,
    gap: theme.spacing.md,
    width: "100%",
  },
  copy: {
    gap: theme.spacing.xs,
    maxWidth: theme.recipes.managementWorkspace.emptyStateMaxWidth,
  },
  description: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodySmall,
  },
  icon: {
    alignItems: "center",
    height: theme.recipes.iconControl.compactSize,
    justifyContent: "center",
    width: theme.recipes.iconControl.compactSize,
  },
  iconOnboarding: {
    backgroundColor: theme.semantic.color.iconAccentSurface,
    borderRadius: theme.semantic.radius.control,
    height: theme.recipes.control.squareSize,
    width: theme.recipes.control.squareSize,
  },
  list: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
  },
  onboarding: {
    justifyContent: "center",
    minHeight: theme.recipes.emptyState.stageMinHeight,
    paddingHorizontal: theme.spacing.xl,
    paddingVertical: theme.spacing.xxl,
  },
  title: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.sectionTitle,
  },
}));
