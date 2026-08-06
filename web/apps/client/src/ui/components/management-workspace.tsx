import type {LucideIcon} from "lucide-react-native";
import ChevronDown from "lucide-react-native/icons/chevron-down";
import type {ReactNode} from "react";
import {useState} from "react";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from "react-native";
import {StyleSheet, useUnistyles} from "react-native-unistyles";

import {
  LocalDateTimeInput,
  type LocalDateTimeInputProps,
} from "./local-date-time-input";

import {
  ActionButton,
  type ActionButtonProps,
  type ActionContext,
} from "../primitives/action-button";

export {ActionButton} from "../primitives/action-button";
export type {
  ActionButtonProps,
  ActionContext,
  ActionImportance,
} from "../primitives/action-button";
export {IconActionButton} from "../primitives/icon-action-button";
export type {IconActionButtonProps} from "../primitives/icon-action-button";

type StatusTone = "danger" | "info" | "neutral" | "positive" | "warning";
type ManagementDensity = "comfortable" | "compact" | "medium";
type ManagementFieldLayout = "compact" | "flex" | "stacked";
type SelectionLayout = "equal" | "hug";

interface SemanticContainerProps {
  children: ReactNode;
  testID?: string;
}

type CollectionOrientation = "horizontal" | "vertical";

export function ManagementCollectionPane({
  children,
  orientation = "vertical",
  testID = "management-collection-pane",
}: SemanticContainerProps & {orientation?: CollectionOrientation}) {
  return (
    <View
      style={[
        styles.collectionPane,
        orientation === "horizontal" && styles.collectionPaneHorizontal,
      ]}
      testID={testID}
    >
      {children}
    </View>
  );
}

export interface ManagementCollectionHeaderProps {
  eyebrow: string;
  icon: LucideIcon;
  testID?: string;
  title: string;
}

export function ManagementCollectionHeader({
  eyebrow,
  icon: Icon,
  testID = "management-collection-header",
  title,
}: ManagementCollectionHeaderProps) {
  const {theme} = useUnistyles();
  return (
    <View style={styles.collectionHeader} testID={testID}>
      <View style={styles.collectionHeaderMark} testID={`${testID}-mark`}>
        <Icon
          color={theme.semantic.color.iconAccent}
          size={theme.semantic.icon.size.feature}
          strokeWidth={theme.semantic.icon.stroke.regular}
        />
      </View>
      <View style={styles.collectionHeaderCopy}>
        <Text style={styles.collectionHeaderTitle}>{title}</Text>
        <Text style={styles.collectionHeaderEyebrow}>{eyebrow}</Text>
      </View>
    </View>
  );
}

export interface ManagementCollectionFooterActionProps {
  accessibilityLabel?: string;
  disabled?: boolean;
  icon?: LucideIcon;
  label: string;
  onPress(): void;
  testID?: string;
}

export function ManagementCollectionFooterAction({
  accessibilityLabel,
  disabled = false,
  icon: Icon,
  label,
  onPress,
  testID,
}: ManagementCollectionFooterActionProps) {
  const {theme} = useUnistyles();
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{disabled}}
      disabled={disabled ? true : undefined}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({pressed}) => [
        styles.collectionFooterAction,
        hovered && !disabled && styles.collectionFooterActionHover,
        pressed && styles.collectionFooterActionPressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      {Icon ? (
        <Icon
          color={theme.semantic.color.iconAccent}
          size={theme.semantic.icon.size.small}
          strokeWidth={theme.semantic.icon.stroke.emphasis}
        />
      ) : null}
      <Text style={styles.collectionFooterActionText}>{label}</Text>
    </Pressable>
  );
}

export function ManagementStage({
  children,
  testID = "management-stage",
}: SemanticContainerProps) {
  return <View style={styles.stage} testID={testID}>{children}</View>;
}

export interface ManagementDetailScrollProps extends SemanticContainerProps {
  density?: ManagementDensity;
}

export function ManagementDetailScroll({
  children,
  density = "comfortable",
  testID = "management-detail-scroll",
}: ManagementDetailScrollProps) {
  return (
    <ScrollView style={styles.detailScroll} testID={testID}>
      <View
        style={[
          styles.detailScrollContent,
          density === "medium" && styles.detailScrollContentMedium,
          density === "compact" && styles.detailScrollContentCompact,
        ]}
        testID={`${testID}-content`}
      >
        {children}
      </View>
    </ScrollView>
  );
}

export function ManagementDetailCanvas({
  children,
  testID = "management-detail-canvas",
}: SemanticContainerProps) {
  return <View style={styles.detailCanvas} testID={testID}>{children}</View>;
}

export function ManagementForm({
  children,
  testID = "management-form",
}: SemanticContainerProps) {
  return <View style={styles.form} testID={testID}>{children}</View>;
}

export function ManagementFormActions({
  children,
  testID = "management-form-actions",
}: SemanticContainerProps) {
  return <View style={styles.formActions} testID={testID}>{children}</View>;
}

export interface ManagementFieldProps extends SemanticContainerProps {
  error?: string | null;
  hint?: string;
  label: string;
  layout?: ManagementFieldLayout;
}

export function ManagementField({
  children,
  error,
  hint,
  label,
  layout = "stacked",
  testID = "management-field",
}: ManagementFieldProps) {
  return (
    <View
      style={[
        styles.field,
        layout === "flex" && styles.fieldFlex,
        layout === "compact" && styles.fieldCompact,
      ]}
      testID={testID}
    >
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
      {error ? (
        <Text accessibilityRole="alert" style={styles.fieldError}>
          {error}
        </Text>
      ) : hint ? (
        <Text style={styles.fieldHint}>{hint}</Text>
      ) : null}
    </View>
  );
}

export interface ManagementTextInputProps
  extends Omit<TextInputProps, "style"> {
  invalid?: boolean;
}

export function ManagementTextInput({
  editable = true,
  invalid = false,
  multiline = false,
  placeholderTextColor,
  ...props
}: ManagementTextInputProps) {
  const {theme} = useUnistyles();
  return (
    <TextInput
      {...props}
      editable={editable}
      multiline={multiline}
      placeholderTextColor={
        placeholderTextColor ?? theme.semantic.color.fieldPlaceholder
      }
      style={[
        styles.textInput,
        multiline && styles.textInputMultiline,
        invalid && styles.textInputInvalid,
        !editable && styles.disabled,
      ]}
    />
  );
}

export interface ManagementDateTimeInputProps
  extends Omit<LocalDateTimeInputProps, "style"> {
  invalid?: boolean;
}

export function ManagementDateTimeInput({
  disabled = false,
  invalid = false,
  ...props
}: ManagementDateTimeInputProps) {
  return (
    <LocalDateTimeInput
      {...props}
      disabled={disabled}
      style={[
        styles.textInput,
        invalid && styles.textInputInvalid,
        disabled && styles.disabled,
      ]}
    />
  );
}

export interface ManagementHeaderProps {
  actions?: ReactNode;
  copyTestID?: string;
  eyebrow?: string;
  summary?: string;
  testID?: string;
  title: string;
  titleTestID?: string;
}

type ResourceIdentityMark =
  | {icon: LucideIcon; monogram?: never}
  | {icon?: never; monogram: string};

export type ResourceIdentityKind = "agent" | "human" | "resource";

export type CollectionIdentityMarkProps = ResourceIdentityMark & {
  identityKind?: ResourceIdentityKind;
  presence?: {
    label: string;
    tone?: StatusTone;
  };
  testID?: string;
};

export function CollectionIdentityMark({
  icon: Icon,
  identityKind = "resource",
  monogram,
  presence,
  testID = "collection-identity-mark",
}: CollectionIdentityMarkProps) {
  const {theme} = useUnistyles();
  const iconColor = identityKind === "agent"
    ? theme.semantic.color.iconInverse
    : identityKind === "human"
      ? theme.semantic.color.avatarHumanVioletText
      : theme.semantic.color.iconAccent;
  const presenceTone = presence?.tone ?? "neutral";
  return (
    <View
      style={[
        styles.collectionIdentityMark,
        identityKind === "agent" && styles.collectionIdentityMarkAgent,
        identityKind === "human" && styles.collectionIdentityMarkHuman,
      ]}
      testID={testID}
    >
      {Icon ? (
        <Icon
          color={iconColor}
          size={theme.semantic.icon.size.medium}
          strokeWidth={theme.semantic.icon.stroke.regular}
        />
      ) : (
        <Text
          style={[
            styles.collectionIdentityMonogram,
            identityKind === "agent" && styles.collectionIdentityMonogramAgent,
            identityKind === "human" && styles.collectionIdentityMonogramHuman,
          ]}
        >
          {monogram}
        </Text>
      )}
      {presence ? (
        <View
          accessibilityLabel={presence.label}
          accessibilityRole="image"
          style={[
            styles.collectionIdentityPresence,
            presenceTone === "danger" && styles.collectionIdentityPresenceDanger,
            presenceTone === "info" && styles.collectionIdentityPresenceInfo,
            presenceTone === "positive" && styles.collectionIdentityPresencePositive,
            presenceTone === "warning" && styles.collectionIdentityPresenceWarning,
          ]}
          testID={`${testID}-presence`}
        />
      ) : null}
    </View>
  );
}

export type ResourceIdentityHeaderProps = ResourceIdentityMark & {
  identityKind?: ResourceIdentityKind;
  markTestID?: string;
  metadata?: string[];
  metadataTestID?: string;
  primaryTestID?: string;
  status?: {
    label: string;
    tone?: StatusTone;
  };
  testID?: string;
  title: string;
  titleTestID?: string;
};

export function ResourceIdentityHeader({
  icon: Icon,
  identityKind = "resource",
  markTestID,
  metadata = [],
  metadataTestID,
  monogram,
  primaryTestID,
  status,
  testID = "resource-identity-header",
  title,
  titleTestID,
}: ResourceIdentityHeaderProps) {
  const {theme} = useUnistyles();
  return (
    <View style={styles.resourceIdentityHeader} testID={testID}>
      <View style={styles.resourceIdentityPrimary} testID={primaryTestID}>
        <View
          style={[
            styles.resourceIdentityMark,
            identityKind === "agent" && styles.resourceIdentityMarkAgent,
            identityKind === "human" && styles.resourceIdentityMarkHuman,
          ]}
          testID={markTestID ?? `${testID}-mark`}
        >
          {Icon ? (
            <Icon
              color={theme.semantic.color.iconAccent}
              size={theme.semantic.icon.size.feature}
              strokeWidth={theme.semantic.icon.stroke.regular}
            />
          ) : (
            <Text style={[
              styles.resourceIdentityMonogram,
              identityKind === "agent" && styles.resourceIdentityMonogramAgent,
              identityKind === "human" && styles.resourceIdentityMonogramHuman,
            ]}>{monogram}</Text>
          )}
        </View>
        <View style={styles.resourceIdentityCopy}>
          <Text
            numberOfLines={2}
            style={styles.resourceIdentityTitle}
            testID={titleTestID ?? `${testID}-title`}
          >
            {title}
          </Text>
          {metadata.length > 0 ? (
            <Text
              numberOfLines={2}
              style={styles.resourceIdentityMetadata}
              testID={metadataTestID ?? `${testID}-metadata`}
            >
              {metadata.join(" · ")}
            </Text>
          ) : null}
        </View>
      </View>
      {status ? (
        <StatusIndicator
          label={status.label}
          testID={`${testID}-status`}
          tone={status.tone}
        />
      ) : null}
    </View>
  );
}

export interface ResourceFact {
  label: string;
  testID?: string;
  value: string;
}

export interface ResourceFactStripProps {
  facts: ResourceFact[];
  testID?: string;
}

export function ResourceFactStrip({
  facts,
  testID = "resource-fact-strip",
}: ResourceFactStripProps) {
  return (
    <View style={styles.resourceFactStrip} testID={testID}>
      {facts.map((fact, index) => (
        <View
          key={`${fact.label}:${index}`}
          style={styles.resourceFact}
          testID={fact.testID ?? `${testID}-item-${index}`}
        >
          <Text style={styles.resourceFactLabel}>{fact.label}</Text>
          <Text numberOfLines={2} style={styles.resourceFactValue}>
            {fact.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

export interface CodeBlockProps {
  testID?: string;
  value: string;
}

export function CodeBlock({
  testID = "code-block",
  value,
}: CodeBlockProps) {
  return (
    <View style={styles.codeBlock} testID={testID}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable style={styles.codeBlockText}>{value}</Text>
      </ScrollView>
    </View>
  );
}

export interface NoticeBannerProps extends SemanticContainerProps {
  actions?: ReactNode;
  description?: string;
  title: string;
  tone?: StatusTone;
}

export function NoticeBanner({
  actions,
  children,
  description,
  testID = "notice-banner",
  title,
  tone = "neutral",
}: NoticeBannerProps) {
  return (
    <View
      style={[
        styles.notice,
        tone === "danger" && styles.noticeDanger,
        tone === "info" && styles.noticeInfo,
        tone === "positive" && styles.noticePositive,
        tone === "warning" && styles.noticeWarning,
      ]}
      testID={testID}
    >
      <View style={styles.noticeHeader}>
        <View style={styles.noticeCopy}>
          <Text style={styles.noticeTitle}>{title}</Text>
          {description ? (
            <Text style={styles.noticeDescription}>{description}</Text>
          ) : null}
        </View>
        {actions ? <View style={styles.noticeActions}>{actions}</View> : null}
      </View>
      {children}
    </View>
  );
}

export interface RecordIdentityHeaderProps {
  reference: string;
  status?: {
    label: string;
    tone?: StatusTone;
  };
  testID?: string;
  title: string;
  titleTestID?: string;
}

export function RecordIdentityHeader({
  reference,
  status,
  testID = "record-identity-header",
  title,
  titleTestID,
}: RecordIdentityHeaderProps) {
  return (
    <View style={styles.recordIdentityHeader} testID={testID}>
      <View style={styles.recordIdentityCopy}>
        <Text style={styles.recordIdentityReference}>{reference}</Text>
        <Text
          numberOfLines={3}
          style={styles.recordIdentityTitle}
          testID={titleTestID ?? `${testID}-title`}
        >
          {title}
        </Text>
      </View>
      {status ? (
        <StatusIndicator
          label={status.label}
          testID={`${testID}-status`}
          tone={status.tone}
        />
      ) : null}
    </View>
  );
}

export interface DetailHeadingProps {
  metadata?: string[];
  status?: {
    label: string;
    tone?: StatusTone;
  };
  testID?: string;
  title: string;
  titleTestID?: string;
}

export function DetailHeading({
  metadata = [],
  status,
  testID = "detail-heading",
  title,
  titleTestID,
}: DetailHeadingProps) {
  return (
    <View style={styles.detailHeading} testID={testID}>
      <View style={styles.detailHeadingCopy}>
        <Text
          numberOfLines={3}
          style={styles.detailHeadingTitle}
          testID={titleTestID ?? `${testID}-title`}
        >
          {title}
        </Text>
        {metadata.length > 0 ? (
          <Text numberOfLines={2} style={styles.detailHeadingMetadata}>
            {metadata.join(" · ")}
          </Text>
        ) : null}
      </View>
      {status ? (
        <StatusIndicator
          label={status.label}
          testID={`${testID}-status`}
          tone={status.tone}
        />
      ) : null}
    </View>
  );
}

export interface ResourceMetadataItem {
  label: string;
  testID?: string;
  value: string;
}

export interface ResourceMetadataListProps {
  items: ResourceMetadataItem[];
  testID?: string;
}

export function ResourceMetadataList({
  items,
  testID = "resource-metadata-list",
}: ResourceMetadataListProps) {
  return (
    <View style={styles.resourceMetadataList} testID={testID}>
      {items.map((item, index) => (
        <View
          key={`${item.label}:${index}`}
          style={styles.resourceMetadataRow}
          testID={item.testID ?? `${testID}-item-${index}`}
        >
          <Text style={styles.resourceMetadataLabel}>{item.label}</Text>
          <Text numberOfLines={2} style={styles.resourceMetadataValue}>
            {item.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function ManagementHeader({
  actions,
  copyTestID,
  eyebrow,
  summary,
  testID = "management-header",
  title,
  titleTestID,
}: ManagementHeaderProps) {
  return (
    <View style={styles.header} testID={testID}>
      <View style={styles.headerCopy} testID={copyTestID}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text numberOfLines={1} style={styles.headerTitle} testID={titleTestID}>{title}</Text>
        {summary ? <Text numberOfLines={1} style={styles.summary}>{summary}</Text> : null}
      </View>
      {actions ? <View style={styles.headerActions}>{actions}</View> : null}
    </View>
  );
}

export interface CollectionRowProps extends SemanticContainerProps {
  accessibilityLabel?: string;
  disabled?: boolean;
  onPress(): void;
  orientation?: CollectionOrientation;
  selected?: boolean;
}

export function CollectionRow({
  accessibilityLabel,
  children,
  disabled = false,
  onPress,
  orientation = "vertical",
  selected = false,
  testID,
}: CollectionRowProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={disabled ? {disabled: true, selected} : {selected}}
      disabled={disabled ? true : undefined}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({pressed}) => [
        styles.collectionRow,
        orientation === "horizontal" && styles.collectionRowHorizontal,
        selected && styles.collectionRowSelected,
        hovered && !disabled && !selected && styles.collectionRowHover,
        hovered && !disabled && selected && styles.collectionRowSelectedHover,
        pressed && styles.collectionRowPressed,
        pressed && selected && styles.collectionRowSelectedPressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

export interface DetailSectionProps extends SemanticContainerProps {
  description?: string;
  title?: string;
}

export function DetailSection({
  children,
  description,
  testID = "detail-section",
  title,
}: DetailSectionProps) {
  return (
    <View style={styles.detailSection} testID={testID}>
      {title || description ? (
        <View style={styles.sectionHeading}>
          {title ? <Text style={styles.sectionTitle}>{title}</Text> : null}
          {description ? <Text style={styles.sectionDescription}>{description}</Text> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export interface ResourceActionRowProps
  extends Omit<SemanticContainerProps, "children"> {
  action: ReactNode;
  description: string;
  title: string;
}

export function ResourceActionRow({
  action,
  description,
  testID = "resource-action-row",
  title,
}: ResourceActionRowProps) {
  return (
    <View style={styles.resourceActionRow} testID={testID}>
      <View style={styles.resourceActionCopy}>
        <Text style={styles.resourceActionTitle}>{title}</Text>
        <Text style={styles.resourceActionDescription}>{description}</Text>
      </View>
      <View style={styles.resourceActionControl}>{action}</View>
    </View>
  );
}

export interface ManagementResourceSwitcherOption {
  accessibilityLabel: string;
  content: ReactNode;
  id: string;
  onSelect(): void;
}

export interface ManagementResourceSwitcherProps {
  currentAccessibilityLabel: string;
  currentContent: ReactNode;
  expanded: boolean;
  onToggle(): void;
  options: ManagementResourceSwitcherOption[];
  testID?: string;
}

export function ManagementResourceSwitcher({
  currentAccessibilityLabel,
  currentContent,
  expanded,
  onToggle,
  options,
  testID = "management-resource-switcher",
}: ManagementResourceSwitcherProps) {
  const {theme} = useUnistyles();
  const [hovered, setHovered] = useState(false);
  const [hoveredOptionId, setHoveredOptionId] = useState<string | null>(null);
  return (
    <View style={styles.resourceSwitcher} testID={testID}>
      <Pressable
        accessibilityLabel={currentAccessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{expanded}}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={onToggle}
        style={({pressed}) => [
          styles.resourceSwitcherTrigger,
          hovered && styles.resourceSwitcherHover,
          pressed && styles.resourceSwitcherPressed,
        ]}
        testID={`${testID}-trigger`}
      >
        {currentContent}
        <View style={expanded && styles.resourceSwitcherChevronOpen}>
          <ChevronDown
            color={theme.semantic.color.iconMuted}
            size={theme.semantic.icon.size.medium}
            strokeWidth={theme.semantic.icon.stroke.emphasis}
          />
        </View>
      </Pressable>
      {expanded ? (
        <ScrollView
          contentContainerStyle={styles.resourceSwitcherMenuContent}
          style={styles.resourceSwitcherMenu}
          testID={`${testID}-menu`}
        >
          {options.map((option) => (
            <Pressable
              accessibilityLabel={option.accessibilityLabel}
              accessibilityRole="button"
              key={option.id}
              onHoverIn={() => setHoveredOptionId(option.id)}
              onHoverOut={() => setHoveredOptionId(null)}
              onPress={option.onSelect}
              style={({pressed}) => [
                styles.resourceSwitcherOption,
                hoveredOptionId === option.id && styles.resourceSwitcherHover,
                pressed && styles.resourceSwitcherPressed,
              ]}
            >
              {option.content}
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

export interface SelectionGroupProps extends SemanticContainerProps {
  inset?: boolean;
}

export interface ManagementTabBarProps extends SemanticContainerProps {}

export function ManagementTabBar({
  children,
  testID = "management-tab-bar",
}: ManagementTabBarProps) {
  return <View style={styles.tabBar} testID={testID}>{children}</View>;
}

export interface ManagementTabProps {
  accessibilityLabel?: string;
  disabled?: boolean;
  label: string;
  onPress(): void;
  selected?: boolean;
  testID?: string;
}

export function ManagementTab({
  accessibilityLabel,
  disabled = false,
  label,
  onPress,
  selected = false,
  testID,
}: ManagementTabProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="tab"
      accessibilityState={{disabled, selected}}
      disabled={disabled}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({pressed}) => [
        styles.tab,
        selected && styles.tabSelected,
        hovered && !disabled && styles.tabHover,
        pressed && styles.tabPressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      <Text style={[styles.tabText, selected && styles.tabTextSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function SelectionGroup({
  children,
  inset = false,
  testID = "selection-group",
}: SelectionGroupProps) {
  return (
    <View style={[styles.selectionGroup, inset && styles.selectionGroupInset]} testID={testID}>
      {children}
    </View>
  );
}

export interface SelectionButtonProps {
  accessibilityLabel?: string;
  disabled?: boolean;
  label: string;
  layout?: SelectionLayout;
  onPress(): void;
  selected?: boolean;
  testID?: string;
}

export function SelectionButton({
  accessibilityLabel,
  disabled = false,
  label,
  layout = "hug",
  onPress,
  selected = false,
  testID,
}: SelectionButtonProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={disabled ? {disabled: true, selected} : {selected}}
      disabled={disabled ? true : undefined}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({pressed}) => [
        styles.selectionButton,
        layout === "equal" && styles.selectionButtonEqual,
        selected && styles.selectionButtonSelected,
        hovered && !disabled && !selected && styles.selectionButtonHover,
        hovered && !disabled && selected && styles.selectionButtonSelectedHover,
        pressed && !selected && styles.selectionButtonPressed,
        pressed && selected && styles.selectionButtonSelectedPressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      <Text style={styles.selectionButtonText}>{label}</Text>
    </Pressable>
  );
}

export interface InlineFeedbackProps {
  message: string;
  testID?: string;
  tone?: "danger" | "positive";
}

export function InlineFeedback({
  message,
  testID = "inline-feedback",
  tone = "danger",
}: InlineFeedbackProps) {
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole={tone === "danger" ? "alert" : undefined}
      style={[
        styles.feedback,
        tone === "positive" && styles.feedbackPositive,
      ]}
      testID={testID}
    >
      <View style={[
        styles.feedbackDot,
        tone === "positive" && styles.feedbackDotPositive,
      ]} />
      <Text style={[
        styles.feedbackText,
        tone === "positive" && styles.feedbackTextPositive,
      ]}>{message}</Text>
    </View>
  );
}

export interface StatusIndicatorProps {
  label: string;
  testID?: string;
  tone?: StatusTone;
}

export function StatusIndicator({
  label,
  testID,
  tone = "neutral",
}: StatusIndicatorProps) {
  return (
    <View style={[
      styles.status,
      tone === "info" && styles.statusInfo,
      tone === "positive" && styles.statusPositive,
      tone === "warning" && styles.statusWarning,
      tone === "danger" && styles.statusDanger,
    ]} testID={testID}>
      <View style={[
        styles.statusDot,
        tone === "info" && styles.statusDotInfo,
        tone === "positive" && styles.statusDotPositive,
        tone === "warning" && styles.statusDotWarning,
        tone === "danger" && styles.statusDotDanger,
      ]} />
      <Text style={[
        styles.statusText,
        tone === "info" && styles.statusTextInfo,
        tone === "positive" && styles.statusTextPositive,
        tone === "warning" && styles.statusTextWarning,
        tone === "danger" && styles.statusTextDanger,
      ]}>{label}</Text>
    </View>
  );
}

export interface InlineEmptyStateProps {
  actionAccessibilityLabel?: string;
  actionBusy?: boolean;
  actionDisabled?: boolean;
  actionLabel?: string;
  description: string;
  icon?: LucideIcon;
  onAction?(): void;
  testID?: string;
  title: string;
}

export function InlineEmptyState({
  actionAccessibilityLabel,
  actionBusy = false,
  actionDisabled = false,
  actionLabel,
  description,
  icon: Icon,
  onAction,
  testID = "inline-empty-state",
  title,
}: InlineEmptyStateProps) {
  const {theme} = useUnistyles();
  return (
    <View style={styles.empty} testID={testID}>
      {Icon ? (
        <View style={styles.emptyIcon} testID={`${testID}-icon`}>
          <Icon color={theme.semantic.color.iconAccent} size={theme.semantic.icon.size.feature} strokeWidth={theme.semantic.icon.stroke.regular} />
        </View>
      ) : null}
      <View style={styles.emptyCopy}>
        <Text style={styles.emptyTitle}>{title}</Text>
        <Text style={styles.emptyDescription}>{description}</Text>
      </View>
      {actionLabel && onAction ? (
        <View style={styles.emptyAction} testID={`${testID}-action`}>
          <ActionButton
            accessibilityLabel={actionAccessibilityLabel}
            busy={actionBusy}
            disabled={actionDisabled}
            importance="primary"
            label={actionLabel}
            onPress={onAction}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  collectionPane: {
    alignSelf: "stretch",
    backgroundColor: theme.semantic.color.sidebarSurface,
    borderColor: theme.semantic.color.separator,
    borderRadius: theme.semantic.radius.pane,
    borderRightWidth: theme.semantic.stroke.hairline,
    flexShrink: 0,
    height: "100%",
    width: theme.recipes.managementWorkspace.collectionWidth,
  },
  collectionPaneHorizontal: {
    borderBottomWidth: theme.semantic.stroke.hairline,
    borderRightWidth: 0,
    height: theme.recipes.managementWorkspace.collectionCompactHeight,
    width: "100%",
  },
  collectionFooterAction: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.paneSurface,
    borderTopColor: theme.semantic.color.separator,
    borderTopWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.sm,
    justifyContent: "center",
    minHeight: theme.recipes.managementWorkspace.collectionActionHeight,
    paddingHorizontal: theme.spacing.md,
    ...theme.semantic.motion.transition.control,
  },
  collectionFooterActionHover: {
    backgroundColor: theme.semantic.color.interactiveHoverSurface,
    ...theme.semantic.motion.transition.control,
  },
  collectionFooterActionPressed: {
    backgroundColor: theme.semantic.color.interactivePressedSurface,
    ...theme.semantic.motion.transition.control,
  },
  collectionFooterActionText: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.button,
  },
  collectionHeader: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.paneSurface,
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.md,
    minHeight: theme.recipes.managementWorkspace.headerHeight,
    paddingHorizontal: theme.spacing.md,
  },
  collectionHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  collectionHeaderEyebrow: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.eyebrow,
  },
  collectionHeaderMark: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.iconAccentSurface,
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    height: theme.recipes.managementWorkspace.compactResourceIconSize,
    justifyContent: "center",
    width: theme.recipes.managementWorkspace.compactResourceIconSize,
  },
  collectionHeaderTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.sectionTitle,
  },
  collectionIdentityMark: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.iconAccentSurface,
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    height: theme.recipes.managementWorkspace.collectionAvatarSize,
    justifyContent: "center",
    position: "relative",
    width: theme.recipes.managementWorkspace.collectionAvatarSize,
  },
  collectionIdentityMarkAgent: {
    backgroundColor: theme.semantic.color.avatarAgentSurface,
    borderRadius: theme.semantic.radius.circle,
  },
  collectionIdentityMarkHuman: {
    backgroundColor: theme.semantic.color.avatarHumanVioletSurface,
    borderColor: theme.semantic.color.avatarHumanVioletBorder,
    borderRadius: theme.semantic.radius.circle,
  },
  collectionIdentityMonogram: {
    color: theme.semantic.color.iconAccent,
    ...theme.semantic.typography.bodyCompactEmphasis,
  },
  collectionIdentityMonogramAgent: {
    color: theme.semantic.color.avatarAgentText,
  },
  collectionIdentityMonogramHuman: {
    color: theme.semantic.color.avatarHumanVioletText,
  },
  collectionIdentityPresence: {
    backgroundColor: theme.semantic.color.statusNeutral,
    borderColor: theme.semantic.color.sectionSurface,
    borderRadius: theme.semantic.radius.circle,
    borderWidth: theme.semantic.stroke.statusRing,
    bottom: theme.spacing.xxs,
    height: theme.recipes.identity.presenceDotSize,
    position: "absolute",
    right: theme.spacing.xxs,
    width: theme.recipes.identity.presenceDotSize,
  },
  collectionIdentityPresenceDanger: {
    backgroundColor: theme.semantic.color.statusDanger,
  },
  collectionIdentityPresenceInfo: {
    backgroundColor: theme.semantic.color.statusInfo,
  },
  collectionIdentityPresencePositive: {
    backgroundColor: theme.semantic.color.statusPositive,
  },
  collectionIdentityPresenceWarning: {
    backgroundColor: theme.semantic.color.statusWarning,
  },
  collectionRow: {
    alignItems: "center",
    borderRadius: theme.semantic.radius.compactControl,
    flexDirection: "row",
    gap: theme.spacing.sm,
    minHeight: theme.recipes.managementWorkspace.rowMinHeight,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    ...theme.semantic.motion.transition.control,
  },
  collectionRowHover: {
    backgroundColor: theme.semantic.color.interactiveHoverSurface,
    ...theme.semantic.motion.transition.control,
  },
  collectionRowPressed: {
    backgroundColor: theme.semantic.color.interactivePressedSurface,
    ...theme.semantic.motion.transition.control,
  },
  collectionRowHorizontal: {
    height: theme.recipes.managementWorkspace.rowMinHeight,
    width: theme.recipes.managementWorkspace.collectionCompactRowWidth,
  },
  collectionRowSelected: {backgroundColor: theme.semantic.color.selectionSurface},
  collectionRowSelectedHover: {
    backgroundColor: theme.semantic.color.selectionHoverSurface,
    ...theme.semantic.motion.transition.control,
  },
  collectionRowSelectedPressed: {
    backgroundColor: theme.semantic.color.selectionPressedSurface,
    ...theme.semantic.motion.transition.control,
  },
  codeBlock: {
    backgroundColor: theme.semantic.color.codeSurface,
    borderRadius: theme.semantic.radius.control,
    maxHeight: theme.recipes.contentMeasure.codeBlockMaxHeight,
    padding: theme.spacing.md,
  },
  codeBlockText: {
    color: theme.semantic.color.codeText,
    ...theme.semantic.typography.meta,
  },
  detailSection: {
    alignSelf: "stretch",
    backgroundColor: theme.semantic.color.sectionSurface,
    borderRadius: theme.semantic.radius.pane,
    borderTopColor: theme.semantic.color.separator,
    borderTopWidth: theme.semantic.stroke.hairline,
    gap: theme.recipes.managementWorkspace.sectionGap,
    paddingHorizontal: 0,
    paddingVertical: theme.recipes.managementWorkspace.sectionPadding,
  },
  detailCanvas: {
    alignSelf: "center",
    borderRadius: theme.semantic.radius.pane,
    gap: theme.recipes.managementWorkspace.detailGap,
    maxWidth: theme.recipes.managementWorkspace.contentMaxWidth,
    paddingVertical: theme.recipes.managementWorkspace.mediumPadding,
    width: "100%",
  },
  detailHeading: {
    alignItems: "flex-start",
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.lg,
    paddingBottom: theme.spacing.lg,
  },
  detailHeadingCopy: {
    flex: 1,
    gap: theme.spacing.xs,
    minWidth: 0,
  },
  detailHeadingMetadata: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  detailHeadingTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.detailTitle,
  },
  detailScroll: {
    flex: 1,
    minWidth: 0,
  },
  detailScrollContent: {
    flexGrow: 1,
    paddingHorizontal: theme.recipes.managementWorkspace.desktopPadding,
  },
  detailScrollContentCompact: {
    paddingHorizontal: theme.recipes.managementWorkspace.compactPadding,
  },
  detailScrollContentMedium: {
    paddingHorizontal: theme.recipes.managementWorkspace.mediumPadding,
  },
  disabled: {opacity: theme.semantic.interaction.disabledOpacity},
  empty: {
    alignItems: "center",
    alignSelf: "stretch",
    flexGrow: 1,
    gap: theme.spacing.lg,
    justifyContent: "center",
    minHeight: theme.recipes.emptyState.stageMinHeight,
    paddingHorizontal: theme.recipes.managementWorkspace.compactPadding,
    paddingVertical: theme.recipes.managementWorkspace.desktopPadding,
    borderRadius: theme.semantic.radius.pane,
  },
  emptyCopy: {
    alignItems: "center",
    gap: theme.spacing.xs,
    maxWidth: theme.recipes.contentMeasure.compactMaxWidth,
  },
  emptyAction: {
    alignItems: "center",
  },
  emptyDescription: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.body,
    textAlign: "center",
  },
  emptyIcon: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceTransparent,
    borderRadius: theme.semantic.radius.pane,
    height: theme.recipes.emptyState.iconSize,
    justifyContent: "center",
    width: theme.recipes.emptyState.iconSize,
  },
  emptyTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.sectionTitle,
  },
  feedback: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.statusDangerSurface,
    borderBottomColor: theme.semantic.color.statusDangerDivider,
    borderBottomWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.pane,
    flexDirection: "row",
    gap: theme.spacing.sm,
    minHeight: theme.recipes.status.inlineMinHeight,
    paddingHorizontal: theme.spacing.xl,
    paddingVertical: theme.spacing.sm,
  },
  feedbackDot: {
    backgroundColor: theme.semantic.color.statusDanger,
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.identity.statusDotSize,
    width: theme.recipes.identity.statusDotSize,
  },
  feedbackDotPositive: {backgroundColor: theme.semantic.color.statusPositive},
  feedbackPositive: {
    backgroundColor: theme.semantic.color.statusPositiveSurface,
    borderBottomColor: theme.semantic.color.statusPositiveDivider,
  },
  feedbackText: {
    color: theme.semantic.color.statusDangerText,
    ...theme.semantic.typography.label,
  },
  feedbackTextPositive: {color: theme.semantic.color.statusPositiveText},
  field: {
    flexGrow: 0,
    gap: theme.spacing.xs,
    minWidth: 0,
    width: "100%",
  },
  fieldCompact: {
    width: theme.recipes.managementWorkspace.fieldCompactWidth,
  },
  fieldError: {
    color: theme.semantic.color.statusDangerText,
    ...theme.semantic.typography.meta,
  },
  fieldFlex: {
    flex: 1,
    minWidth: theme.recipes.managementWorkspace.formFieldMinWidth,
  },
  fieldHint: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  fieldLabel: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.label,
  },
  form: {
    alignSelf: "center",
    backgroundColor: theme.semantic.color.sectionSurface,
    borderColor: theme.semantic.color.borderSection,
    borderRadius: theme.semantic.radius.section,
    borderWidth: theme.semantic.stroke.hairline,
    gap: theme.spacing.md,
    marginVertical: theme.spacing.xl,
    maxWidth: theme.recipes.managementWorkspace.formMaxWidth,
    padding: theme.spacing.xl,
    width: "100%",
  },
  formActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
    justifyContent: "flex-end",
  },
  eyebrow: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.eyebrow,
  },
  header: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.paneSurface,
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.lg,
    minHeight: theme.recipes.managementWorkspace.headerHeight,
    paddingHorizontal: theme.spacing.xl,
  },
  headerActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  headerCopy: {flex: 1, gap: theme.spacing.xxs, minWidth: 0},
  headerTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.pageTitle,
  },
  notice: {
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
  },
  noticeActions: {
    flexShrink: 0,
  },
  noticeCopy: {
    flex: 1,
    gap: theme.spacing.xxs,
    minWidth: 0,
  },
  noticeDanger: {
    backgroundColor: theme.semantic.color.statusDangerSurface,
    borderBottomColor: theme.semantic.color.statusDangerDivider,
  },
  noticeDescription: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodyCompact,
  },
  noticeHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: theme.spacing.md,
    justifyContent: "space-between",
  },
  noticeInfo: {
    backgroundColor: theme.semantic.color.statusInfoSurface,
    borderBottomColor: theme.semantic.color.statusInfoDivider,
  },
  noticePositive: {
    backgroundColor: theme.semantic.color.statusPositiveSurface,
    borderBottomColor: theme.semantic.color.statusPositiveDivider,
  },
  noticeTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.sectionTitle,
  },
  noticeWarning: {
    backgroundColor: theme.semantic.color.statusWarningSurface,
    borderBottomColor: theme.semantic.color.statusWarningDivider,
  },
  resourceActionControl: {
    flexShrink: 0,
  },
  resourceIdentityCopy: {
    flex: 1,
    gap: theme.spacing.xxs,
    minWidth: 0,
  },
  resourceIdentityHeader: {
    alignItems: "center",
    borderBottomWidth: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.lg,
    paddingBottom: theme.recipes.resourceIdentity.headerPaddingBottom,
  },
  resourceIdentityMark: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.iconAccentSurface,
    borderRadius: theme.semantic.radius.control,
    height: theme.recipes.resourceIdentity.markSize,
    justifyContent: "center",
    width: theme.recipes.resourceIdentity.markSize,
  },
  resourceIdentityMarkAgent: {
    backgroundColor: theme.semantic.color.avatarAgentSurface,
  },
  resourceIdentityMarkHuman: {
    backgroundColor: theme.semantic.color.avatarHumanVioletSurface,
  },
  resourceIdentityMetadata: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  resourceIdentityMonogram: {
    color: theme.semantic.color.iconAccent,
    ...theme.semantic.typography.sectionTitle,
  },
  resourceIdentityMonogramAgent: {
    color: theme.semantic.color.avatarAgentText,
  },
  resourceIdentityMonogramHuman: {
    color: theme.semantic.color.avatarHumanVioletText,
  },
  resourceIdentityPrimary: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing.md,
    minWidth: 0,
  },
  resourceIdentityTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.pageTitle,
  },
  recordIdentityCopy: {
    flex: 1,
    gap: theme.spacing.xs,
    minWidth: 0,
  },
  recordIdentityHeader: {
    alignItems: "flex-start",
    borderBottomWidth: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.lg,
    paddingBottom: theme.recipes.resourceIdentity.headerPaddingBottom,
  },
  recordIdentityReference: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.eyebrow,
  },
  recordIdentityTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.detailTitle,
  },
  resourceFact: {
    flexBasis: 0,
    flexGrow: 1,
    gap: theme.spacing.xs,
    justifyContent: "center",
    minHeight: theme.recipes.resourceIdentity.factMinHeight,
    minWidth: theme.recipes.resourceIdentity.factMinWidth,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  resourceFactLabel: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.eyebrow,
  },
  resourceFactStrip: {
    backgroundColor: theme.semantic.color.sectionSurface,
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    borderTopColor: theme.semantic.color.separator,
    borderTopWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    flexWrap: "wrap",
  },
  resourceFactValue: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodyEmphasis,
  },
  resourceMetadataLabel: {
    color: theme.semantic.color.textMuted,
    flexBasis: 96,
    flexShrink: 0,
    ...theme.semantic.typography.bodyCompact,
  },
  resourceMetadataList: {
    borderTopColor: theme.semantic.color.separator,
    borderTopWidth: theme.semantic.stroke.hairline,
    flexDirection: "column",
  },
  resourceMetadataRow: {
    alignItems: "center",
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.lg,
    minHeight: theme.recipes.managementWorkspace.rowMinHeight,
    paddingVertical: theme.spacing.sm,
  },
  resourceMetadataValue: {
    color: theme.semantic.color.textPrimary,
    flex: 1,
    minWidth: 0,
    ...theme.semantic.typography.bodyEmphasis,
  },
  resourceActionCopy: {
    flex: 1,
    gap: theme.spacing.xs,
    minWidth: theme.recipes.managementWorkspace.resourceActionCopyMinWidth,
  },
  resourceActionDescription: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodyCompact,
  },
  resourceActionRow: {
    alignItems: "center",
    borderTopColor: theme.semantic.color.separator,
    borderTopWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.md,
    minHeight: theme.recipes.managementWorkspace.resourceActionMinHeight,
    paddingVertical: theme.spacing.md,
  },
  resourceActionTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodyEmphasis,
  },
  resourceSwitcher: {
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    padding: theme.spacing.sm,
    width: "100%",
    ...theme.semantic.motion.transition.control,
  },
  resourceSwitcherChevronOpen: {
    transform: [{rotate: "180deg"}],
  },
  resourceSwitcherMenu: {
    maxHeight: theme.recipes.managementWorkspace.switcherMenuMaxHeight,
  },
  resourceSwitcherMenuContent: {
    gap: theme.spacing.xs,
    paddingTop: theme.spacing.xs,
  },
  resourceSwitcherHover: {
    backgroundColor: theme.semantic.color.interactiveHoverSurface,
    ...theme.semantic.motion.transition.control,
  },
  resourceSwitcherOption: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionSecondarySurface,
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.sm,
    minHeight: theme.recipes.managementWorkspace.switcherOptionMinHeight,
    paddingHorizontal: theme.spacing.md,
    width: "100%",
  },
  resourceSwitcherPressed: {
    backgroundColor: theme.semantic.color.interactivePressedSurface,
    ...theme.semantic.motion.transition.control,
  },
  resourceSwitcherTrigger: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.sectionSurface,
    borderColor: theme.semantic.color.borderInteractive,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.sm,
    minHeight: theme.recipes.managementWorkspace.switcherTriggerMinHeight,
    paddingHorizontal: theme.spacing.md,
    width: "100%",
  },
  selectionButton: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionSecondarySurface,
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    justifyContent: "center",
    minHeight: theme.recipes.control.height,
    minWidth: theme.recipes.control.height,
    paddingHorizontal: theme.spacing.md,
    ...theme.semantic.motion.transition.control,
  },
  selectionButtonEqual: {
    flex: 1,
    minWidth: 0,
  },
  selectionButtonHover: {
    backgroundColor: theme.semantic.color.interactiveHoverSurface,
    ...theme.semantic.motion.transition.control,
  },
  selectionButtonPressed: {
    backgroundColor: theme.semantic.color.interactivePressedSurface,
    ...theme.semantic.motion.transition.control,
  },
  selectionButtonSelected: {
    backgroundColor: theme.semantic.color.selectionSurface,
    borderColor: theme.semantic.color.borderSelected,
    ...theme.semantic.motion.transition.control,
  },
  selectionButtonSelectedHover: {
    backgroundColor: theme.semantic.color.selectionHoverSurface,
    ...theme.semantic.motion.transition.control,
  },
  selectionButtonSelectedPressed: {
    backgroundColor: theme.semantic.color.selectionPressedSurface,
    ...theme.semantic.motion.transition.control,
  },
  selectionButtonText: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.label,
  },
  selectionGroup: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  selectionGroupInset: {
    padding: theme.spacing.sm,
  },
  tab: {
    alignItems: "center",
    borderBottomColor: theme.semantic.color.borderTransparent,
    borderBottomWidth: theme.semantic.stroke.statusRing,
    borderRadius: theme.semantic.radius.pane,
    justifyContent: "center",
    minHeight: theme.semantic.interaction.minimumTargetSize,
    paddingHorizontal: theme.spacing.md,
    ...theme.semantic.motion.transition.control,
  },
  tabBar: {
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.sm,
  },
  tabHover: {
    backgroundColor: theme.semantic.color.interactiveHoverSurface,
    ...theme.semantic.motion.transition.control,
  },
  tabPressed: {
    backgroundColor: theme.semantic.color.interactivePressedSurface,
    ...theme.semantic.motion.transition.control,
  },
  tabSelected: {
    borderBottomColor: theme.semantic.color.actionPrimarySurface,
    ...theme.semantic.motion.transition.control,
  },
  tabText: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.label,
    ...theme.semantic.motion.transition.control,
  },
  tabTextSelected: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.motion.transition.control,
  },
  sectionDescription: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodyCompact,
  },
  sectionHeading: {gap: theme.spacing.xs},
  sectionTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.sectionTitle,
  },
  stage: {
    alignSelf: "stretch",
    backgroundColor: theme.semantic.color.canvasSurface,
    borderRadius: theme.semantic.radius.pane,
    flex: 1,
    minWidth: 0,
  },
  status: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: theme.semantic.color.statusNeutralSurface,
    borderRadius: theme.semantic.radius.pill,
    flexDirection: "row",
    gap: theme.spacing.sm,
    minHeight: theme.recipes.status.chipMinHeight,
    paddingHorizontal: theme.spacing.sm,
  },
  statusDanger: {backgroundColor: theme.semantic.color.statusDangerSurface},
  statusInfo: {backgroundColor: theme.semantic.color.statusInfoSurface},
  statusPositive: {backgroundColor: theme.semantic.color.statusPositiveSurface},
  statusWarning: {backgroundColor: theme.semantic.color.statusWarningSurface},
  statusDot: {
    backgroundColor: theme.semantic.color.statusNeutral,
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.identity.statusDotSize,
    width: theme.recipes.identity.statusDotSize,
  },
  statusDotDanger: {backgroundColor: theme.semantic.color.statusDanger},
  statusDotInfo: {backgroundColor: theme.semantic.color.statusInfo},
  statusDotPositive: {backgroundColor: theme.semantic.color.statusPositive},
  statusDotWarning: {backgroundColor: theme.semantic.color.statusWarning},
  statusText: {
    color: theme.semantic.color.statusNeutralText,
    ...theme.semantic.typography.label,
  },
  statusTextDanger: {color: theme.semantic.color.statusDangerText},
  statusTextInfo: {color: theme.semantic.color.statusInfoText},
  statusTextPositive: {color: theme.semantic.color.statusPositiveText},
  statusTextWarning: {color: theme.semantic.color.statusWarningText},
  summary: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  textInput: {
    backgroundColor: theme.semantic.color.fieldSurface,
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    color: theme.semantic.color.textPrimary,
    minHeight: theme.recipes.managementWorkspace.fieldHeight,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    ...theme.semantic.typography.body,
    width: "100%",
  },
  textInputInvalid: {
    borderColor: theme.semantic.color.borderDangerStrong,
  },
  textInputMultiline: {
    minHeight: theme.recipes.managementWorkspace.textareaMinHeight,
    textAlignVertical: "top",
  },
}));
