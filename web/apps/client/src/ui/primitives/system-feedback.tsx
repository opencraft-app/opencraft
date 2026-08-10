import {useState} from "react";
import {Text, View} from "react-native";
import {StyleSheet} from "react-native-unistyles";

import type {ProductError} from "../../application/product-language";
import {productErrorPresentation} from "../../application/product-language";
import {SystemButton} from "./system-button";

export interface SystemFeedbackAction {
  accessibilityLabel?: string;
  label: string;
  onPress(): void;
}

export interface SystemFeedbackProps {
  action?: SystemFeedbackAction;
  error?: ProductError;
  kind: "blocking" | "field" | "inline" | "toast";
  message?: string;
  testID?: string;
  tone?: "danger" | "info" | "positive";
}

export function SystemFeedback({
  action,
  error,
  kind,
  message,
  testID = "system-feedback",
  tone = error ? "danger" : "info",
}: SystemFeedbackProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const presentation = error ? productErrorPresentation(error) : null;
  const primaryMessage = presentation?.message ?? message ?? "操作没有完成";
  return (
    <View
      accessibilityLiveRegion={kind === "blocking" ? "assertive" : "polite"}
      accessibilityRole={kind === "blocking" ? "alert" : undefined}
      style={[
        styles.container,
        kind === "field" && styles.field,
        kind === "inline" && styles.inline,
        kind === "toast" && styles.toast,
        kind === "blocking" && styles.blocking,
        tone === "danger" && styles.danger,
        tone === "positive" && styles.positive,
      ]}
      testID={testID}
    >
      <View style={styles.copy}>
        <Text style={styles.message}>{primaryMessage}</Text>
        {presentation ? (
          <Text style={styles.nextStep}>{presentation.nextStep}</Text>
        ) : null}
        {detailOpen && error?.detail ? (
          <Text selectable style={styles.detail}>{error.detail}</Text>
        ) : null}
      </View>
      <View style={styles.actions}>
        {error?.detail ? (
          <SystemButton
            accessibilityLabel={detailOpen ? "收起技术详情" : "查看技术详情"}
            label={detailOpen ? "收起详情" : "技术详情"}
            onPress={() => setDetailOpen(current => !current)}
            variant="secondary"
          />
        ) : null}
        {action ? (
          <SystemButton
            accessibilityLabel={action.accessibilityLabel}
            label={action.label}
            onPress={action.onPress}
            variant="secondary"
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create(theme => ({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.xs,
  },
  blocking: {
    backgroundColor: theme.semantic.color.statusDangerSurface,
    borderBottomColor: theme.semantic.color.statusDangerDivider,
    borderBottomWidth: theme.semantic.stroke.hairline,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  container: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
    width: "100%",
  },
  copy: {
    flex: 1,
    gap: theme.spacing.xxs,
    minWidth: 0,
  },
  detail: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  field: {
    alignItems: "flex-start",
    flexDirection: "column",
  },
  inline: {
    backgroundColor: theme.semantic.color.statusInfoSurface,
    borderBottomColor: theme.semantic.color.statusInfoDivider,
    borderBottomWidth: theme.semantic.stroke.hairline,
    minHeight: theme.recipes.status.inlineMinHeight,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  message: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodySmallEmphasis,
  },
  nextStep: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodySmall,
  },
  toast: {
    backgroundColor: theme.semantic.color.overlaySurface,
    borderColor: theme.semantic.color.borderOverlay,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    maxWidth: theme.recipes.contentMeasure.noticeMaxWidth,
    minHeight: theme.recipes.status.toastMinHeight,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    elevation: theme.semantic.elevation.overlay,
  },
  danger: {
    backgroundColor: theme.semantic.color.statusDangerSurface,
    borderBottomColor: theme.semantic.color.statusDangerDivider,
    borderColor: theme.semantic.color.statusDangerDivider,
  },
  positive: {
    backgroundColor: theme.semantic.color.statusPositiveSurface,
    borderBottomColor: theme.semantic.color.statusPositiveDivider,
    borderColor: theme.semantic.color.statusPositiveDivider,
  },
}));
