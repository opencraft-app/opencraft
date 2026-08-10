import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import {SystemButton} from "../primitives/system-button";

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
          <SystemButton
            label={actionLabel}
            onPress={onAction}
            variant="standard"
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
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
