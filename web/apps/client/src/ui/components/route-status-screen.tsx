import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export function RouteStatusScreen({
  actionLabel,
  description,
  onAction,
  title,
}: {
  actionLabel?: string;
  description: string;
  onAction?: () => void;
  title: string;
}) {
  return (
    <View style={styles.root}>
      <View style={styles.surface} testID="route-status-surface">
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.description}>{description}</Text>
        {actionLabel && onAction ? (
          <Pressable
            accessibilityRole="button"
            onPress={onAction}
            style={styles.action}
          >
            <Text style={styles.actionText}>{actionLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  action: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: theme.semantic.color.actionPrimarySurface,
    borderColor: theme.semantic.color.actionPrimarySurface,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    justifyContent: "center",
    minHeight: theme.recipes.control.height,
    paddingHorizontal: theme.spacing.lg,
  },
  actionText: {
    color: theme.semantic.color.actionPrimaryText,
    ...theme.semantic.typography.bodyEmphasis,
  },
  description: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.body,
  },
  root: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceSubtle,
    flex: 1,
    justifyContent: "center",
    padding: theme.spacing.xl,
  },
  surface: {
    gap: theme.spacing.md,
    maxWidth: theme.recipes.contentMeasure.readingMaxWidth,
    width: "100%",
  },
  title: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.detailTitle,
  },
}));
