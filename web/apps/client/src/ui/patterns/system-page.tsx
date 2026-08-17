import {Children, Fragment, isValidElement, type ReactNode} from "react";
import {Text, View} from "react-native";
import {StyleSheet} from "react-native-unistyles";

import {
  DetailSection,
  ManagementDetailScroll,
  ManagementHeader,
  ManagementStage,
  ManagementStageFill,
} from "../components/management-workspace-core";
import {styles as managementStyles} from "../components/management-workspace.styles";
import {SystemButton} from "../primitives/system-button";
import {SystemSourceListRow} from "../primitives/system-source-list-row";

export type SystemPageDensity = "comfortable" | "compact" | "medium";

export interface SystemPageProps {
  actions?: ReactNode;
  children: ReactNode;
  contentMode?: "fill" | "scroll";
  contentTestID?: string;
  density?: SystemPageDensity;
  eyebrow?: string;
  feedback?: ReactNode;
  headerCopyTestID?: string;
  navigation?: ReactNode;
  summary?: string;
  testID?: string;
  title: string;
  titleTestID?: string;
}

/** Stable title/action grid plus exactly one page-owned content region. */
export function SystemPage({
  actions,
  children,
  contentMode = "scroll",
  contentTestID = "system-page-content",
  density = "comfortable",
  eyebrow,
  feedback,
  headerCopyTestID,
  navigation,
  summary,
  testID = "system-page",
  title,
  titleTestID,
}: SystemPageProps) {
  const content = contentMode === "fill" ? (
    <ManagementStageFill density={density} testID={contentTestID}>
      {children}
    </ManagementStageFill>
  ) : (
    <ManagementDetailScroll density={density} testID={contentTestID}>
      {children}
    </ManagementDetailScroll>
  );
  return (
    <ManagementStage testID={testID}>
      <ManagementHeader
        actions={actions}
        copyTestID={headerCopyTestID}
        eyebrow={eyebrow}
        summary={summary}
        title={title}
        titleTestID={titleTestID}
      />
      {feedback}
      {navigation}
      {content}
    </ManagementStage>
  );
}

export interface SystemSectionProps {
  children: ReactNode;
  description?: string;
  testID?: string;
  title?: string;
}

/** Inset macOS-style group with one caption/copy hierarchy. */
export function SystemSection({
  children,
  description,
  testID = "system-section",
  title,
}: SystemSectionProps) {
  const items = Children.toArray(children);
  return (
    <DetailSection description={description} testID={testID} title={title}>
      {items.map((child, index) => {
        const previous = items[index - 1];
        const separatesRows = index > 0 &&
          isValidElement(previous) && previous.type === SystemRow &&
          isValidElement(child) && child.type === SystemRow;
        return (
          <Fragment key={isValidElement(child) ? child.key ?? index : index}>
            {separatesRows ? (
              <View
                style={patternStyles.separator}
                testID={`${testID}-separator-${index}`}
              />
            ) : null}
            {child}
          </Fragment>
        );
      })}
    </DetailSection>
  );
}

export interface SystemRowProps {
  accessibilityLabel?: string;
  action?: ReactNode;
  description?: string;
  disabled?: boolean;
  leading?: ReactNode;
  metadata?: string;
  onPress?: () => void;
  orientation?: "horizontal" | "vertical";
  selected?: boolean;
  testID?: string;
  title: string;
}

/** One copy/metadata/action geometry for static and navigable management rows. */
export function SystemRow({
  accessibilityLabel,
  action,
  description,
  disabled = false,
  leading,
  metadata,
  onPress,
  orientation = "vertical",
  selected = false,
  testID = "system-row",
  title,
}: SystemRowProps) {
  const row = (
    <View
      style={[patternStyles.row, !onPress && patternStyles.staticRow]}
      testID={`${testID}-content`}
    >
      {leading ? <View style={patternStyles.leading}>{leading}</View> : null}
      <View style={patternStyles.rowCopy}>
        <Text numberOfLines={1} style={patternStyles.rowTitle}>{title}</Text>
        {description ? (
          <Text numberOfLines={2} style={patternStyles.rowDescription}>{description}</Text>
        ) : null}
        {metadata ? (
          <Text numberOfLines={1} style={patternStyles.rowMetadata}>{metadata}</Text>
        ) : null}
      </View>
      {action ? <View style={patternStyles.rowAction}>{action}</View> : null}
    </View>
  );
  if (!onPress) return <View testID={testID}>{row}</View>;
  return (
    <SystemSourceListRow
      accessibilityLabel={accessibilityLabel ?? title}
      disabled={disabled}
      kind="button"
      onPress={onPress}
      orientation={orientation}
      rowId={testID}
      selected={selected}
      testID={testID}
    >
      {row}
    </SystemSourceListRow>
  );
}

export interface SystemFormAction {
  accessibilityLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  label: string;
  onPress(): unknown | Promise<unknown>;
  testID?: string;
}

export interface SystemFormProps {
  backAction?: SystemFormAction;
  cancelAction?: SystemFormAction;
  children: ReactNode;
  primaryAction?: SystemFormAction;
  testID?: string;
}

/** Form body and its only legal labelled-action footer. */
export function SystemForm({
  backAction,
  cancelAction,
  children,
  primaryAction,
  testID = "system-form",
}: SystemFormProps) {
  const actions = [cancelAction, backAction, primaryAction].filter(
    (action): action is SystemFormAction => Boolean(action),
  );
  return (
    <View style={managementStyles.form} testID={testID}>
      {children}
      {actions.length > 0 ? (
        <View style={managementStyles.formActions} testID={`${testID}-footer`}>
          {actions.map((action) => (
            <SystemButton
              accessibilityLabel={action.accessibilityLabel}
              busy={action.busy}
              disabled={action.disabled}
              key={action.testID ?? action.label}
              label={action.label}
              onPress={() => void action.onPress()}
              testID={action.testID}
              variant="standard"
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const patternStyles = StyleSheet.create(theme => ({
  leading: {
    alignItems: "center",
    flexShrink: 0,
    justifyContent: "center",
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.md,
    minHeight: theme.recipes.control.rowHeight,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  rowAction: {
    alignItems: "center",
    flexShrink: 0,
    justifyContent: "center",
  },
  rowCopy: {
    flex: 1,
    gap: theme.spacing.xxs,
    minWidth: 0,
  },
  rowDescription: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  rowMetadata: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.caption,
  },
  rowTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodyEmphasis,
  },
  separator: {
    backgroundColor: theme.semantic.color.separator,
    height: theme.semantic.stroke.hairline,
  },
  staticRow: {
    minHeight: theme.recipes.managementWorkspace.resourceActionMinHeight,
    paddingHorizontal: 0,
    paddingVertical: theme.spacing.md,
  },
}));
