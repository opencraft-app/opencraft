import type {LucideIcon} from "lucide-react-native";
import ChevronDown from "lucide-react-native/icons/chevron-down";
import Plus from "lucide-react-native/icons/plus";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import type {ReactNode} from "react";
import {useState} from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import {useUnistyles} from "react-native-unistyles";

import {styles} from "./management-workspace.styles";

import {SystemButton, SystemIconButton} from "../primitives/system-button";
import {SystemSelect} from "../primitives/system-select";
import type {SystemSelectOption} from "../primitives/system-select";
import {SystemEmptyState} from "../primitives/system-empty-state";
import {SystemSourceListRow} from "../primitives/system-source-list-row";

type StatusTone = "danger" | "info" | "neutral" | "positive" | "warning";
type ManagementDensity = "comfortable" | "compact" | "medium";

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
          color={theme.semantic.color.iconSecondary}
          size={theme.semantic.icon.size.medium}
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

export interface ManagementResourceDirectoryProps {
  children: ReactNode;
  eyebrow?: string;
  footer?: ReactNode;
  /** When true, rows scroll horizontally (compact chrome / stacked collection). */
  horizontal?: boolean;
  icon?: LucideIcon;
  /**
   * When false, children own scrolling (tasks lists already wrap a ScrollView).
   * Default true for agent/member/computer row directories.
   */
  scroll?: boolean;
  testID?: string;
  title?: string;
  /** Tabs / inbox band between the header and the row list. */
  toolbar?: ReactNode;
}

/**
 * Collection sidebar scaffold shared by agents / members / computers / tasks.
 * Header is omitted when horizontal — stacked strips have no room for it.
 */
export function ManagementResourceDirectory({
  children,
  eyebrow,
  footer,
  horizontal = false,
  icon,
  scroll = true,
  testID = "management-resource-directory",
  title,
  toolbar,
}: ManagementResourceDirectoryProps) {
  return (
    <ManagementCollectionPane
      orientation={horizontal ? "horizontal" : "vertical"}
      testID={testID}
    >
      {!horizontal && title && icon && eyebrow ? (
        <ManagementCollectionHeader
          eyebrow={eyebrow}
          icon={icon}
          title={title}
        />
      ) : null}
      {toolbar}
      {scroll ? (
        <ScrollView
          contentContainerStyle={[
            styles.resourceDirectoryList,
            horizontal && styles.resourceDirectoryListStacked,
          ]}
          horizontal={horizontal}
          showsHorizontalScrollIndicator={false}
          style={styles.resourceDirectoryScroller}
        >
          {children}
        </ScrollView>
      ) : (
        children
      )}
      {footer}
    </ManagementCollectionPane>
  );
}

export function CollectionRowCopy({
  meta,
  numberOfLines,
  title,
}: {
  meta: string;
  numberOfLines?: number;
  title: string;
}) {
  return (
    <View style={styles.collectionRowCopy}>
      <Text numberOfLines={numberOfLines} style={styles.collectionRowTitle}>
        {title}
      </Text>
      <Text numberOfLines={numberOfLines} style={styles.collectionRowMeta}>
        {meta}
      </Text>
    </View>
  );
}

export interface ManagementHeaderActionsProps {
  children?: ReactNode;
  createAccessibilityLabel?: string;
  createIconTestID?: string;
  createLabel?: string;
  createVisible?: boolean;
  onCreate?(): void;
  onRefresh?(): void | Promise<void>;
  refreshAccessibilityLabel?: string;
  refreshDisabled?: boolean;
  refreshTestID?: string;
}

/** Refresh icon + optional tonal create — the management stage header cluster. */
export function ManagementHeaderActions({
  children,
  createAccessibilityLabel,
  createIconTestID,
  createLabel,
  createVisible = false,
  onCreate,
  onRefresh,
  refreshAccessibilityLabel,
  refreshDisabled = false,
  refreshTestID,
}: ManagementHeaderActionsProps) {
  return (
    <View style={styles.headerActionsCluster}>
      {onRefresh && refreshAccessibilityLabel ? (
        <SystemIconButton
          accessibilityLabel={refreshAccessibilityLabel}
          disabled={refreshDisabled}
          icon={RefreshCw}
          onPress={onRefresh}
          testID={refreshTestID}
        />
      ) : null}
      {createVisible && onCreate && createLabel && createAccessibilityLabel ? (
        <SystemButton
          accessibilityLabel={createAccessibilityLabel}
          icon={Plus}
          iconTestID={createIconTestID}
          variant="toolbar"
          label={createLabel}
          onPress={onCreate}
        />
      ) : null}
      {children}
    </View>
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

/**
 * Stage body that fills remaining height instead of scrolling — terminals and
 * other viewport-owned surfaces. Padding tracks the same density ladder as
 * {@link ManagementDetailScroll}.
 */
export function ManagementStageFill({
  children,
  density = "comfortable",
  testID = "management-stage-fill",
}: ManagementDetailScrollProps) {
  return (
    <View
      style={[
        styles.stageFill,
        density === "medium" && styles.stageFillMedium,
        density === "compact" && styles.stageFillCompact,
      ]}
      testID={testID}
    >
      {children}
    </View>
  );
}

export function ManagementDetailCanvas({
  children,
  testID = "management-detail-canvas",
}: SemanticContainerProps) {
  return <View style={styles.detailCanvas} testID={testID}>{children}</View>;
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
      : theme.semantic.color.iconSecondary;
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
              color={
                identityKind === "resource"
                  ? theme.semantic.color.iconSecondary
                  : theme.semantic.color.iconAccent
              }
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
  return (
    <SystemSourceListRow
      accessibilityLabel={accessibilityLabel ?? "打开资源"}
      disabled={disabled}
      kind="button"
      onPress={onPress}
      orientation={orientation}
      rowId={testID ?? accessibilityLabel ?? "resource-row"}
      selected={selected}
      testID={testID}
    >
      {children}
    </SystemSourceListRow>
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
          {description ? (
            <Text style={styles.sectionDescription}>{description}</Text>
          ) : null}
        </View>
      ) : null}
      <View style={styles.detailSectionBody} testID={`${testID}-body`}>
        {children}
      </View>
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

export interface ManagementResourceSelectProps {
  accessibilityLabel: string;
  currentContent: ReactNode;
  onChange(value: string): void;
  onOpenChange(open: boolean): void;
  open: boolean;
  options: readonly SystemSelectOption<string>[];
  testID?: string;
  value: string;
}

export function ManagementResourceSelect({
  accessibilityLabel,
  currentContent,
  onChange,
  onOpenChange,
  open,
  options,
  testID = "management-resource-switcher",
  value,
}: ManagementResourceSelectProps) {
  const {theme} = useUnistyles();
  const [hovered, setHovered] = useState(false);
  return (
    <View style={styles.resourceSwitcher} testID={testID}>
      <SystemSelect
        accessibilityLabel={accessibilityLabel}
        onChange={onChange}
        onOpenChange={onOpenChange}
        open={open}
        options={options}
        overlayId={`${testID}-listbox`}
        renderTrigger={({
          accessibilityControls,
          accessibilityExpanded,
          onPress,
          ref,
        }) => (
            <Pressable
              accessibilityLabel={accessibilityLabel}
              accessibilityRole="button"
              aria-controls={accessibilityControls}
              aria-expanded={accessibilityExpanded}
              onHoverIn={() => setHovered(true)}
              onHoverOut={() => setHovered(false)}
              onPress={onPress}
              ref={ref as never}
              style={({pressed}) => [
                styles.resourceSwitcherTrigger,
                hovered && styles.resourceSwitcherHover,
                pressed && styles.resourceSwitcherPressed,
              ]}
              testID={`${testID}-trigger`}
            >
              {currentContent}
              <View style={open && styles.resourceSwitcherChevronOpen}>
                <ChevronDown
                  color={theme.semantic.color.iconMuted}
                  size={theme.semantic.icon.size.medium}
                  strokeWidth={theme.semantic.icon.stroke.emphasis}
                />
              </View>
            </Pressable>
        )}
        value={value}
      />
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
  return (
    <SystemEmptyState
      description={description}
      icon={Icon}
      kind="canvas"
      primaryAction={
        actionLabel && onAction
          ? {
              accessibilityLabel: actionAccessibilityLabel,
              busy: actionBusy,
              disabled: actionDisabled,
              label: actionLabel,
              onPress: onAction,
              variant: "default",
            }
          : undefined
      }
      testID={testID}
      title={title}
    />
  );
}
