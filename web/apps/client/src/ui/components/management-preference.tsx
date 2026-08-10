import {Children, Fragment, type ReactNode} from "react";
import {Text, View} from "react-native";
import {StyleSheet} from "react-native-unistyles";

import {SystemButton} from "../primitives/system-button";

export function ManagementPreferenceBody({
  children,
  testID = "management-preference-body",
}: {
  children: ReactNode;
  testID?: string;
}) {
  return <View style={styles.content} testID={testID}>{children}</View>;
}

export function ManagementPreferenceSection({
  children,
  description,
  testID,
  title,
}: {
  children: ReactNode;
  description: string;
  testID?: string;
  title: string;
}) {
  const items = Children.toArray(children);
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.sectionDescription}>{description}</Text>
      </View>
      <View style={styles.group} testID={testID}>
        {items.map((item, index) => (
          <Fragment key={index}>
            {index > 0 ? <PreferenceSeparator /> : null}
            {item}
          </Fragment>
        ))}
      </View>
    </View>
  );
}

export function ManagementPreferenceRow({
  children,
  description,
  error,
  hint,
  label,
  testID,
}: {
  children: ReactNode;
  description: string;
  error?: string | null;
  hint?: string;
  label: string;
  testID?: string;
}) {
  return (
    <View style={styles.row} testID={testID}>
      <View style={styles.rowCopy}>
        <Text style={styles.rowTitle}>{label}</Text>
        <Text style={styles.rowDescription}>{description}</Text>
      </View>
      <View style={styles.fieldControl}>
        {children}
        {error ? (
          <Text accessibilityRole="alert" style={styles.fieldError}>{error}</Text>
        ) : hint ? (
          <Text style={styles.fieldHint}>{hint}</Text>
        ) : null}
      </View>
    </View>
  );
}

export function ManagementPreferenceMetadataRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <View style={styles.metadataRow}>
      <Text style={styles.metadataLabel}>{label}</Text>
      <Text selectable style={styles.metadataValue}>{value}</Text>
    </View>
  );
}

export interface ManagementPreferenceFooterAction {
  busy?: boolean;
  disabled?: boolean;
  label: string;
  onPress(): unknown | Promise<unknown>;
  testID?: string;
}

export function ManagementPreferenceFooter({
  action,
  status,
  statusTone = "neutral",
  testID = "management-preference-footer",
}: {
  action: ManagementPreferenceFooterAction;
  status: string;
  statusTone?: "neutral" | "positive";
  testID?: string;
}) {
  return (
    <View style={styles.footer} testID={testID}>
      <Text
        style={[
          styles.footerStatus,
          statusTone === "positive" && styles.footerStatusPositive,
        ]}
      >
        {status}
      </Text>
      <SystemButton
        busy={action.busy}
        disabled={action.disabled}
        label={action.label}
        onPress={() => void action.onPress()}
        testID={action.testID}
        variant="default"
      />
    </View>
  );
}

function PreferenceSeparator() {
  return <View style={styles.separator} testID="management-preference-separator" />;
}

const styles = StyleSheet.create((theme) => ({
  content: {
    alignSelf: "center",
    gap: theme.recipes.managementWorkspace.detailGap,
    maxWidth: theme.recipes.managementWorkspace.preferenceContentMaxWidth,
    paddingVertical: theme.recipes.managementWorkspace.mediumPadding,
    width: "100%",
  },
  fieldControl: {
    flexBasis: theme.recipes.managementWorkspace.preferenceControlMinWidth,
    flexGrow: 1,
    gap: theme.spacing.xs,
    minWidth: theme.recipes.managementWorkspace.preferenceControlMinWidth,
  },
  fieldError: {
    color: theme.semantic.color.statusDangerText,
    ...theme.semantic.typography.meta,
  },
  fieldHint: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  footer: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.md,
    justifyContent: "space-between",
    minHeight: theme.recipes.managementWorkspace.resourceActionMinHeight,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  footerStatus: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  footerStatusPositive: {
    color: theme.semantic.color.statusPositiveText,
  },
  group: {
    backgroundColor: theme.semantic.color.sectionSurface,
    borderColor: theme.semantic.color.separator,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    overflow: "hidden",
  },
  metadataLabel: {
    color: theme.semantic.color.textMuted,
    flexBasis: theme.recipes.managementWorkspace.preferenceLabelWidth,
    flexShrink: 0,
    ...theme.semantic.typography.bodyCompact,
  },
  metadataRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.lg,
    minHeight: theme.recipes.control.rowHeight,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  metadataValue: {
    color: theme.semantic.color.textPrimary,
    flex: 1,
    minWidth: 0,
    ...theme.semantic.typography.bodyCompactEmphasis,
  },
  row: {
    alignItems: "flex-start",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.lg,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  rowCopy: {
    flexBasis: theme.recipes.managementWorkspace.preferenceLabelWidth,
    flexGrow: 0,
    gap: theme.spacing.xs,
  },
  rowDescription: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  rowTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodyEmphasis,
  },
  section: {
    gap: theme.spacing.sm,
  },
  sectionDescription: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodyCompact,
  },
  sectionHeading: {
    gap: theme.spacing.xxs,
    paddingHorizontal: theme.spacing.xs,
  },
  sectionTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.sectionTitle,
  },
  separator: {
    backgroundColor: theme.semantic.color.separator,
    height: theme.semantic.stroke.hairline,
    marginLeft: theme.spacing.lg,
  },
}));
