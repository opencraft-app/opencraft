import {
  createTimelineTurnPresentationPlan,
  assistantMessageActions,
  compactionLabel,
  todoSummary,
  skillReadPresentation,
  type ConversationDetailLevel,
  createDefaultToolActivityPresenterRegistry,
  codexAppThreadNavigationTarget,
  createdThreadToolResult,
  createMcpElicitationDraft,
  createUserInputQuestionDrafts,
  aggregateUserInputQuestionAnswers,
  agentActivityHeaderAccessibleLabel,
  deriveAgentActivityHeaderPresentation,
  deriveSubagentActivityGroupPresentation,
  extractToolCallContentParts,
  formatThreadHandoffStepLabel,
  formatCodexToolDuration,
  formatWorkDuration,
  workStatusLabelText,
  resolveAgentActivityLayout,
  formatCommandActivitySummary,
  formatHookEventName,
  formatHookSource,
  formatAutomaticApprovalReviewSummary,
  formatAutomaticApprovalReviewTitle,
  groupTimelineFramesByTurn,
  isAutomaticApprovalReviewWarning,
  isCodexAppThreadTool,
  isVisibleAgentActivityRow,
  normalizeMcpElicitationSchema,
  presentApprovalRequest,
  presentAutomationUpdate,
  presentMcpElicitationDisplayValue,
  presentToolActivity,
  summarizeAutomaticApprovalReviewAction,
  threadHandoffToolResult,
  visibleThreadHandoffSteps,
  type AgentActivityRenderUnit,
  type AgentActivityGroupContentUnit,
  type AgentActivityContentUnit,
  type WorkStatusItem,
  type AssistantTurnPresentationPlan,
  type AutomaticApprovalReview,
  type AutomationUpdateTimelineBlock,
  type HookStats,
  type AttachedInteractionTimelineBlock,
  type SubagentActivityRenderUnit,
  type TimelineBlock,
  type TimelineFrame,
  type TimelineSnapshot,
  type TimelineTurnView,
  type UserMessageTimelineBlock,
  type ToolActivityIcon,
  type ToolActivityPresentation,
  type ToolActivityPresenterRegistry,
  type ToolCallContentPart,
  type WebMcpToolSurfaceCall,
  type McpElicitationDraft,
  type McpElicitationDraftValue,
  type UserInputQuestionDraft,
  validateMcpElicitationDraft,
} from "@opencraft/chat-core";
import type { Context } from "@deepseek-ai/cordis";
import { NativeChatDocument } from "@opencraft/chat-render-native";
import {
  TimelineBlockView,
  useWorkStatusLabel,
  type TimelineBlockRendererProps,
  type TimelineBlockRendererRegistration,
} from "@opencraft/timeline-render-react";
import {
  type TurnConversationScrollApi,
  type LatestTurnPlacementSnapshot,
  type VirtualizedTurnListApi,
} from "@opencraft/timeline-virtualizer";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  BookOpen,
  CalendarClock,
  Check,
  Circle,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileCode2,
  FileSearch,
  Folder,
  ImageIcon,
  ListChecks,
  MessageSquare,
  Monitor,
  Search,
  ShieldCheck,
  Globe2,
  Square,
  TerminalSquare,
  WandSparkles,
  Wrench,
  X,
} from "lucide-react-native";
import {
  codexSetupContextSourceExamples,
  codexSetupRoleOptions,
  codexSetupTaskOptions,
  type SetupCodexContextSource,
  type WorkbenchInteractionAction,
} from "@opencraft/workbench-runtime";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Animated,
  ActivityIndicator,
  AccessibilityInfo,
  Easing,
  Image,
  Linking,
  type LayoutChangeEvent,
  Platform,
  ScrollView,
  Text,
  TextInput,
  type StyleProp,
  type TextStyle,
  View,
} from "react-native";
import Svg, { Circle as SvgCircle, Path as SvgPath } from "react-native-svg";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
  NativeResponsePositionedTurns,
  type WorkbenchConversationRestoreSnapshot,
} from "./native-response-positioned-turns";
import { useNativeUserMessageCollapse } from "./use-native-user-message-collapse";
import { Button, IconButton } from "./ui/button";
import { InteractiveSurface } from "./ui/interactive-surface";

function JsonPreview({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return <Text selectable style={styles.output}>{text}</Text>;
}

const DEFAULT_TOOL_ACTIVITY_PRESENTERS = createDefaultToolActivityPresenterRegistry();
const NativeToolActivityPresenterContext = createContext<ToolActivityPresenterRegistry>(DEFAULT_TOOL_ACTIVITY_PRESENTERS);
const NativeConversationDetailContext = createContext<ConversationDetailLevel>("STEPS_COMMANDS");
const NativeCopyTextContext = createContext<((text: string) => Promise<void>) | null>(null);
const NativeLatestTurnFollowContentContext = createContext<((event: LayoutChangeEvent) => void) | null>(null);

export type NativeToolCallContentRenderer = (
  block: Extract<TimelineBlock, { type: "tool-call" }>,
  presentation: ToolActivityPresentation,
) => ReactNode | undefined;

const NativeToolCallContentRendererContext = createContext<NativeToolCallContentRenderer | null>(null);

/** Native host seam for MCP app, plugin, browser, and installed-app artwork. */
export type NativeToolCallIconRenderer = (
  block: Extract<TimelineBlock, { type: "tool-call" }>,
  presentation: ToolActivityPresentation,
) => ReactNode | undefined;

const NativeToolCallIconRendererContext = createContext<NativeToolCallIconRenderer | null>(null);
const NativeThreadNavigationContext = createContext<((threadId: string, displayName: string) => void) | null>(null);

interface NativeDocumentHostValue {
  readonly openResource: ((path: string) => void) | null;
  readonly reviewTurnDiff: ((block: Extract<TimelineBlock, { type: "turn-diff" }>, path?: string) => void) | null;
}

const NativeDocumentHostContext = createContext<NativeDocumentHostValue>({ openResource: null, reviewTurnDiff: null });

interface NativeImageViewHostValue {
  readonly open: ((path: string) => void) | null;
  readonly resolveSource: ((path: string) => string | null) | null;
}

const NativeImageViewHostContext = createContext<NativeImageViewHostValue>({ open: null, resolveSource: null });

interface NativeGeneratedImageHostValue {
  readonly open: ((block: Extract<TimelineBlock, { type: "image" }>) => void) | null;
  readonly resolveSource: ((block: Extract<TimelineBlock, { type: "image" }>) => string | null) | null;
}

const NativeGeneratedImageHostContext = createContext<NativeGeneratedImageHostValue>({ open: null, resolveSource: null });

function nativeActivityIcon(icon: ToolActivityIcon, color: string, size: number): ReactNode {
  if (icon === "none") return null;
  const common = { color, size, strokeWidth: 1.8 };
  if (icon === "terminal") return <TerminalSquare {...common} />;
  if (icon === "patch") return <FileCode2 {...common} />;
  if (icon === "search") return <Search {...common} />;
  if (icon === "read") return <BookOpen {...common} />;
  if (icon === "files") return <Folder {...common} />;
  if (icon === "stop") return <Square {...common} size={Math.max(10, size - 2)} />;
  if (icon === "image") return <ImageIcon {...common} />;
  if (icon === "agent") return <Bot {...common} />;
  if (icon === "browser") return <Globe2 {...common} />;
  if (icon === "computer") return <Monitor {...common} />;
  return <Wrench {...common} />;
}

function useNativeActivityOpen(running: boolean, defaultExpanded = false): readonly [boolean, (next: boolean) => void] {
  const [runningCollapsed, setRunningCollapsed] = useState(false);
  const [settledExpanded, setSettledExpanded] = useState(defaultExpanded);
  const open = running ? !runningCollapsed : settledExpanded;
  const setOpen = useCallback((next: boolean) => {
    if (running) setRunningCollapsed(!next);
    else setSettledExpanded(next);
  }, [running]);
  return [open, setOpen];
}

/** Native adaptation of Codex's readable-base, 600/1000/4000ms cadenced sweep. */
function NativeCadencedText({
  active,
  children,
  numberOfLines,
  style,
}: {
  readonly active: boolean;
  readonly children: ReactNode;
  readonly numberOfLines?: number;
  readonly style: StyleProp<TextStyle>;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);
  const [width, setWidth] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (live) setReduceMotion(value); });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    animationRef.current?.stop();
    progress.setValue(0);
    if (!active || reduceMotion || width <= 0) return;
    const sweep = () => {
      animationRef.current?.stop();
      progress.setValue(0);
      animationRef.current = Animated.timing(progress, {
        duration: 1_000,
        easing: (value) => Math.floor(value * 48) / 48,
        toValue: 1,
        useNativeDriver: true,
      });
      animationRef.current.start();
    };
    const initialTimer = setTimeout(sweep, 600);
    const interval = setInterval(sweep, 4_000);
    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
      animationRef.current?.stop();
      animationRef.current = null;
      progress.setValue(0);
    };
  }, [active, progress, reduceMotion, width]);
  const sweepWidth = Math.min(72, Math.max(32, width * 0.28));
  const sweepX = progress.interpolate({ inputRange: [0, 1], outputRange: [-sweepWidth, width + sweepWidth] });
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={styles.cadencedText}
    >
      <Text numberOfLines={numberOfLines} style={style}>{children}</Text>
      {active && !reduceMotion && width > 0 ? (
        <Animated.View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={[styles.cadencedTextSweep, { width: sweepWidth, transform: [{ translateX: sweepX }] }]}
        >
          <Animated.View style={{ width, transform: [{ translateX: Animated.multiply(sweepX, -1) }] }}>
            <Text numberOfLines={numberOfLines} style={[style, styles.cadencedTextHighlight]}>{children}</Text>
          </Animated.View>
        </Animated.View>
      ) : null}
    </View>
  );
}

function useToolActivityPresentation(
  block: Extract<TimelineBlock, { type: "command-execution" | "patch" | "tool-call" | "subagent" }>,
): ToolActivityPresentation {
  const registry = useContext(NativeToolActivityPresenterContext);
  const version = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  return useMemo(() => presentToolActivity(block, registry), [block, registry, version]);
}

function NativeActivityDisclosure({
  accessory,
  children,
  detail,
  icon,
  open,
  onOpenChange,
  presentation,
  summary,
  trailing,
}: {
  readonly accessory?: ReactNode;
  readonly children?: ReactNode;
  readonly detail?: string | null;
  readonly icon: ReactNode;
  readonly open: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly presentation: Pick<ToolActivityPresentation, "state">;
  readonly summary: string;
  readonly trailing?: ReactNode;
}) {
  const { theme } = useUnistyles();
  const expandable = children !== null && children !== undefined && onOpenChange !== undefined;
  const header = <>
    <View style={styles.activityDisclosureTitleRow}>
      <View style={styles.activityDisclosureIcon}>{icon}</View>
      <NativeCadencedText
        active={presentation.state === "running"}
        numberOfLines={2}
        style={styles.activityDisclosureSummary}
      >{summary}</NativeCadencedText>
      {detail ? <Text numberOfLines={2} style={styles.activityDisclosureDetail}>{detail}</Text> : null}
    </View>
    {trailing}
    {accessory}
    {expandable ? <ChevronRight color={theme.color.icon.tertiary} size={theme.metrics.control.iconSmall} style={open ? styles.chevronOpen : undefined} /> : null}
  </>;
  return (
    <View style={styles.activityDisclosure}>
      {expandable ? (
        <InteractiveSurface
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => onOpenChange(!open)}
          style={styles.activityDisclosureHeader}
        >{header}</InteractiveSurface>
      ) : <View style={styles.activityDisclosureHeader}>{header}</View>}
      {expandable && open ? <View style={styles.activityDisclosureBody}>{children}</View> : null}
    </View>
  );
}

function elicitationDraftText(value: McpElicitationDraftValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function ReasoningBlock({ block }: { block: Extract<TimelineBlock, { type: "reasoning" }> }) {
  const [open, setOpen] = useState(false);
  const { theme } = useUnistyles();
  const expandable = block.detail !== null && block.detail.trim() !== "";
  const header = <>
    <View style={[styles.reasoningDot, block.streaming ? styles.reasoningActive : styles.reasoningDone]} />
    <Text numberOfLines={open ? undefined : 1} style={styles.reasoningTitle}>{block.summary || "Reasoning"}</Text>
    {expandable ? <ChevronRight color={theme.color.icon.tertiary} size={theme.metrics.control.iconSmall} strokeWidth={1.8} style={open ? styles.chevronOpen : undefined} /> : null}
  </>;
  return (
    <View style={styles.reasoning}>
      {expandable
        ? <InteractiveSurface onPress={() => setOpen((value) => !value)} style={styles.reasoningButton}>{header}</InteractiveSurface>
        : <View style={styles.reasoningButton}>{header}</View>}
      {expandable && open ? <Text style={styles.reasoningDetail}>{block.detail}</Text> : null}
    </View>
  );
}

function NativeAutomaticApprovalReviewRow({ review }: { readonly review: AutomaticApprovalReview }) {
  const { theme } = useUnistyles();
  const [open, setOpen] = useState(false);
  const warning = isAutomaticApprovalReviewWarning(review);
  return (
    <View style={styles.autoReview}>
      <InteractiveSurface accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)} style={styles.autoReviewHeader}>
        <NativeCadencedText
          active={review.status === "inProgress"}
          numberOfLines={1}
          style={[styles.autoReviewTitle, warning && styles.autoReviewWarning]}
        >{formatAutomaticApprovalReviewTitle(review)}</NativeCadencedText>
        <ChevronRight color={warning ? theme.color.accent.negative : theme.color.icon.tertiary} size={theme.metrics.control.iconSmall} style={open ? styles.chevronOpen : undefined} />
      </InteractiveSurface>
      {open ? <Text style={styles.autoReviewSummary}>{formatAutomaticApprovalReviewSummary(review)}</Text> : null}
    </View>
  );
}

function NativeAutomaticApprovalReviewList({ reviews }: { readonly reviews: readonly AutomaticApprovalReview[] }) {
  if (reviews.length === 0) return null;
  return <View style={styles.autoReviewList}>{reviews.map((review) => <NativeAutomaticApprovalReviewRow key={review.id} review={review} />)}</View>;
}

function NativeAutomaticApprovalReviewBlock({ block }: { readonly block: Extract<TimelineBlock, { type: "automatic-approval-review" }> }) {
  const { theme } = useUnistyles();
  const [open, setOpen] = useState(block.review.status === "inProgress");
  const state: ToolActivityPresentation["state"] = block.review.status === "inProgress" ? "running"
    : isAutomaticApprovalReviewWarning(block.review) ? "failed" : "completed";
  return (
    <NativeActivityDisclosure
      icon={<Wrench color={theme.color.icon.secondary} size={theme.metrics.control.icon} strokeWidth={1.8} />}
      onOpenChange={setOpen}
      open={open}
      presentation={{ state }}
      summary={summarizeAutomaticApprovalReviewAction(block.review.action)}
    >
      <NativeAutomaticApprovalReviewRow review={block.review} />
    </NativeActivityDisclosure>
  );
}

function NativeAutoReviewInterruptionWarningBlock({ block }: { readonly block: Extract<TimelineBlock, { type: "auto-review-interruption-warning" }> }) {
  const { theme } = useUnistyles();
  return (
    <View accessibilityHint={block.detail} style={styles.eventDivider}>
      <View style={styles.eventLine} />
      <Wrench color={theme.color.icon.tertiary} size={theme.metrics.control.iconSmall} />
      <Text style={styles.eventText}>{block.message}</Text>
      <AlertCircle color={theme.color.icon.tertiary} size={theme.metrics.control.iconSmall} />
      <View style={styles.eventLine} />
    </View>
  );
}

function CommandBlock({ block }: { block: Extract<TimelineBlock, { type: "command-execution" }> }) {
  const { theme } = useUnistyles();
  const presentation = useToolActivityPresentation(block);
  const detailLevel = useContext(NativeConversationDetailContext);
  const skill = skillReadPresentation(block, detailLevel);
  const semanticAction = block.actions.length === 1 && block.actions[0]?.type !== "unknown";
  const [open, setOpen] = useState(false);
  const summary = skill ? skill.summary : semanticAction
    ? presentation.summary
    : formatCommandActivitySummary(block, presentation.state, {
        expanded: false,
        elapsedLabel: formatCodexToolDuration(block.durationMs ?? 0),
      });
  if (skill?.visible === false) return null;
  const hasBody = (!semanticAction && presentation.canExpand) || block.automaticApprovalReviews.length > 0;
  return (
    <NativeActivityDisclosure
      accessory={block.automaticApprovalReviews.length > 0 ? <View accessibilityLabel="Automatic approval review" accessible style={styles.toolAccessory}><ShieldCheck color={theme.color.icon.tertiary} size={16} strokeWidth={1.8} /></View> : undefined}
      detail={skill?.detail ?? (semanticAction ? presentation.detail : null)}
      icon={nativeActivityIcon(presentation.icon, theme.color.icon.secondary, theme.metrics.control.icon)}
      onOpenChange={hasBody ? setOpen : undefined}
      open={open}
      presentation={presentation}
      summary={summary}
    >
      {hasBody ? <>
        {!semanticAction && block.command ? <Text selectable style={styles.code}>{block.command}</Text> : null}
        {!semanticAction && block.output ? <Text selectable style={styles.output}>{block.output}</Text> : null}
        <NativeAutomaticApprovalReviewList reviews={block.automaticApprovalReviews} />
      </> : null}
    </NativeActivityDisclosure>
  );
}

function NativeFileChangeActivity({
  block,
  change,
}: {
  readonly block: Extract<TimelineBlock, { type: "patch" }>;
  readonly change: Extract<TimelineBlock, { type: "patch" }>["changes"][number];
}) {
  const { theme } = useUnistyles();
  const [open, setOpen] = useState(false);
  const presentation = useToolActivityPresentation(block);
  const hasDiff = change.unifiedDiff !== null && change.unifiedDiff.trim() !== "";
  const verb = presentation.state === "running" ? "Editing"
    : presentation.state === "failed" ? "Couldn’t edit"
    : presentation.state === "interrupted" ? "Stopped editing"
    : change.kind === "add" ? "Created" : change.kind === "delete" ? "Deleted" : "Edited";
  const trailing = (change.additions ?? 0) > 0 || (change.deletions ?? 0) > 0
    ? <View style={styles.diffCounts}><Text style={styles.additions}>+{change.additions ?? 0}</Text><Text style={styles.deletions}>−{change.deletions ?? 0}</Text></View>
    : undefined;
  return (
    <NativeActivityDisclosure
      detail={change.movePath === null ? change.path : `${change.path} → ${change.movePath}`}
      icon={<FileCode2 color={theme.color.icon.secondary} size={theme.metrics.control.icon} strokeWidth={1.8} />}
      onOpenChange={hasDiff ? setOpen : undefined}
      open={open}
      presentation={presentation}
      summary={verb}
      trailing={trailing}
    >
      {hasDiff ? <Text selectable style={styles.code}>{change.unifiedDiff}</Text> : null}
    </NativeActivityDisclosure>
  );
}

function PatchBlock({ block }: { block: Extract<TimelineBlock, { type: "patch" }> }) {
  if (block.changes.length === 0) return null;
  return (
    <View style={styles.patchActivities}>
      {block.changes.map((change, index) => <NativeFileChangeActivity block={block} change={change} key={`${change.path}:${change.movePath ?? ""}:${index}`} />)}
      <NativeAutomaticApprovalReviewList reviews={block.automaticApprovalReviews} />
    </View>
  );
}

function TurnDiffBlock({ block }: { block: Extract<TimelineBlock, { type: "turn-diff" }> }) {
  const { theme } = useUnistyles();
  const documentHost = useContext(NativeDocumentHostContext);
  const [expanded, setExpanded] = useState(false);
  if (block.files.length === 0) return null;
  if (block.status === "pending" || block.status === "running") {
    return <View style={styles.turnDiffLive}><Text style={styles.turnDiffLiveText}>{block.files.length === 1 ? "1 file changed" : `${block.files.length} files changed`}</Text><View style={styles.diffCounts}><Text style={styles.additions}>+{block.additions}</Text><Text style={styles.deletions}>−{block.deletions}</Text></View></View>;
  }
  const visible = expanded ? block.files : block.files.slice(0, 3);
  const single = block.files.length === 1 ? block.files[0] : null;
  const basename = single?.path.replaceAll("\\", "/").split("/").at(-1);
  const canOpenFile = documentHost.reviewTurnDiff !== null || documentHost.openResource !== null;
  return (
    <View style={styles.turnDiffCard}>
      <View style={styles.turnDiffHeader}>
        <View style={styles.turnDiffIcon}><FileCode2 color={theme.color.icon.secondary} size={24} strokeWidth={1.8} /></View>
        <View style={styles.turnDiffCopy}><Text numberOfLines={1} style={styles.turnDiffTitle}>{single === null ? `Edited ${block.files.length} files` : `Edited ${basename}`}</Text><View style={styles.diffCounts}><Text style={styles.additions}>+{block.additions}</Text><Text style={styles.deletions}>−{block.deletions}</Text></View></View>
        {documentHost.reviewTurnDiff === null ? null : <Button onPress={() => documentHost.reviewTurnDiff?.(block, single?.path)} size="sm" style={styles.turnDiffReview} textStyle={styles.turnDiffReviewText} variant="secondary">Review</Button>}
      </View>
      {block.files.length > 1 ? <View style={styles.turnDiffFiles}>{visible.map((file) => {
        const content = <><Text numberOfLines={1} style={styles.filePath}>{file.path}</Text><View style={styles.diffCounts}><Text style={styles.additions}>+{file.additions}</Text><Text style={styles.deletions}>−{file.deletions}</Text></View></>;
        return canOpenFile
          ? <InteractiveSurface key={file.path} onPress={() => { if (documentHost.reviewTurnDiff !== null) documentHost.reviewTurnDiff(block, file.path); else documentHost.openResource?.(file.path); }} style={styles.fileRow}>{content}</InteractiveSurface>
          : <View key={file.path} style={styles.fileRow}>{content}</View>;
      })}{block.files.length > 3 ? <InteractiveSurface onPress={() => setExpanded((value) => !value)} style={styles.viewChanges}><Text style={styles.viewChangesText}>{expanded ? "Collapse files" : `Show ${block.files.length - 3} more files`}</Text></InteractiveSurface> : null}</View> : null}
    </View>
  );
}

const NativeAutomationNavigationContext = createContext<((block: AutomationUpdateTimelineBlock) => void) | null>(null);

function AutomationUpdateBlock({ block }: { readonly block: AutomationUpdateTimelineBlock }) {
  const { theme } = useUnistyles();
  const openAutomation = useContext(NativeAutomationNavigationContext);
  const presentation = presentAutomationUpdate(block);
  const canOpen = presentation.canOpen && openAutomation !== null;
  const content = <>
    <View style={styles.turnDiffIcon}><CalendarClock color={theme.color.icon.secondary} size={24} strokeWidth={1.8} /></View>
    <View style={styles.turnDiffCopy}>
      <Text numberOfLines={1} style={styles.turnDiffTitle}>{presentation.title}</Text>
      <Text numberOfLines={1} style={styles.automationUpdateSubtitle}>{presentation.subtitle}</Text>
    </View>
    {canOpen ? <View style={styles.turnDiffReview}><Text style={styles.turnDiffReviewText}>Open</Text></View> : null}
  </>;
  return canOpen ? (
    <InteractiveSurface
      accessibilityLabel={[presentation.actionLabel, presentation.scheduleLabel, presentation.title].filter(Boolean).join(" · ")}
      accessibilityRole="button"
      onPress={() => openAutomation?.(block)}
      style={styles.automationUpdateCard}
    >{content}</InteractiveSurface>
  ) : <View style={styles.automationUpdateCard}>{content}</View>;
}

function ToolPart({ part }: { readonly part: ToolCallContentPart }) {
  if (part.kind === "text") return <Text selectable style={part.role === "error" ? styles.toolPartError : styles.output}>{part.text}</Text>;
  if (part.kind === "json") return <JsonPreview value={part.value} />;
  if (part.kind === "unknown") return <JsonPreview value={part.value} />;
  if (part.kind === "image") return <Image accessibilityLabel={part.alt ?? "Tool image"} resizeMode="contain" source={{ uri: part.source }} style={styles.toolPartImage} />;
  if (part.kind === "audio") return <Text style={styles.output}>Audio output</Text>;
  if (part.kind === "resource-link") return <Text selectable style={styles.toolPartResource}>Read {part.name}</Text>;
  return <View><Text selectable style={styles.toolPartResource}>{part.uri}</Text>{part.content ? <Text selectable style={styles.output}>{part.content}</Text> : null}</View>;
}

function parseNativeWebMcpJson(value: string | null, truncated: boolean): unknown {
  if (value === null || truncated) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function nativeSentenceCaseToolName(value: string): string {
  const normalized = value.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[_-]+/gu, " ").trim();
  return normalized.length === 0 ? value : normalized.charAt(0).toLocaleUpperCase() + normalized.slice(1);
}

function NativeWebMcpToolActivity({ call }: { readonly call: WebMcpToolSurfaceCall }) {
  const { theme } = useUnistyles();
  const [open, setOpen] = useState(false);
  const summary = call.kind === "listTools" ? "Listed website tools" : call.title ?? nativeSentenceCaseToolName(call.name);
  const input = call.kind === "invokeTool" ? parseNativeWebMcpJson(call.inputJson, call.inputTruncated) : null;
  const tool = {
    name: call.name,
    ...(call.title === null ? {} : { title: call.title }),
    ...(call.description === null ? {} : { description: call.description }),
    ...(call.sourceHostname === null ? {} : { website: call.sourceHostname }),
    ...(call.readOnlyHint === null ? {} : { readOnlyHint: call.readOnlyHint }),
    ...(input === null ? {} : { input }),
    ...(call.inputTruncated ? { inputTruncated: true } : {}),
  };
  const output = parseNativeWebMcpJson(call.outputJson, call.outputTruncated);
  return (
    <NativeActivityDisclosure
      icon={<Globe2 color={theme.color.icon.secondary} size={theme.metrics.control.icon} strokeWidth={1.8} />}
      onOpenChange={setOpen}
      open={open}
      presentation={{ state: "completed" }}
      summary={summary}
    >
      <View style={styles.webMcpBody}>
        <Text style={styles.codeLabel}>{call.inputTruncated ? "Tool (input truncated)" : "Tool"}</Text>
        <JsonPreview value={tool} />
        {output === null ? null : <>
          <Text style={styles.codeLabel}>{call.outputTruncated ? "Result (truncated)" : "Result"}</Text>
          <JsonPreview value={output} />
        </>}
      </View>
    </NativeActivityDisclosure>
  );
}

function NativeCreatedThreadToolCard({ result }: {
  readonly result: NonNullable<ReturnType<typeof createdThreadToolResult>>;
}) {
  const { theme } = useUnistyles();
  const openThread = useContext(NativeThreadNavigationContext);
  const content = <>
    <View style={styles.createdThreadIcon}>
      <MessageSquare color={theme.color.icon.secondary} size={theme.metrics.control.icon} strokeWidth={1.8} />
    </View>
    <View style={styles.createdThreadCopy}>
      <Text numberOfLines={1} style={styles.createdThreadTitle}>{result.title}</Text>
    </View>
    {openThread === null ? null : <View style={styles.createdThreadAction}>
      <Text style={styles.createdThreadActionText}>Open chat</Text>
      <ChevronRight color={theme.color.icon.tertiary} size={theme.metrics.control.iconSmall} />
    </View>}
  </>;
  return openThread === null ? <View style={styles.createdThreadCard}>{content}</View> : (
    <InteractiveSurface
      accessibilityLabel="Open chat"
      accessibilityRole="button"
      onPress={() => openThread?.(result.threadId, result.title)}
      style={styles.createdThreadCard}
    >{content}</InteractiveSurface>
  );
}

function NativeCodexAppThreadToolRow({ block, presentation }: {
  readonly block: Extract<TimelineBlock, { type: "tool-call" }>;
  readonly presentation: ToolActivityPresentation;
}) {
  const { theme } = useUnistyles();
  const openThread = useContext(NativeThreadNavigationContext);
  const target = codexAppThreadNavigationTarget(block);
  const canOpen = target !== null && openThread !== null;
  const handoff = threadHandoffToolResult(block);
  const handoffSteps = useMemo(() => handoff === null ? [] : visibleThreadHandoffSteps(handoff), [handoff]);
  const [handoffOpen, setHandoffOpen] = useNativeActivityOpen(presentation.state === "running");
  if (handoff !== null && handoffSteps.length > 0) {
    return (
      <View style={styles.handoffTool}>
        <InteractiveSurface
          accessibilityRole="button"
          accessibilityState={{ expanded: handoffOpen }}
          onPress={() => setHandoffOpen(!handoffOpen)}
          style={styles.codexAppToolRow}
        >
          <Bot color={theme.color.icon.secondary} size={theme.metrics.control.icon} strokeWidth={1.8} />
          <NativeCadencedText active={presentation.state === "running"} numberOfLines={1} style={styles.codexAppToolTitle}>{presentation.summary}</NativeCadencedText>
          <ChevronRight color={theme.color.icon.tertiary} size={theme.metrics.control.iconSmall} style={handoffOpen ? styles.chevronOpen : undefined} />
        </InteractiveSurface>
        {handoffOpen ? <View style={styles.handoffSteps}>
          {handoffSteps.map((step) => {
            const color = step.status === "failed" ? theme.color.accent.negative
              : step.status === "pending" ? theme.color.text.tertiary
              : theme.color.text.secondary;
            return <View key={step.id} style={styles.handoffStep}>
              <View style={styles.handoffStepIcon}>
                {step.status === "running" ? <ActivityIndicator color={color} size="small" />
                  : step.status === "done" ? <Check color={color} size={theme.metrics.control.iconSmall} />
                  : step.status === "failed" ? <X color={color} size={theme.metrics.control.iconSmall} />
                  : <Circle color={color} size={9} />}
              </View>
              <Text style={[styles.handoffStepText, step.status === "failed" && styles.handoffStepFailed]}>{formatThreadHandoffStepLabel(step.id, handoff)}</Text>
            </View>;
          })}
        </View> : null}
      </View>
    );
  }
  const content = <>
    <Bot color={theme.color.icon.secondary} size={theme.metrics.control.icon} strokeWidth={1.8} />
    <NativeCadencedText active={presentation.state === "running"} numberOfLines={1} style={styles.codexAppToolTitle}>{presentation.summary}</NativeCadencedText>
  </>;
  return canOpen ? (
    <InteractiveSurface
      accessibilityLabel={`Open ${target.displayName.toLocaleLowerCase()}`}
      accessibilityRole="button"
      onPress={() => {
        if (target !== null) openThread?.(target.threadId, target.displayName);
      }}
      style={styles.codexAppToolRow}
    >{content}</InteractiveSurface>
  ) : <View style={styles.codexAppToolRow}>{content}</View>;
}

function defaultNativeImageSource(path: string): string | null {
  if (/^(?:blob:|data:|https?:\/\/|file:\/\/)/iu.test(path)) return path;
  if (Platform.OS !== "web" && path.startsWith("/")) return `file://${path}`;
  return null;
}

function NativeImageViewToolBlock({ block }: { readonly block: Extract<TimelineBlock, { type: "tool-call" }> }) {
  const { theme } = useUnistyles();
  const presentation = useToolActivityPresentation(block);
  const host = useContext(NativeImageViewHostContext);
  const paths = block.imagePaths ?? [];
  const [open, setOpen] = useState(false);
  return (
    <NativeActivityDisclosure
      icon={<ImageIcon color={theme.color.icon.secondary} size={theme.metrics.control.icon} strokeWidth={1.8} />}
      onOpenChange={paths.length > 0 ? setOpen : undefined}
      open={open}
      presentation={presentation}
      summary={presentation.summary}
    >
      {paths.length > 0 ? (
        <ScrollView
          contentContainerStyle={styles.imageViewStrip}
          horizontal
          showsHorizontalScrollIndicator={false}
        >
          {paths.map((path, index) => {
            const source = host.resolveSource?.(path) ?? defaultNativeImageSource(path);
            const preview = source === null
              ? <ImageIcon color={theme.color.icon.tertiary} size={24} strokeWidth={1.6} />
              : <Image accessibilityLabel="Inspected image" resizeMode="cover" source={{ uri: source }} style={styles.imageViewImage} />;
            return host.open === null ? (
              <View key={`${path}:${index}`} style={styles.imageViewPreview}>{preview}</View>
            ) : (
              <InteractiveSurface
                accessibilityLabel={`Open inspected image ${index + 1}`}
                accessibilityRole="button"
                key={`${path}:${index}`}
                onPress={() => host.open?.(path)}
                style={styles.imageViewPreview}
              >
                {preview}
              </InteractiveSurface>
            );
          })}
        </ScrollView>
      ) : null}
    </NativeActivityDisclosure>
  );
}

function NativeGeneratedImageBlock({ block }: { readonly block: Extract<TimelineBlock, { type: "image" }> }) {
  const host = useContext(NativeGeneratedImageHostContext);
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  const running = block.status === "pending" || block.status === "running";
  const source = host.resolveSource?.(block) ?? block.uri;
  if (source === null) {
    if (!running) return null;
    return <View accessibilityLabel="Generating image" accessibilityRole="progressbar" style={styles.generatedImagePlaceholder} />;
  }
  const image = (
      <Image
        accessibilityLabel="Generated image 1"
        onLoad={({ nativeEvent }) => {
          const width = nativeEvent.source.width;
          const height = nativeEvent.source.height;
          if (width > 0 && height > 0) setAspectRatio(width / height);
        }}
        resizeMode="contain"
        source={{ uri: source }}
        style={[styles.generatedImage, { aspectRatio: aspectRatio ?? 1 }]}
      />
  );
  return host.open === null ? <View style={styles.generatedImagePreview}>{image}</View> : (
    <InteractiveSurface
      accessibilityLabel="Generated image 1"
      accessibilityRole="imagebutton"
      onPress={() => host.open?.(block)}
      style={styles.generatedImagePreview}
    >
      {image}
    </InteractiveSurface>
  );
}

function ToolCallBlock({ block }: { readonly block: Extract<TimelineBlock, { type: "tool-call" }> }) {
  const { theme } = useUnistyles();
  const presentation = useToolActivityPresentation(block);
  const parts = extractToolCallContentParts(block);
  const displayParts = block.kind === "mcp" ? parts.filter((part) => part.role !== "input") : parts;
  const renderContent = useContext(NativeToolCallContentRendererContext);
  const renderIcon = useContext(NativeToolCallIconRendererContext);
  const customContent = renderContent?.(block, presentation);
  const hasCustomContent = customContent !== undefined;
  const hasCustomBody = hasCustomContent && customContent !== null && customContent !== false;
  const canExpand = presentation.canExpand || hasCustomBody || block.automaticApprovalReviews.length > 0;
  const [mcpOpen, setMcpOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useNativeActivityOpen(presentation.state === "running");
  const open = block.kind === "mcp" ? mcpOpen : activityOpen;
  const setOpen = block.kind === "mcp" ? setMcpOpen : setActivityOpen;
  const createdThread = createdThreadToolResult(block);
  const hostIcon = renderIcon?.(block, presentation);
  const icon = hostIcon === undefined
    ? nativeActivityIcon(presentation.icon, theme.color.icon.secondary, theme.metrics.control.icon)
    : hostIcon;
  if (createdThread !== null && !hasCustomContent) return <NativeCreatedThreadToolCard result={createdThread} />;
  if (isCodexAppThreadTool(block) && !hasCustomContent) {
    return <NativeCodexAppThreadToolRow block={block} presentation={presentation} />;
  }
  return (
    <>
      <NativeActivityDisclosure
        accessory={block.automaticApprovalReviews.length > 0 ? <View accessibilityLabel="Automatic approval review" accessible style={styles.toolAccessory}><ShieldCheck color={theme.color.icon.tertiary} size={16} strokeWidth={1.8} /></View> : undefined}
        detail={presentation.detail}
        icon={icon}
        onOpenChange={canExpand ? setOpen : undefined}
        open={open}
        presentation={presentation}
        summary={presentation.summary}
      >
        {canExpand ? <View style={styles.toolParts}>
        {hasCustomContent
          ? customContent
          : displayParts.length === 0
            ? <Text style={styles.output}>Tool returned no content</Text>
            : displayParts.map((part, index) => <ToolPart key={`${part.kind}:${index}`} part={part} />)}
        <NativeAutomaticApprovalReviewList reviews={block.automaticApprovalReviews} />
        </View> : null}
      </NativeActivityDisclosure>
      {block.webMcpCalls?.map((call, index) => (
        <NativeWebMcpToolActivity call={call} key={`${call.kind}:${call.name}:${index}`} />
      ))}
    </>
  );
}

function NativeSubagentActivity({ unit }: { readonly unit: SubagentActivityRenderUnit }) {
  const { theme } = useUnistyles();
  const presentation = useMemo(() => deriveSubagentActivityGroupPresentation(unit.blocks), [unit.blocks]);
  const [open, setOpen] = useState(unit.blocks.some((block) => block.status === "running" || block.status === "pending"));
  const header = <>
    <Bot color={theme.color.icon.secondary} size={theme.metrics.control.icon} strokeWidth={1.8} />
    <View style={styles.subagentChips}>{presentation.agents.slice(0, 3).map((agent) => <View key={agent.threadId} style={styles.subagentChip}><Text style={styles.subagentAvatar}>{agent.displayName.slice(0, 1).toUpperCase()}</Text><Text numberOfLines={1} style={styles.subagentName}>{agent.displayName}</Text></View>)}</View>
    {presentation.agents.length > 3 ? <Text style={styles.subagentStatus}>{presentation.agents.length - 3} more</Text> : null}
    <Text style={styles.subagentStatus}>{presentation.groupStatusLabel}</Text>
    {presentation.expandable ? <ChevronRight color={theme.color.icon.tertiary} size={theme.metrics.control.iconSmall} style={open ? styles.chevronOpen : undefined} /> : null}
  </>;
  return (
    <View style={styles.subagentActivity}>
      {presentation.expandable
        ? <InteractiveSurface onPress={() => setOpen((value) => !value)} style={styles.subagentHeader}>{header}</InteractiveSurface>
        : <View style={styles.subagentHeader}>{header}</View>}
      {open && presentation.expandable ? <View style={styles.subagentRows}>{presentation.agents.map((agent) => <View key={agent.threadId} style={styles.subagentRow}><Text style={styles.subagentName}>{agent.displayName}</Text><Text style={styles.subagentStatus}>{agent.statusLabel}</Text>{agent.statusMessage ? <Text style={styles.semanticBody}>{agent.statusMessage}</Text> : null}</View>)}</View> : null}
    </View>
  );
}

function NativeAgentActivityGroup({ unit }: { readonly unit: AgentActivityGroupContentUnit }) {
  const { theme } = useUnistyles();
  const registry = useContext(NativeToolActivityPresenterContext);
  const detailLevel = useContext(NativeConversationDetailContext);
  const version = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const header = useMemo(
    () => deriveAgentActivityHeaderPresentation(unit, registry, detailLevel),
    [unit, registry, version, detailLevel],
  );
  const visibleBlocks = useMemo(
    () => unit.blocks.filter((block) => isVisibleAgentActivityRow(block, registry, detailLevel)),
    [registry, unit.blocks, version, detailLevel],
  );
  const [open, setOpen] = useState(false);
  const hasExpandableContent = visibleBlocks.length > 0;
  const headerContent = <>
    {header.icon === null ? null : nativeActivityIcon(header.icon, theme.color.icon.secondary, theme.metrics.control.icon)}
    <Text numberOfLines={1} style={styles.reasoningTitle}>{agentActivityHeaderAccessibleLabel(header.summary)}</Text>
    {hasExpandableContent ? <ChevronRight color={theme.color.icon.tertiary} size={theme.metrics.control.iconSmall} style={open ? styles.chevronOpen : undefined} /> : null}
  </>;
  return (
    <View style={styles.agentActivity}>
      {hasExpandableContent
        ? <InteractiveSurface onPress={() => setOpen((value) => !value)} style={styles.reasoningButton}>{headerContent}</InteractiveSurface>
        : <View style={styles.reasoningButton}>{headerContent}</View>}
      {open && hasExpandableContent ? (
        <View style={styles.agentActivityRows}>
          {visibleBlocks.map((block) => <Block block={block} key={block.id} />)}
        </View>
      ) : null}
    </View>
  );
}

function NativeWorkStatusLabel({ item }: { readonly item: WorkStatusItem }) {
  const label = useWorkStatusLabel(item);
  return <Text style={styles.workStatusLabel}>{workStatusLabelText(label)}</Text>;
}

function useWorkStatusReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (live) setReduced(value); });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => { live = false; subscription.remove(); };
  }, []);
  return reduced;
}

function NativeWorkStatusDivider({ item }: { readonly item: WorkStatusItem }) {
  const progress = useRef(new Animated.Value(0)).current;
  const [height, setHeight] = useState<number>();
  const reduced = useWorkStatusReducedMotion();
  useEffect(() => {
    if (height === undefined) return;
    const animation = Animated.timing(progress, { toValue: 1, duration: reduced ? 0 : 300, easing: Easing.bezier(0.19, 1, 0.22, 1), useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [height, progress, reduced]);
  // Native Composer already owns the live-running affordance through its Stop
  // action. Rendering an additional standalone `Working` row gives the same
  // state two owners and creates a transient transcript height. The durable
  // `Worked for` divider remains transcript-owned once the work interval ends.
  if (item.status === "working") return null;
  return <Animated.View style={{ overflow: "hidden", opacity: progress, height: height === undefined ? undefined : progress.interpolate({ inputRange: [0, 1], outputRange: [0, height] }) }}>
    <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)} style={styles.workStatusDivider}>
      <NativeWorkStatusLabel item={item} />
      <View style={styles.workStatusRule} />
    </View>
  </Animated.View>;
}

function NativeActivityExpansion({ children }: { readonly children: ReactNode }) {
  const progress = useRef(new Animated.Value(0)).current;
  const reduced = useWorkStatusReducedMotion();
  useEffect(() => {
    const animation = Animated.timing(progress, { toValue: 1, duration: reduced ? 120 : 220, easing: Easing.bezier(0.33, 1, 0.68, 1), useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [progress, reduced]);
  return <Animated.View style={[styles.activityContent, { opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [reduced ? 0 : -8, 0] }) }] }]}>{children}</Animated.View>;
}

function NativeActivityContent({ units }: { readonly units: readonly AgentActivityContentUnit[] }) {
  return <View style={styles.activityContent}>{units.map((unit) =>
    unit.type === "worked-for" ? <NativeWorkStatusDivider key={unit.id} item={unit.item} />
      : unit.type === "group" ? <NativeAgentActivityGroup key={unit.id} unit={unit} />
        : <Block key={unit.id} block={unit.block} />)}</View>;
}

function NativeAgentActivity({ unit }: { readonly unit: AgentActivityRenderUnit }) {
  const { theme } = useUnistyles();
  const [persistedCollapsed, setPersistedCollapsed] = useState<boolean>();
  // Native consumes the same disclosure/partition authority as Web. A local
  // `open` initialized once cannot own completion-triggered auto-collapse.
  const layout = resolveAgentActivityLayout(unit, persistedCollapsed);
  return <View style={styles.activityContent}>
    {layout.preToggleUnits.length > 0 ? <NativeActivityContent units={layout.preToggleUnits} /> : null}
    {layout.showToggle ? <View>
      <InteractiveSurface accessibilityRole="button" accessibilityState={{ expanded: !layout.isCollapsed }}
        onPress={() => setPersistedCollapsed(!layout.isCollapsed)} style={styles.workStatusButton}>
        {layout.workedForItem !== null ? <NativeWorkStatusLabel item={layout.workedForItem} />
          : <Text style={styles.workStatusLabel}>{unit.workedDurationMs !== null
            ? `Worked for ${formatWorkDuration(unit.workedDurationMs)}`
            : `${layout.collapsedItemCount} previous message${layout.collapsedItemCount === 1 ? "" : "s"}`}</Text>}
        <ChevronRight size={12} color={theme.color.icon.tertiary} style={!layout.isCollapsed ? styles.chevronOpen : undefined} />
      </InteractiveSurface>
      <View style={styles.workStatusRuleRow}><View style={styles.workStatusRule} /></View>
    </View> : null}
    {layout.persistentUnits.length > 0 ? <NativeActivityContent units={layout.persistentUnits} /> : null}
    {!layout.isCollapsed ? <NativeActivityExpansion>
      {layout.visibleUnits.length > 0 ? <NativeActivityContent units={layout.visibleUnits} /> : null}
      {unit.inlineSubagentActivity !== null ? <NativeSubagentActivity unit={unit.inlineSubagentActivity} /> : null}
    </NativeActivityExpansion> : null}
  </View>;
}

const NativePendingSurfaceContext = createContext(false);

function SemanticCard({ icon, title, children, status }: { icon?: ReactNode; title: string; children?: ReactNode; status?: string }) {
  const pendingSurface = useContext(NativePendingSurfaceContext);
  return (
    <View style={[styles.semanticCard, pendingSurface && styles.pendingSemanticCard]}>
      <View style={styles.semanticTitle}>{icon}<Text style={styles.semanticTitleText}>{title}</Text>{status ? <Text style={styles.semanticStatus}>{status}</Text> : null}</View>
      {children}
    </View>
  );
}

type NativeInteractionResponder = (requestId: string, action: WorkbenchInteractionAction) => Promise<void>;
const NativeInteractionContext = createContext<NativeInteractionResponder | null>(null);
const NativeSetupContextCatalog = createContext<{
  readonly sources: readonly SetupCodexContextSource[];
  readonly loading: boolean;
  readonly connect: ((source: SetupCodexContextSource) => Promise<void>) | null;
}>({ sources: codexSetupContextSourceExamples, loading: false, connect: null });

function NativeApprovalBlock({ block }: { block: Extract<TimelineBlock, { type: "approval" }> }) {
  const respond = useContext(NativeInteractionContext);
  const [submitting, setSubmitting] = useState(false);
  const presentation = presentApprovalRequest(block);
  const scopedAction: WorkbenchInteractionAction | null = presentation.scopedApproval === null ? null
    : presentation.scopedApproval.kind === "exec-policy" ? { type: "approve-similar" }
    : { type: "approve-session" };
  const submit = (action: WorkbenchInteractionAction) => {
    if (respond === null || submitting) return;
    setSubmitting(true);
    void respond(block.requestId, action).finally(() => setSubmitting(false));
  };
  return (
    <SemanticCard title={presentation.title} status={submitting ? "submitting" : block.state}>
      <Text style={styles.semanticStatus}>{presentation.identityLabel}</Text>
      {presentation.subtitle ? <Text selectable style={styles.approvalCommand}>{presentation.subtitle}</Text> : null}
      {presentation.description ? <Text style={styles.semanticBody}>{presentation.description}</Text> : null}
      {presentation.details.map((detail) => <View key={detail.label} style={styles.approvalDetail}><Text style={styles.semanticStatus}>{detail.label}</Text><Text selectable style={styles.semanticBody}>{detail.value}</Text></View>)}
      {block.state === "pending" ? <View style={styles.interactionActions}>
        {presentation.leadingApproval ? <Button disabled={submitting} onPress={() => submit({ type: "approve-network-host" })} size="sm" variant="secondary">{presentation.leadingApproval.label}</Button> : null}
        {presentation.allowSession && presentation.scopedApproval !== null && scopedAction !== null ? <Button disabled={submitting} onPress={() => submit(scopedAction)} size="sm" variant="secondary">{presentation.scopedApproval.label}</Button> : null}
        <Button disabled={submitting} onPress={() => submit({ type: "decline" })} size="sm" variant="secondary">Deny</Button>
        <Button disabled={submitting} onPress={() => submit({ type: "approve-once" })} size="sm">{presentation.approveLabel}</Button>
      </View> : null}
    </SemanticCard>
  );
}

function NativeQuestionBlock({ block }: { block: Extract<TimelineBlock, { type: "question" }> }) {
  const respond = useContext(NativeInteractionContext);
  const { theme } = useUnistyles();
  const [questionIndex, setQuestionIndex] = useState(0);
  const [drafts, setDrafts] = useState<readonly UserInputQuestionDraft[]>(() => createUserInputQuestionDrafts(block.questions));
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    setQuestionIndex(0);
    setDrafts(createUserInputQuestionDrafts(block.questions));
  }, [block.questions, block.requestId]);
  const question = block.questions[questionIndex] ?? block.questions[0];
  if (question === undefined) return null;
  const draft = drafts[questionIndex];
  const isLast = questionIndex >= block.questions.length - 1;
  const updateDraft = (nextDraft: UserInputQuestionDraft) => {
    const next = [...drafts];
    next[questionIndex] = nextDraft;
    setDrafts(next);
    return next;
  };
  const complete = (nextDrafts: readonly UserInputQuestionDraft[]) => {
    if (!isLast) {
      setQuestionIndex((current) => Math.min(block.questions.length - 1, current + 1));
      return;
    }
    if (respond === null || submitting) return;
    const answers = aggregateUserInputQuestionAnswers(block.questions, nextDrafts);
    const action: WorkbenchInteractionAction = block.method === "mcpServer/elicitation/request"
      ? { type: "answer", values: Object.values(answers).flat() }
      : { type: "answer-questions", answers };
    setSubmitting(true);
    void respond(block.requestId, action).finally(() => setSubmitting(false));
  };
  return (
    <SemanticCard title={question.header ?? question.prompt} status={submitting ? "submitting" : block.state}>
      <View style={styles.questionHeader}>
        {question.header ? <Text style={styles.semanticBody}>{question.prompt}</Text> : <View />}
        {block.questions.length > 1 ? <View style={styles.questionPagination}>
          <IconButton accessibilityLabel="Previous question" disabled={questionIndex === 0} onPress={() => setQuestionIndex((current) => Math.max(0, current - 1))} size="sm"><ChevronLeft size={15} /></IconButton>
          <Text style={styles.semanticStatus}>{questionIndex + 1} of {block.questions.length}</Text>
          <IconButton accessibilityLabel="Next question" disabled={isLast} onPress={() => setQuestionIndex((current) => Math.min(block.questions.length - 1, current + 1))} size="sm"><ChevronRight size={15} /></IconButton>
        </View> : null}
      </View>
      {block.state === "pending" ? <>
        <View style={styles.questionOptions}>{question.options.map((option, index) => (
          <InteractiveSurface
            accessibilityRole="radio"
            accessibilityState={{ checked: draft?.selectedOptionId === option.id }}
            key={option.id}
            onPress={() => complete(updateDraft({ selectedOptionId: option.id, freeformText: draft?.freeformText ?? "" }))}
            style={[styles.questionOption, draft?.selectedOptionId === option.id && styles.questionOptionSelected]}
          >
            <Text style={styles.questionOptionKey}>{index + 1}</Text>
            <View style={styles.questionOptionCopy}><Text style={styles.interactionButtonText}>{option.label}</Text>{option.description ? <Text style={styles.semanticStatus}>{option.description}</Text> : null}</View>
            {draft?.selectedOptionId === option.id ? <Check size={15} /> : null}
          </InteractiveSurface>
        ))}</View>
        {question.options.length === 0 || question.isOther ? <TextInput
          onChangeText={(value) => updateDraft({ selectedOptionId: null, freeformText: value })}
          onSubmitEditing={() => complete(drafts)}
          placeholder={question.options.length > 0 ? "Other" : "Type here"}
          placeholderTextColor={theme.color.text.tertiary}
          secureTextEntry={question.isSecret}
          style={styles.questionInput}
          value={draft?.freeformText ?? ""}
        /> : null}
        <View style={styles.interactionActions}>
          <Button disabled={submitting} onPress={() => { if (respond !== null) void respond(block.requestId, { type: "cancel" }); }} size="sm" variant="ghost">Skip</Button>
          <Button disabled={submitting} onPress={() => complete(drafts)} size="sm">{isLast ? "Submit" : "Continue"}</Button>
        </View>
      </> : null}
    </SemanticCard>
  );
}

function NativeOptionPickerBlock({ block }: { block: Extract<TimelineBlock, { type: "option-picker" }> }) {
  const respond = useContext(NativeInteractionContext);
  const { theme } = useUnistyles();
  const [selectedOptions, setSelectedOptions] = useState<readonly string[]>([]);
  const [freeformText, setFreeformText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const trimmedFreeform = freeformText.trim();
  const hasAnswer = selectedOptions.length > 0 || trimmedFreeform.length > 0;
  useEffect(() => {
    setSelectedOptions([]);
    setFreeformText("");
  }, [block.requestId]);
  const reply = (action: "submit" | "skip" | "dismiss") => {
    if (respond === null || submitting) return;
    setSubmitting(true);
    void respond(block.requestId, {
      type: "submit-option-picker",
      action,
      selectedOptions,
      freeformAnswer: trimmedFreeform.length > 0 ? trimmedFreeform : null,
    }).finally(() => setSubmitting(false));
  };
  const toggle = (label: string) => setSelectedOptions((current) => current.includes(label)
    ? current.filter((candidate) => candidate !== label)
    : block.allowMultiple ? [...current, label] : [label]);
  return (
    <View accessibilityLabel={block.question} style={styles.optionPicker}>
      <View style={styles.optionPickerHeader}>
        <Text style={styles.optionPickerQuestion}>{block.question}</Text>
        <IconButton accessibilityLabel="Dismiss" disabled={submitting} onPress={() => reply("dismiss")} size="sm"><X color={theme.color.icon.secondary} size={12} /></IconButton>
      </View>
      <View style={styles.optionPickerChoices}>
        {block.options.map((option) => {
          const selected = selectedOptions.includes(option.label);
          return <InteractiveSurface accessibilityRole={block.allowMultiple ? "checkbox" : "radio"} accessibilityState={{ checked: selected }} disabled={submitting} key={option.id} onPress={() => toggle(option.label)} style={[styles.optionPickerChoice, selected && styles.optionPickerChoiceSelected]}><Text style={styles.optionPickerChoiceText}>{option.label}</Text></InteractiveSurface>;
        })}
        <TextInput
          accessibilityLabel="Something else"
          editable={!submitting}
          onChangeText={setFreeformText}
          onSubmitEditing={() => { if (hasAnswer) reply("submit"); }}
          placeholder="Something else"
          placeholderTextColor={theme.color.text.tertiary}
          returnKeyType="send"
          style={styles.optionPickerInput}
          value={freeformText}
        />
      </View>
      <View style={styles.optionPickerFooter}>
        <Button disabled={submitting} onPress={() => reply("skip")} size="sm" variant="ghost">{block.skipLabel ?? "Skip"}</Button>
        <Button disabled={submitting || !hasAnswer} onPress={() => reply("submit")} size="sm">{`${block.submitLabel ?? "Submit"}  ↵`}</Button>
      </View>
    </View>
  );
}

function NativeSetupCodexStepBlock({ block }: { block: Extract<TimelineBlock, { type: "setup-codex-step" }> }) {
  if (block.step === "context") return <NativeSetupContextPickerBlock block={block} />;
  return block.step === "role" ? <NativeSetupRolePickerBlock block={block} /> : <NativeSetupTaskPickerBlock block={block} />;
}

function NativeSetupRolePickerBlock({ block }: { block: Extract<TimelineBlock, { type: "setup-codex-step" }> }) {
  const respond = useContext(NativeInteractionContext);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => setSelected([]), [block.requestId]);
  const reply = (action: "submit" | "dismiss") => {
    if (respond === null || submitting) return;
    setSubmitting(true);
    void respond(block.requestId, { type: "submit-setup-role", action, selectedRoles: action === "submit" ? selected : [] }).finally(() => setSubmitting(false));
  };
  return <View style={styles.optionPicker}>
    <View style={styles.optionPickerHeader}><Text style={styles.optionPickerQuestion}>What type of work do you do?</Text><IconButton accessibilityLabel="Dismiss" onPress={() => reply("dismiss")} size="sm"><X size={12} /></IconButton></View>
    <View style={styles.optionPickerChoices}>{codexSetupRoleOptions.map((option) => {
      const checked = selected.includes(option.id);
      return <InteractiveSurface accessibilityRole="checkbox" accessibilityState={{ checked }} disabled={submitting} key={option.id} onPress={() => setSelected((current) => current.includes(option.id) ? current.filter((id) => id !== option.id) : [...current, option.id])} style={[styles.optionPickerChoice, checked && styles.optionPickerChoiceSelected]}><Text style={styles.optionPickerChoiceText}>{option.label}</Text></InteractiveSurface>;
    })}</View>
    <View style={styles.optionPickerFooter}><Button disabled={submitting || selected.length === 0} onPress={() => reply("submit")} size="sm">Continue  ↵</Button></View>
  </View>;
}

function NativeSetupTaskPickerBlock({ block }: { block: Extract<TimelineBlock, { type: "setup-codex-step" }> }) {
  const respond = useContext(NativeInteractionContext);
  const [selected, setSelected] = useState<string | null>(null);
  const [other, setOther] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { setSelected(null); setOther(""); }, [block.requestId]);
  const answer = selected ?? other.trim();
  const reply = (action: "submit" | "skip" | "dismiss") => {
    if (respond === null || submitting) return;
    setSubmitting(true);
    void respond(block.requestId, { type: "submit-setup-task", action, answers: action === "submit" && answer ? { first_task: [answer] } : {} }).finally(() => setSubmitting(false));
  };
  return <View style={styles.setupTask}>
    <View style={styles.optionPickerHeader}><View style={styles.setupTaskHeaderCopy}><Text style={styles.semanticStatus}>First task</Text><Text style={styles.optionPickerQuestion}>What's something we can knock off your list today?</Text></View><IconButton accessibilityLabel="Dismiss" onPress={() => reply("dismiss")} size="sm"><X size={12} /></IconButton></View>
    <View style={styles.questionOptions}>{codexSetupTaskOptions.map((option) => <InteractiveSurface accessibilityRole="radio" accessibilityState={{ checked: selected === option.label }} key={option.id} onPress={() => { setSelected(option.label); setOther(""); }} style={[styles.questionOption, selected === option.label && styles.questionOptionSelected]}><View style={styles.questionOptionCopy}><Text style={styles.interactionButtonText}>{option.label}</Text><Text style={styles.semanticStatus}>{option.description}</Text></View>{selected === option.label ? <Check size={14} /> : null}</InteractiveSurface>)}</View>
    <TextInput onChangeText={(value) => { setOther(value); setSelected(null); }} placeholder="Something else" style={styles.questionInput} value={other} />
    <View style={styles.optionPickerFooter}><Button disabled={submitting} onPress={() => reply("skip")} size="sm" variant="ghost">Skip</Button><Button disabled={submitting || !answer} onPress={() => reply("submit")} size="sm">Continue  ↵</Button></View>
  </View>;
}

function NativeSetupContextPickerBlock({ block }: { block: Extract<TimelineBlock, { type: "setup-codex-step" | "setup-context-picker" }> }) {
  const respond = useContext(NativeInteractionContext);
  const catalog = useContext(NativeSetupContextCatalog);
  const [selected, setSelected] = useState<readonly string[]>(() => catalog.sources.filter((source) => source.connected).map((source) => source.id));
  const [submitting, setSubmitting] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  useEffect(() => setSelected(catalog.sources.filter((source) => source.connected).map((source) => source.id)), [block.requestId, catalog.sources]);
  const reply = (action: "continue" | "skip" | "dismiss") => {
    if (respond === null || submitting) return;
    setSubmitting(true);
    void respond(block.requestId, { type: "submit-setup-context", action, selectedSources: action === "continue" ? selected : [] }).finally(() => setSubmitting(false));
  };
  const choose = async (source: SetupCodexContextSource) => {
    if (source.connected || selected.includes(source.id)) {
      setSelected((current) => current.includes(source.id) ? current.filter((id) => id !== source.id) : [...current, source.id]);
      return;
    }
    if (!source.available || catalog.connect === null) return;
    setConnecting(source.id);
    try {
      await catalog.connect(source);
      setSelected((current) => current.includes(source.id) ? current : [...current, source.id]);
    } finally { setConnecting(null); }
  };
  return <View style={styles.setupContext}>
    <View style={styles.optionPickerHeader}><Text style={styles.optionPickerQuestion}>Where can we pull context from?</Text><IconButton accessibilityLabel="Dismiss" onPress={() => reply("dismiss")} size="sm"><X size={12} /></IconButton></View>
    <ScrollView style={styles.setupContextList}>{catalog.sources.map((source) => {
      const checked = selected.includes(source.id);
      return <InteractiveSurface disabled={submitting || connecting === source.id || !source.connected && (!source.available || catalog.connect === null)} key={source.id} onPress={() => void choose(source)} style={[styles.setupContextRow, checked && styles.questionOptionSelected]}><View style={styles.setupContextLogo}><Text style={styles.semanticStatus}>{source.label.slice(0, 1)}</Text></View><View style={styles.questionOptionCopy}><Text style={styles.interactionButtonText}>{source.label}</Text><Text numberOfLines={1} style={styles.semanticStatus}>{source.description}</Text></View><Text style={styles.semanticStatus}>{connecting === source.id ? "Connecting…" : checked || source.connected ? "Connected" : "Connect"}</Text>{checked ? <Check size={14} /> : null}</InteractiveSurface>;
    })}</ScrollView>
    <View style={styles.optionPickerFooter}><Button disabled={submitting} onPress={() => reply("skip")} size="sm" variant="ghost">Skip</Button><Button disabled={submitting || catalog.loading} onPress={() => reply("continue")} size="sm">Continue  ↵</Button></View>
  </View>;
}

function NativeMcpToolApprovalBlock({ block }: { block: Extract<TimelineBlock, { type: "elicitation" }> }) {
  const respond = useContext(NativeInteractionContext);
  const { theme } = useUnistyles();
  const [submitting, setSubmitting] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>({});
  const approval = block.toolApproval;
  const connectorName = approval?.connectorName ?? block.serverName ?? "Connector";
  const toolName = approval?.toolTitle ?? approval?.toolName;
  const title = block.message.trim().length > 0
    ? block.message
    : toolName === null || toolName === undefined
      ? `Allow ${connectorName} to run this tool?`
      : `Allow ${connectorName} to run ${toolName} tool?`;
  const entries = approval?.toolParamsDisplay.length
    ? approval.toolParamsDisplay
    : Object.entries(approval?.toolParams ?? {}).map(([name, value]) => ({ name, displayName: name, value }));
  const visibleEntries = showAll ? entries : entries.slice(0, 4);
  useEffect(() => {
    setShowAll(false);
    setExpanded({});
  }, [block.requestId]);
  const submit = (action: WorkbenchInteractionAction) => {
    if (respond === null || submitting) return;
    setSubmitting(true);
    void respond(block.requestId, action).finally(() => setSubmitting(false));
  };
  return (
    <SemanticCard title={title} status={submitting ? "submitting" : block.state}>
      <View style={styles.mcpApprovalHeader}>
        {block.riskLevel === "high"
          ? <><AlertCircle color={theme.color.accent.warning} size={14} /><Text style={styles.mcpApprovalRisk}>Elevated Risk</Text></>
          : <><Wrench color={theme.color.icon.secondary} size={15} /><Text style={styles.mcpApprovalConnector}>{connectorName}</Text></>}
      </View>
      {block.subtitle ? <Text style={styles.semanticStatus}>{block.subtitle}</Text> : null}
      {visibleEntries.length > 0 ? <View style={styles.mcpApprovalParams}>{visibleEntries.map((entry, index) => {
        const key = `${entry.name}:${index}`;
        const value = presentMcpElicitationDisplayValue(entry.value);
        const expandable = value.isExpandable;
        const open = expanded[key] === true;
        return <View key={key} style={styles.mcpApprovalParam}>
          <Text numberOfLines={1} style={styles.mcpApprovalParamLabel}>{entry.displayName}</Text>
          <View style={styles.mcpApprovalParamValue}>
            <Text numberOfLines={!open && value.kind === "text" && expandable ? 4 : undefined} selectable style={styles.semanticBody}>{open ? value.expandedText : value.previewText}</Text>
            {expandable ? <Button onPress={() => setExpanded((current) => ({ ...current, [key]: !open }))} size="sm" variant="link">{open ? "Collapse" : "Expand"}</Button> : null}
          </View>
        </View>;
      })}</View> : null}
      {entries.length > 4 ? <Button onPress={() => setShowAll((value) => !value)} size="sm" variant="link">{showAll ? "Show fewer items" : `Show ${entries.length - 4} more items`}</Button> : null}
      {block.state === "pending" ? <View style={styles.interactionActions}>
        <Button disabled={submitting} onPress={() => submit({ type: "decline" })} size="sm" variant="secondary">Deny</Button>
        <Button disabled={submitting} onPress={() => submit({ type: "accept-elicitation" })} size="sm">Allow once</Button>
        {block.persist.includes("session") ? <Button disabled={submitting} onPress={() => submit({ type: "accept-elicitation", persist: "session" })} size="sm" variant="secondary">Allow this conversation</Button> : null}
        {block.persist.includes("always") ? <Button disabled={submitting} onPress={() => submit({ type: "accept-elicitation", persist: "always" })} size="sm" variant="secondary">Always allow</Button> : null}
      </View> : null}
    </SemanticCard>
  );
}

function NativeToolSuggestionBlock({ block }: { block: Extract<TimelineBlock, { type: "elicitation" }> }) {
  const respond = useContext(NativeInteractionContext);
  const suggestion = block.toolSuggestion;
  const [submitting, setSubmitting] = useState(false);
  const [setupStarted, setSetupStarted] = useState(false);
  const [persistChecked, setPersistChecked] = useState(false);
  if (suggestion === null) return null;
  const submit = (action: WorkbenchInteractionAction) => {
    if (respond === null || submitting) return;
    setSubmitting(true);
    void respond(block.requestId, action).finally(() => setSubmitting(false));
  };
  const primary = () => {
    if (setupStarted) {
      submit({ type: "accept-elicitation", ...(persistChecked && suggestion.persistAlways ? { persist: "always" as const } : {}) });
      return;
    }
    if (suggestion.installUrl !== null && /^https?:\/\//u.test(suggestion.installUrl)) {
      void Linking.openURL(suggestion.installUrl);
      setSetupStarted(true);
    }
  };
  return (
    <SemanticCard icon={<Wrench size={16} />} title={suggestion.toolName} status={submitting ? "submitting" : block.state}>
      <Text style={styles.semanticBody}>{suggestion.suggestReason}</Text>
      {block.subtitle ? <Text style={styles.semanticStatus}>{block.subtitle}</Text> : null}
      {block.state === "pending" ? <View style={styles.externalToolFooter}>
        {suggestion.persistAlways ? <InteractiveSurface accessibilityRole="checkbox" accessibilityState={{ checked: persistChecked }} onPress={() => setPersistChecked((value) => !value)} style={styles.externalToolPersist}><View style={[styles.externalToolCheckbox, persistChecked && styles.externalToolCheckboxChecked]}>{persistChecked ? <Check size={11} /> : null}</View><Text style={styles.semanticStatus}>Don't show again</Text></InteractiveSurface> : <View />}
        <View style={styles.interactionActions}>
          <Button disabled={submitting} onPress={() => submit({ type: "decline", ...(persistChecked && suggestion.persistAlways ? { persist: "always" as const } : {}) })} size="sm" variant="ghost">Not now</Button>
          <Button disabled={submitting || !setupStarted && suggestion.installUrl === null} onPress={primary} size="sm">{setupStarted ? "Continue" : suggestion.suggestType === "install" ? "Install" : "Enable"}</Button>
        </View>
      </View> : null}
    </SemanticCard>
  );
}

function NativeConnectorAuthBlock({ block }: { block: Extract<TimelineBlock, { type: "elicitation" }> }) {
  const respond = useContext(NativeInteractionContext);
  const auth = block.connectorAuth;
  const [submitting, setSubmitting] = useState(false);
  const [setupStarted, setSetupStarted] = useState(false);
  if (auth === null) return null;
  const submit = (action: WorkbenchInteractionAction) => {
    if (respond === null || submitting) return;
    setSubmitting(true);
    void respond(block.requestId, action).finally(() => setSubmitting(false));
  };
  const primaryLabel = setupStarted ? "Continue"
    : auth.authReason === "missing_link" ? "Connect"
    : auth.authReason === "oauth_upgrade_required" ? "Update access"
    : "Reconnect";
  const primary = () => {
    if (setupStarted) {
      submit({ type: "accept-elicitation" });
      return;
    }
    if (/^https?:\/\//u.test(auth.installUrl)) {
      void Linking.openURL(auth.installUrl);
      setSetupStarted(true);
    }
  };
  return (
    <SemanticCard icon={<Globe2 size={16} />} title={auth.connectorName} status={submitting ? "submitting" : block.state}>
      <Text style={styles.semanticBody}>{block.message}</Text>
      {auth.requestedScopes.length > 0 ? <Text style={styles.semanticStatus}>{auth.requestedScopes.join(" · ")}</Text> : null}
      {block.state === "pending" ? <View style={styles.interactionActions}>
        <Button disabled={submitting} onPress={() => submit({ type: "decline" })} size="sm" variant="ghost">Not now</Button>
        <Button disabled={submitting} onPress={primary} size="sm">{primaryLabel}</Button>
      </View> : null}
    </SemanticCard>
  );
}

function NativeMcpFormElicitationBlock({ block }: { block: Extract<TimelineBlock, { type: "elicitation" }> }) {
  const respond = useContext(NativeInteractionContext);
  const fields = useMemo(() => normalizeMcpElicitationSchema(block.requestedSchema), [block.requestedSchema]);
  const [draft, setDraft] = useState<McpElicitationDraft>(() => createMcpElicitationDraft(fields));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    setDraft(createMcpElicitationDraft(fields));
    setErrors({});
  }, [block.requestId, fields]);
  const update = (name: string, value: McpElicitationDraftValue) => {
    setDraft((current) => ({ ...current, [name]: value }));
    setErrors((current) => current[name] === undefined ? current : Object.fromEntries(Object.entries(current).filter(([key]) => key !== name)));
  };
  const submit = (action: WorkbenchInteractionAction) => {
    if (respond === null || submitting) return;
    setSubmitting(true);
    void respond(block.requestId, action).finally(() => setSubmitting(false));
  };
  const submitForm = () => {
    const result = validateMcpElicitationDraft(fields, draft);
    setErrors(result.errors);
    if (result.content !== null) submit({ type: "accept-elicitation", content: result.content });
  };
  return (
    <SemanticCard title={block.serverName === null ? "Additional information required" : `${block.serverName} needs more information`} status={submitting ? "submitting" : block.state}>
      <Text style={styles.semanticBody}>{block.message}</Text>
      {block.state === "pending" && block.mode === "url" ? <InteractiveSurface disabled={block.url === null} onPress={() => { if (block.url !== null && /^https?:\/\//u.test(block.url)) void Linking.openURL(block.url); }} style={styles.elicitationUrl}><Text style={styles.elicitationUrlText}>{block.url ?? "No URL supplied"}</Text></InteractiveSurface> : null}
      {block.state === "pending" && block.mode !== "url" ? <View style={styles.elicitationForm}>{fields.map((field) => <View key={field.name} style={styles.elicitationField}>
        <View style={styles.elicitationLabel}><Text style={styles.interactionButtonText}>{field.title}</Text>{field.required ? <Text style={styles.semanticStatus}>Required</Text> : null}</View>
        {field.description ? <Text style={styles.semanticStatus}>{field.description}</Text> : null}
        {field.kind === "boolean" ? <InteractiveSurface accessibilityRole="checkbox" accessibilityState={{ checked: draft[field.name] === true }} onPress={() => update(field.name, draft[field.name] !== true)} style={[styles.interactionButton, draft[field.name] === true && styles.questionOptionSelected]}><Text style={styles.interactionButtonText}>{draft[field.name] === true ? "Enabled" : "Disabled"}</Text></InteractiveSurface>
          : field.kind === "select" || field.kind === "multi-select" ? <View style={styles.questionOptions}>{field.options.map((option) => {
              const values = Array.isArray(draft[field.name]) ? draft[field.name] as readonly string[] : [];
              const selected = field.kind === "multi-select" ? values.includes(option.value) : draft[field.name] === option.value;
              return <InteractiveSurface accessibilityRole={field.kind === "multi-select" ? "checkbox" : "radio"} accessibilityState={{ checked: selected }} key={option.value} onPress={() => update(field.name, field.kind === "multi-select" ? selected ? values.filter((value) => value !== option.value) : [...values, option.value] : option.value)} style={[styles.questionOption, selected && styles.questionOptionSelected]}><Text style={styles.interactionButtonText}>{option.label}</Text>{selected ? <Check size={15} /> : null}</InteractiveSurface>;
            })}</View>
          : <TextInput keyboardType={field.kind === "number" ? "numeric" : field.format === "email" ? "email-address" : "default"} onChangeText={(value) => update(field.name, value)} secureTextEntry={field.format === "password"} style={styles.questionInput} value={elicitationDraftText(draft[field.name])} />}
        {errors[field.name] ? <Text style={styles.elicitationError}>{errors[field.name]}</Text> : null}
      </View>)}</View> : null}
      {block.state === "pending" ? <View style={styles.interactionActions}>
        <Button disabled={submitting} onPress={() => submit({ type: "decline" })} size="sm" variant="ghost">Decline</Button>
        <Button disabled={submitting} onPress={block.mode === "url" ? () => submit({ type: "accept-elicitation" }) : submitForm} size="sm">Continue</Button>
      </View> : null}
    </SemanticCard>
  );
}

function NativeElicitationBlock({ block }: { block: Extract<TimelineBlock, { type: "elicitation" }> }) {
  if (block.interactionKind === "tool-approval" && block.toolApproval !== null) return <NativeMcpToolApprovalBlock block={block} />;
  if (block.interactionKind === "tool-suggestion" && block.toolSuggestion !== null) return <NativeToolSuggestionBlock block={block} />;
  if (block.interactionKind === "connector-auth" && block.connectorAuth !== null) return <NativeConnectorAuthBlock block={block} />;
  return <NativeMcpFormElicitationBlock block={block} />;
}

export function WorkbenchPendingInteractionPanel({
  block,
  bottomInset,
  onRespondInteraction,
  setupContextSources = codexSetupContextSourceExamples,
  setupContextLoading = false,
  onConnectSetupContextSource,
}: {
  readonly block: AttachedInteractionTimelineBlock;
  readonly bottomInset: number;
  readonly onRespondInteraction: NativeInteractionResponder;
  readonly setupContextSources?: readonly SetupCodexContextSource[];
  readonly setupContextLoading?: boolean;
  readonly onConnectSetupContextSource?: (source: SetupCodexContextSource) => Promise<void>;
}) {
  const { theme } = useUnistyles();
  return (
    <NativeInteractionContext.Provider value={onRespondInteraction}>
      <NativeSetupContextCatalog.Provider value={{ sources: setupContextSources, loading: setupContextLoading, connect: onConnectSetupContextSource ?? null }}>
      <View style={[styles.pendingRequestRegion, { paddingBottom: Math.max(bottomInset, theme.metrics.composer.outerBottomInset) }]}>
        <View style={styles.pendingRequestSurface}>
          <NativePendingSurfaceContext.Provider value>
            {block.type === "approval"
              ? <NativeApprovalBlock block={block} />
              : block.type === "question"
                ? <NativeQuestionBlock block={block} />
                : block.type === "option-picker"
                  ? <NativeOptionPickerBlock block={block} />
                  : block.type === "setup-codex-step"
                    ? <NativeSetupCodexStepBlock block={block} />
                    : block.type === "setup-context-picker"
                      ? <NativeSetupContextPickerBlock block={block} />
                      : <NativeElicitationBlock block={block} />}
          </NativePendingSurfaceContext.Provider>
        </View>
      </View>
      </NativeSetupContextCatalog.Provider>
    </NativeInteractionContext.Provider>
  );
}

function NativeInteractionTimelineStatus({ block }: { readonly block: AttachedInteractionTimelineBlock }) {
  if (block.type === "question" || block.type === "option-picker" || block.type === "setup-codex-step" || block.type === "setup-context-picker") return null;
  if (block.state === "pending") {
    return <View accessibilityLiveRegion="polite" style={styles.awaitingApproval}><NativeCadencedText active style={styles.awaitingApprovalText}>Awaiting approval</NativeCadencedText></View>;
  }
  if (block.type === "approval") return null;
  const status = block.state === "accepted" ? "Accepted" : block.state === "declined" ? "Declined" : "Cancelled";
  return <View style={styles.completedInteraction}><MessageSquare size={14} /><Text style={styles.completedInteractionTitle}>Completed request</Text><Text style={styles.completedInteractionStatus}>{status}</Text></View>;
}

const NATIVE_USER_MESSAGE_COLLAPSED_LINES = 20;

function openNativeUserMessageResource(source: string, host: NativeImageViewHostValue): void {
  if (/^(?:https?:|data:|blob:)/iu.test(source)) {
    void Linking.openURL(source);
  } else {
    host.open?.(source);
  }
}

function NativeUserMessageAttachments({ block }: { readonly block: UserMessageTimelineBlock }) {
  const host = useContext(NativeImageViewHostContext);
  const { theme } = useUnistyles();
  const attachments = block.content.filter((part) => part.type !== "text");
  if (attachments.length === 0) return null;
  return (
    <View style={styles.userAttachments}>
      {attachments.map((part, index) => {
        if (part.type === "image" || part.type === "local-image") {
          const source = part.type === "local-image" ? host.resolveSource?.(part.source) ?? null : part.source;
          return (
            <InteractiveSurface accessibilityLabel="Open attached image" accessibilityRole="button" key={`${part.type}:${part.source}:${index}`} onPress={() => openNativeUserMessageResource(part.source, host)} style={styles.userImage}>
              {source === null
                ? <ImageIcon color={theme.color.icon.tertiary} size={22} />
                : <Image resizeMode="cover" source={{ uri: source }} style={styles.userImageContent} />}
            </InteractiveSurface>
          );
        }
        if (part.type === "audio" || part.type === "local-audio") {
          return <InteractiveSurface accessibilityRole="button" key={`${part.type}:${part.source}:${index}`} onPress={() => openNativeUserMessageResource(part.source, host)} style={styles.userAttachmentChip}><Text style={styles.userAttachmentChipText}>Audio</Text></InteractiveSurface>;
        }
        if (part.type === "skill" || part.type === "mention") {
          return <InteractiveSurface accessibilityRole="button" key={`${part.type}:${part.path}:${index}`} onPress={() => openNativeUserMessageResource(part.path, host)} style={styles.userAttachmentChip}><Text style={styles.userAttachmentChipText}>{part.type === "mention" ? "@" : "/"}{part.name}</Text></InteractiveSurface>;
        }
        return null;
      })}
    </View>
  );
}

function NativeUserMessageBlock({ block }: { readonly block: UserMessageTimelineBlock }) {
  const { theme } = useUnistyles();
  const collapsedHeight = theme.platformTypography.chat.lineHeight * (NATIVE_USER_MESSAGE_COLLAPSED_LINES - 1);
  const {
    collapseState,
    measuringNaturalHeight,
    onContentLayout,
    onViewportLayout,
    toggleExpansion,
  } = useNativeUserMessageCollapse({
    collapsedHeight: theme.platformTypography.chat.lineHeight * NATIVE_USER_MESSAGE_COLLAPSED_LINES,
    contentIdentity: block.message,
  });
  const collapsed = collapseState === "collapsed";
  const expanded = collapseState === "expanded";
  return (
    <View style={styles.userMessageGroup}>
      <NativeUserMessageAttachments block={block} />
      {block.message.trim().length === 0 ? null : (
        <View onLayout={onViewportLayout} style={styles.userBubble}>
          <View style={collapsed && !measuringNaturalHeight ? [styles.userMessageClip, { maxHeight: collapsedHeight }] : styles.userMessageClip}>
            <View onLayout={onContentLayout}>
              <NativeChatDocument documentId={`${block.id}:user-message`} source={block.message} />
            </View>
          </View>
          {collapsed ? <Text accessibilityElementsHidden style={styles.userMessageEllipsis}>…</Text> : null}
          {collapseState === "uncollapsible" ? null : (
            <InteractiveSurface accessibilityRole="button" accessibilityState={{ expanded }} hitSlop={8} onPress={toggleExpansion} style={styles.userMessageExpansion}>
              <Text style={styles.userMessageExpansionText}>{expanded ? "Show less" : "Show more"}</Text>
              <ChevronRight color={theme.color.icon.tertiary} size={11} style={expanded ? styles.userMessageExpansionOpen : styles.userMessageExpansionClosed} />
            </InteractiveSurface>
          )}
        </View>
      )}
    </View>
  );
}

function NativeTextTimelineRenderer({ block, richText }: TimelineBlockRendererProps) {
  if (block.type !== "text") return null;
  return richText
    ? <NativeChatDocument documentId={block.id} source={block.text} streaming={block.streaming} />
    : <Text selectable style={styles.messageText}>{block.text}</Text>;
}

function NativePlanTimelineRenderer({ block }: TimelineBlockRendererProps) {
  const [collapsed, setCollapsed] = useState(block.type === "plan" && !block.completed);
  if (block.type !== "plan") return null;
  return <SemanticCard title={block.completed ? block.title ?? "Plan" : "Writing plan"}>
    <View style={collapsed ? { height: 320, overflow: "hidden" } : undefined}><NativeChatDocument documentId={block.id} source={block.text} streaming={!block.completed} /></View>
    <Button accessibilityState={{ expanded: !collapsed }} onPress={() => setCollapsed(!collapsed)} size="sm" variant="link">{collapsed ? "Expand plan" : "Collapse plan"}</Button>
    {block.completed && block.text.trim() ? <NativeResponseCopyButton text={block.text} label="Copy plan" /> : null}
  </SemanticCard>;
}

function NativeTodoTimelineRenderer({ block }: TimelineBlockRendererProps) {
  const { theme } = useUnistyles();
  const [open, setOpen] = useState(false);
  if (block.type !== "todo") return null;
  if (block.entries.length === 0) return null;
  return <View><InteractiveSurface accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}><Text style={styles.semanticBody}>{todoSummary(block)}</Text></InteractiveSurface>{open ? <SemanticCard icon={<ListChecks color={theme.color.icon.secondary} size={theme.metrics.control.iconSmall} />} title={block.explanation ?? "Steps"}>{block.entries.map((entry) => <Text key={entry.id} style={styles.semanticBody}>{entry.status === "complete" ? "✓" : "○"} {entry.text}</Text>)}</SemanticCard> : null}</View>;
}

function NativeCompactionBlock({ block }: { block: Extract<TimelineBlock, { type: "compaction" }> }) {
  return <NativeCadencedText active={!block.completed} style={styles.eventText}>{compactionLabel(block)}</NativeCadencedText>;
}

function NativeSubagentTimelineRenderer({ block }: TimelineBlockRendererProps) {
  const { theme } = useUnistyles();
  if (block.type !== "subagent") return null;
  return <SemanticCard icon={<Bot color={theme.color.icon.secondary} size={theme.metrics.control.iconSmall} />} title={block.label} status={block.status}><Text style={styles.semanticBody}>{block.action}</Text></SemanticCard>;
}

function NativeInteractionTimelineRenderer({ block }: TimelineBlockRendererProps) {
  return block.type === "approval" || block.type === "question" || block.type === "option-picker" || block.type === "elicitation"
    ? <NativeInteractionTimelineStatus block={block} />
    : null;
}

function NativeErrorTimelineRenderer({ block }: TimelineBlockRendererProps) {
  const { theme } = useUnistyles();
  if (block.type !== "error") return null;
  return <SemanticCard icon={<AlertCircle color={theme.color.accent.negative} size={theme.metrics.control.iconSmall} />} title={block.code ?? "Error"}><Text style={styles.semanticBody}>{block.message}</Text></SemanticCard>;
}

const nativeComponentRenderer = <T extends TimelineBlock["type"]>(
  type: T,
  render: (block: Extract<TimelineBlock, { type: T }>) => ReactNode,
) => function RegisteredNativeTimelineRenderer({ block }: TimelineBlockRendererProps) {
  return block.type === type ? render(block as Extract<TimelineBlock, { type: T }>) : null;
};

const nativeBuiltinTimelineRenderers: readonly TimelineBlockRendererRegistration[] = [
  { name: "native-user-message", priority: 0, types: ["user-message"], component: nativeComponentRenderer("user-message", (block) => <NativeUserMessageBlock block={block} />) },
  { name: "native-text", priority: 0, types: ["text"], component: NativeTextTimelineRenderer },
  { name: "native-reasoning", priority: 0, types: ["reasoning"], component: nativeComponentRenderer("reasoning", (block) => <ReasoningBlock block={block} />) },
  { name: "native-command", priority: 0, types: ["command-execution"], component: nativeComponentRenderer("command-execution", (block) => <CommandBlock block={block} />) },
  { name: "native-patch", priority: 0, types: ["patch"], component: nativeComponentRenderer("patch", (block) => <PatchBlock block={block} />) },
  { name: "native-turn-diff", priority: 0, types: ["turn-diff"], component: nativeComponentRenderer("turn-diff", (block) => <TurnDiffBlock block={block} />) },
  { name: "native-automation-update", priority: 0, types: ["automation-update"], component: nativeComponentRenderer("automation-update", (block) => <AutomationUpdateBlock block={block} />) },
  { name: "native-image-view-tool", priority: 100, types: ["tool-call"], matches: (block) => block.type === "tool-call" && block.kind === "image-view", component: nativeComponentRenderer("tool-call", (block) => <NativeImageViewToolBlock block={block} />) },
  { name: "native-tool-call", priority: 0, types: ["tool-call"], component: nativeComponentRenderer("tool-call", (block) => <ToolCallBlock block={block} />) },
  { name: "native-automatic-approval-review", priority: 0, types: ["automatic-approval-review"], component: nativeComponentRenderer("automatic-approval-review", (block) => block.review.status === "approved" ? null : <NativeAutomaticApprovalReviewBlock block={block} />) },
  { name: "native-auto-review-warning", priority: 0, types: ["auto-review-interruption-warning"], component: nativeComponentRenderer("auto-review-interruption-warning", (block) => <NativeAutoReviewInterruptionWarningBlock block={block} />) },
  { name: "native-plan", priority: 0, types: ["plan"], component: NativePlanTimelineRenderer },
  { name: "native-todo", priority: 0, types: ["todo"], component: NativeTodoTimelineRenderer },
  { name: "native-subagent", priority: 0, types: ["subagent"], component: NativeSubagentTimelineRenderer },
  { name: "native-interaction", priority: 0, types: ["approval", "question", "option-picker", "elicitation"], component: NativeInteractionTimelineRenderer },
  { name: "native-error", priority: 0, types: ["error"], component: NativeErrorTimelineRenderer },
  { name: "native-compaction", priority: 0, types: ["compaction"], component: nativeComponentRenderer("compaction", (block) => <NativeCompactionBlock block={block} />) },
  { name: "native-plan-implementation", priority: 0, types: ["plan-implementation"], component: () => null },
  { name: "native-image", priority: 0, types: ["image"], component: nativeComponentRenderer("image", (block) => <NativeGeneratedImageBlock block={block} />) },
  { name: "native-unknown", priority: 0, types: ["unknown"], component: nativeComponentRenderer("unknown", (block) => <SemanticCard title={`Unsupported AppServer item: ${block.itemType}`}><JsonPreview value={block.payload} /></SemanticCard>) },
];

export const NativeBuiltinTimelineRendererPlugin = Object.assign(
  function NativeBuiltinTimelineRendererPlugin(ctx: Context): void {
    const disposers = nativeBuiltinTimelineRenderers.map((renderer) => ctx.timelineBlockRenderers.register(renderer));
    ctx.effect(() => () => disposers.reverse().forEach((dispose) => dispose()));
  },
  { inject: ["timelineBlockRenderers"] },
);

function Block({ block, richText = true }: { block: TimelineBlock; richText?: boolean }): ReactNode {
  return <TimelineBlockView block={block} richText={richText} />;
}

export type NativeConversationDetailLevel = ConversationDetailLevel;

function NativeHookLifecycleIcon({ color }: { readonly color: string }) {
  return (
    <Svg fill="none" height={18} viewBox="0 0 18 18" width={18}>
      <SvgCircle cx={8.99805} cy={4.875} r={1.875} stroke={color} strokeWidth={1.5} />
      <SvgPath d="M9 6.75V12C9 13.6569 10.3431 15 12 15C13.6569 15 15 13.6569 15 12V9.75L13.5 11.25" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} />
      <SvgPath d="M9 6.75V12C9 13.6569 7.65685 15 6 15C4.34315 15 3 13.6569 3 12V9.75L4.5 11.25" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} />
    </Svg>
  );
}

function NativeHookStatsSummary({
  detailLevel,
  stats,
}: {
  readonly detailLevel: NativeConversationDetailLevel;
  readonly stats: HookStats;
}) {
  if (detailLevel !== "STEPS_PROSE") {
    return (
      <View accessibilityLabel="Hooks" accessible style={styles.hookStatsSummary}>
        <Text style={styles.hookStatsTitle}>Hooks</Text>
        <View style={styles.hookStatsRuns}>
          {stats.runs.map((run) => (
            <View key={run.id} style={styles.hookStatsRun}>
              <Text style={styles.hookStatsRunEvent}>{formatHookEventName(run.eventName)}</Text>
              <View style={styles.hookStatsRunBody}>
                <Text style={styles.hookStatsLabel}>{formatHookSource(run.source)}{run.count > 1 ? ` · ${String(run.count)} runs` : ""}</Text>
                {run.statusMessage === null ? null : <Text style={styles.hookStatsLabel}>{run.statusMessage}</Text>}
                {run.entries.map((entry, index) => (
                  <Text key={`${entry.tone}:${index}:${entry.text}`} style={entry.tone === "error" ? styles.hookStatsRunError : styles.hookStatsLabel}>{entry.text}</Text>
                ))}
              </View>
            </View>
          ))}
        </View>
      </View>
    );
  }
  return (
    <View accessibilityLabel="Hooks summary" accessible style={styles.hookStatsSummary}>
      <Text style={styles.hookStatsTitle}>Hooks summary</Text>
      <View style={styles.hookStatsCounts}>
        <Text style={styles.hookStatsLabel}>Ran</Text><Text style={styles.hookStatsValue}>{stats.count}</Text>
        {stats.blockedCount > 0 ? <><Text style={styles.hookStatsLabel}>Blocked</Text><Text style={styles.hookStatsValue}>{stats.blockedCount}</Text></> : null}
        {stats.errorCount > 0 ? <><Text style={styles.hookStatsLabel}>Errors</Text><Text style={styles.hookStatsValue}>{stats.errorCount}</Text></> : null}
      </View>
      {stats.entries.map((entry, index) => (
        <View key={`${entry.kind}:${index}:${entry.text}`} style={styles.hookStatsEntry}>
          <Text style={styles.hookStatsLabel}>{entry.kind === "feedback" ? "Feedback" : entry.kind === "stop" ? "Stop" : "Error"}</Text>
          <Text style={styles.hookStatsEntryText}>{entry.text}</Text>
        </View>
      ))}
    </View>
  );
}

function NativeResponseCopyButton({ text, label = "Copy response" }: { text: string; label?: string }) {
  const { theme } = useUnistyles();
  const copyText = useContext(NativeCopyTextContext);
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [text]);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timeout);
  }, [copied]);
  if (copyText === null) return null;
  return <IconButton accessibilityLabel={copied ? "Copied" : label} size="sm"
    onPress={() => { void copyText(text).then(() => setCopied(true)).catch(() => setCopied(false)); }}>
    {copied ? <Check color={theme.color.icon.tertiary} size={theme.metrics.control.iconSmall} /> : <Copy color={theme.color.icon.tertiary} size={theme.metrics.control.iconSmall} strokeWidth={1.8} />}
  </IconButton>;
}

function Frame({
  assistantPlan,
  frame,
  thinkingId,
  thinkingLabel = "Thinking",
  showActions,
  threadDetailLevel,
}: {
  assistantPlan: AssistantTurnPresentationPlan | null;
  frame: TimelineFrame;
  thinkingId: string | null;
  thinkingLabel?: "Thinking" | "Planning";
  showActions: boolean;
  threadDetailLevel: NativeConversationDetailLevel;
}) {
  const { theme } = useUnistyles();
  const [showHookStats, setShowHookStats] = useState(false);
  const actions = frame.type === "assistant" ? assistantMessageActions(frame) : null;
  const visibleBlocks = frame.blocks;
  const visibleFrame = frame;
  const units = assistantPlan?.slots ?? null;
  if (visibleBlocks.length === 0 && thinkingId === null) return null;
  if (frame.type === "user") {
    return <View style={styles.userFrame}>{visibleBlocks.map((block) => block.type === "user-message" ? <NativeUserMessageBlock block={block} key={block.id} /> : <View key={block.id}><Block block={block} richText={false} /></View>)}</View>;
  }
  return (
    <View style={styles.frame}>
      {units === null
        ? visibleBlocks.map((block) => <View key={block.id}><Block block={block} /></View>)
        : units.map((unit) => unit.type === "agent-activity"
          ? <NativeAgentActivity key={unit.id} unit={unit} />
          : unit.type === "subagent-activity"
            ? <NativeSubagentActivity key={unit.id} unit={unit} />
            : <View key={unit.id}><Block block={unit.block} /></View>)}
      {thinkingId === null ? null : <NativeThinkingPlaceholder key={thinkingId} label={thinkingLabel} />}
      {frame.type === "assistant" && showActions && (actions?.completed || frame.hookStats != null) ? (
        <>
          <View style={styles.messageActions}>
            {actions?.completed && actions.copyText ? <NativeResponseCopyButton text={actions.copyText} /> : null}
            {frame.hookStats == null ? null : (
              <IconButton accessibilityLabel="Hooks" onPress={() => setShowHookStats((current) => !current)} selected={showHookStats} size="sm">
                <NativeHookLifecycleIcon color={theme.color.icon.tertiary} />
              </IconButton>
            )}
            {actions?.sentAtMs == null ? null : <Text style={styles.eventText}>{new Date(actions.sentAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Text>}
          </View>
          {showHookStats && frame.hookStats != null ? <NativeHookStatsSummary detailLevel={threadDetailLevel} stats={frame.hookStats} /> : null}
        </>
      ) : null}
    </View>
  );
}

function NativeThinkingPlaceholder({ label = "Thinking" }: { label?: "Thinking" | "Planning" }) {
  return <View accessibilityLiveRegion="polite" style={styles.thinkingPlaceholder}><NativeCadencedText active style={styles.thinkingPlaceholderText}>{label}</NativeCadencedText></View>;
}

function Turn({
  isMostRecentTurn,
  threadDetailLevel,
  turn,
}: {
  isMostRecentTurn: boolean;
  threadDetailLevel: NativeConversationDetailLevel;
  turn: TimelineTurnView;
}) {
  const registry = useContext(NativeToolActivityPresenterContext);
  const reportLatestFollowContentLayout = useContext(NativeLatestTurnFollowContentContext);
  const version = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const presentation = useMemo(
    () => createTimelineTurnPresentationPlan(turn, registry, { isMostRecentTurn }),
    [isMostRecentTurn, registry, turn, version],
  );
  const turnThinking = presentation.thinkingOwner.type === "turn"
    ? presentation.thinkingOwner
    : null;
  return (
    <View style={styles.turn}>
      {presentation.userFrames.map((frame) => (
        <Frame assistantPlan={null} frame={frame} key={frame.id} showActions={false} thinkingId={null} threadDetailLevel={threadDetailLevel} />
      ))}
      {presentation.assistantFrame === null ? null : (
        <View onLayout={reportLatestFollowContentLayout ?? undefined}>
          <Frame
            assistantPlan={presentation.assistant}
            frame={presentation.assistantFrame}
            key={presentation.assistantFrame.id}
            showActions
            thinkingId={turnThinking?.placeholderId ?? null}
            thinkingLabel={turnThinking?.label}
            threadDetailLevel={threadDetailLevel}
          />
        </View>
      )}
      {presentation.auxiliaryFrames.map((frame) => (
        <Frame assistantPlan={null} frame={frame} key={frame.id} showActions={false} thinkingId={null} threadDetailLevel={threadDetailLevel} />
      ))}
    </View>
  );
}

function AnimatedTurn({
  isLatest,
  offset,
  threadDetailLevel,
  turn,
}: {
  readonly isLatest: boolean;
  readonly offset: Animated.Value;
  readonly threadDetailLevel: NativeConversationDetailLevel;
  readonly turn: TimelineTurnView;
}) {
  return (
    <Animated.View style={isLatest ? { transform: [{ translateY: offset }] } : undefined}>
      <Turn isMostRecentTurn={isLatest} threadDetailLevel={threadDetailLevel} turn={turn} />
    </Animated.View>
  );
}

function EmptyConversation({ onSuggestion }: { onSuggestion(text: string): void }) {
  const { theme } = useUnistyles();
  const suggestions = [
    { icon: FileSearch, label: "Explore this codebase", prompt: "Explore this codebase and explain its architecture." },
    { icon: WandSparkles, label: "Implement a feature", prompt: "Help me implement a new feature in this project." },
    { icon: Check, label: "Review recent changes", prompt: "Review the recent changes and identify risks." },
  ] as const;
  return (
    <View style={styles.empty}>
      <View style={styles.emptyMark}><WandSparkles color={theme.color.accent.blue} size={theme.metrics.conversation.heroIcon} strokeWidth={1.8} /></View>
      <Text style={styles.emptyTitle}>What are we building?</Text>
      <Text style={styles.emptyText}>Start with a goal. OpenCraft can inspect your workspace, make changes, and show its work.</Text>
      <View style={styles.suggestions}>{suggestions.map(({ icon: Icon, label, prompt }) => <InteractiveSurface key={label} onPress={() => onSuggestion(prompt)} style={styles.suggestion}><Icon color={theme.color.icon.secondary} size={theme.metrics.control.icon} strokeWidth={1.8} /><Text style={styles.suggestionText}>{label}</Text><ArrowRight color={theme.color.icon.tertiary} size={theme.metrics.control.iconSmall} strokeWidth={1.9} /></InteractiveSurface>)}</View>
    </View>
  );
}

export type { WorkbenchConversationRestoreSnapshot } from "./native-response-positioned-turns";

interface WorkbenchConversationProps {
  readonly timeline: TimelineSnapshot | null;
  readonly onSuggestion: (text: string) => void;
  readonly footerScrollPaddingPx?: number;
  readonly initialRestoreSnapshot?: WorkbenchConversationRestoreSnapshot | null;
  readonly onRestoreSnapshotChange?: (snapshot: WorkbenchConversationRestoreSnapshot) => void;
  readonly onLoadOlder?: () => void | "stop" | Promise<void | "stop">;
  readonly onConversationScrollApiChange?: (api: TurnConversationScrollApi | null) => void;
  readonly consumePendingLatestTurnSubmitPlacement?: () => LatestTurnPlacementSnapshot | null;
  readonly onVirtualizedTurnListApiChange?: (api: VirtualizedTurnListApi | null) => void;
  readonly onRespondInteraction?: NativeInteractionResponder;
  readonly onOpenSubagent?: (threadId: string, displayName: string) => void;
  readonly onOpenAutomation?: (block: AutomationUpdateTimelineBlock) => void;
  readonly onOpenResource?: (path: string) => void;
  readonly onReviewTurnDiff?: (block: Extract<TimelineBlock, { type: "turn-diff" }>, path?: string) => void;
  readonly onOpenInspectedImage?: (path: string) => void;
  readonly resolveInspectedImageSource?: (path: string) => string | null;
  readonly onOpenGeneratedImage?: (block: Extract<TimelineBlock, { type: "image" }>) => void;
  readonly resolveGeneratedImageSource?: (block: Extract<TimelineBlock, { type: "image" }>) => string | null;
  readonly toolActivityPresenterRegistry?: ToolActivityPresenterRegistry;
  readonly renderToolCallContent?: NativeToolCallContentRenderer;
  readonly renderToolCallIcon?: NativeToolCallIconRenderer;
  readonly threadDetailLevel?: NativeConversationDetailLevel;
  readonly onCopyText?: (text: string) => Promise<void>;
}

export function WorkbenchConversation({
  timeline,
  onSuggestion,
  footerScrollPaddingPx = 0,
  initialRestoreSnapshot = null,
  onRestoreSnapshotChange,
  onLoadOlder,
  onConversationScrollApiChange,
  consumePendingLatestTurnSubmitPlacement,
  onVirtualizedTurnListApiChange,
  onRespondInteraction,
  onOpenSubagent,
  onOpenAutomation,
  onOpenResource,
  onReviewTurnDiff,
  onOpenInspectedImage,
  resolveInspectedImageSource,
  onOpenGeneratedImage,
  resolveGeneratedImageSource,
  toolActivityPresenterRegistry = DEFAULT_TOOL_ACTIVITY_PRESENTERS,
  renderToolCallContent,
  renderToolCallIcon,
  threadDetailLevel = "STEPS_COMMANDS",
  onCopyText,
}: WorkbenchConversationProps) {
  const entries = useMemo(
    () => timeline === null ? [] : groupTimelineFramesByTurn(timeline),
    [timeline],
  );
  const activeTodo = useMemo(() => {
    const latest = entries.at(-1);
    return latest === undefined
      ? null
      : createTimelineTurnPresentationPlan(latest, toolActivityPresenterRegistry, { isMostRecentTurn: true }).activeTodo;
  }, [entries, toolActivityPresenterRegistry]);
  const historyKey = timeline === null
    ? null
    : JSON.stringify([timeline.key.hostId, timeline.key.threadId]);
  return (
    <NativeConversationDetailContext.Provider value={threadDetailLevel}>
      <NativeCopyTextContext.Provider value={onCopyText ?? null}>
        <NativeToolActivityPresenterContext.Provider value={toolActivityPresenterRegistry}>
          <NativeToolCallIconRendererContext.Provider value={renderToolCallIcon ?? null}>
            <NativeToolCallContentRendererContext.Provider value={renderToolCallContent ?? null}>
              <NativeThreadNavigationContext.Provider value={onOpenSubagent ?? null}>
                <NativeDocumentHostContext.Provider value={{ openResource: onOpenResource ?? null, reviewTurnDiff: onReviewTurnDiff ?? null }}>
                  <NativeAutomationNavigationContext.Provider value={onOpenAutomation ?? null}>
                    <NativeGeneratedImageHostContext.Provider value={{
                      open: onOpenGeneratedImage ?? null,
                      resolveSource: resolveGeneratedImageSource ?? null,
                    }}>
                      <NativeImageViewHostContext.Provider value={{
                        open: onOpenInspectedImage ?? null,
                        resolveSource: resolveInspectedImageSource ?? null,
                      }}>
                        <NativeInteractionContext.Provider value={onRespondInteraction ?? null}>
                        <View style={styles.conversationRoot}>
                        <NativeResponsePositionedTurns
                          entries={entries}
                          historyKey={historyKey}
                          footerScrollPaddingPx={footerScrollPaddingPx}
                          initialRestoreSnapshot={initialRestoreSnapshot}
                          onRestoreSnapshotChange={onRestoreSnapshotChange}
                          onLoadOlder={onLoadOlder}
                          onConversationScrollApiChange={onConversationScrollApiChange}
                          consumePendingLatestTurnSubmitPlacement={
                            consumePendingLatestTurnSubmitPlacement
                          }
                          onVirtualizedTurnListApiChange={
                            onVirtualizedTurnListApiChange
                          }
                          renderEmpty={() => (
                            <EmptyConversation onSuggestion={onSuggestion} />
                          )}
                          renderTurn={(
                            turn,
                            isLatest,
                            latestTurnOffset,
                            onLatestFollowContentLayout,
                          ) => (
                            <NativeLatestTurnFollowContentContext.Provider
                              value={isLatest
                                ? onLatestFollowContentLayout
                                : null}
                            >
                              <AnimatedTurn
                                isLatest={isLatest}
                                offset={latestTurnOffset}
                                threadDetailLevel={threadDetailLevel}
                                turn={turn}
                              />
                            </NativeLatestTurnFollowContentContext.Provider>
                          )}
                          scrollStyle={styles.scroll}
                          scrollContentStyle={styles.scrollContent}
                          contentStyle={styles.content}
                        />
                        {activeTodo === null ? null : (
                          <View pointerEvents="box-none" style={[styles.todoDock, { bottom: footerScrollPaddingPx + 8 }]}>
                            <NativeTodoTimelineRenderer block={activeTodo} richText={false} />
                          </View>
                        )}
                        </View>
                        </NativeInteractionContext.Provider>
                      </NativeImageViewHostContext.Provider>
                    </NativeGeneratedImageHostContext.Provider>
                  </NativeAutomationNavigationContext.Provider>
                </NativeDocumentHostContext.Provider>
              </NativeThreadNavigationContext.Provider>
            </NativeToolCallContentRendererContext.Provider>
          </NativeToolCallIconRendererContext.Provider>
        </NativeToolActivityPresenterContext.Provider>
      </NativeCopyTextContext.Provider>
    </NativeConversationDetailContext.Provider>
  );
}
const styles = StyleSheet.create((theme) => ({
  conversationRoot: { flex: 1, minHeight: 0 },
  todoDock: { position: "absolute", zIndex: 10, left: theme.metrics.conversation.horizontalInset, right: theme.metrics.conversation.horizontalInset, alignItems: "center" },
  scroll: { flex: 1, minHeight: 0, backgroundColor: theme.color.surface.main },
  scrollContent: { flexGrow: 1 },
  content: { width: "100%", maxWidth: theme.metrics.conversation.maximumWidth, flexGrow: 1, alignSelf: "center", paddingHorizontal: theme.metrics.conversation.horizontalInset, paddingTop: theme.metrics.conversation.topInset, paddingBottom: theme.metrics.conversation.bottomInset },
  turn: { gap: theme.metrics.conversation.userBottomGap, marginBottom: theme.metrics.conversation.turnGap },
  frame: { gap: theme.spacing[4] },
  userFrame: { width: "100%", minWidth: 0 },
  userMessageGroup: { width: "100%", minWidth: 0, alignItems: "flex-end", gap: theme.spacing[1] },
  userBubble: { maxWidth: theme.metrics.conversation.userMaximumWidth, minWidth: 0, alignSelf: "flex-end", overflow: "hidden", paddingHorizontal: theme.spacing[3], paddingVertical: theme.metrics.conversation.userBubbleVerticalInset, borderRadius: theme.metrics.conversation.userBubbleRadius, backgroundColor: theme.color.surface.messageUser },
  userMessageClip: { minWidth: 0, overflow: "hidden" },
  userMessageEllipsis: { alignSelf: "flex-start", color: theme.color.text.primary, ...theme.platformTypography.chat },
  userMessageExpansion: { minHeight: theme.metrics.toolbar.touchTarget, flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: theme.spacing[1] },
  userMessageExpansionText: { color: theme.color.text.tertiary, ...theme.platformTypography.chat },
  userMessageExpansionOpen: { transform: [{ rotate: "-90deg" }] },
  userMessageExpansionClosed: { transform: [{ rotate: "90deg" }] },
  userAttachments: { maxWidth: theme.metrics.conversation.userMaximumWidth, minWidth: 0, flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: theme.spacing[2] },
  userImage: { width: 132, height: 104, alignItems: "center", justifyContent: "center", overflow: "hidden", borderWidth: 1, borderColor: theme.color.border.subtle, borderRadius: theme.radii.xl, backgroundColor: theme.color.surface.subtle },
  userImageContent: { width: "100%", height: "100%" },
  userAttachmentChip: { minHeight: 34, justifyContent: "center", paddingHorizontal: theme.spacing[3], borderRadius: theme.radii.lg, backgroundColor: theme.color.button.secondary },
  userAttachmentChipText: { color: theme.color.text.secondary, ...theme.platformTypography.label },
  messageText: { color: theme.color.text.primary, ...theme.platformTypography.chat },
  messageActions: { height: theme.metrics.toolbar.touchTarget, flexDirection: "row", alignItems: "center", gap: theme.spacing[4] },
  hookStatsSummary: { maxWidth: 320, alignSelf: "flex-start", gap: theme.spacing[2], paddingHorizontal: theme.spacing[3], paddingVertical: theme.spacing[2], borderWidth: 1, borderColor: theme.color.border.default, borderRadius: theme.radii.lg, backgroundColor: theme.material.raised },
  hookStatsTitle: { color: theme.color.text.primary, ...theme.platformTypography.label, fontWeight: "600" },
  hookStatsCounts: { flexDirection: "row", flexWrap: "wrap", columnGap: theme.spacing[3], rowGap: theme.spacing[1] },
  hookStatsLabel: { color: theme.color.text.tertiary, ...theme.platformTypography.caption },
  hookStatsValue: { minWidth: 18, color: theme.color.text.primary, ...theme.platformTypography.caption, fontVariant: ["tabular-nums"] },
  hookStatsEntry: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[3] },
  hookStatsEntryText: { minWidth: 0, flex: 1, color: theme.color.text.primary, ...theme.platformTypography.caption },
  hookStatsRuns: { gap: theme.spacing[1] },
  hookStatsRun: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[4] },
  hookStatsRunEvent: { color: theme.color.text.primary, ...theme.platformTypography.caption },
  hookStatsRunBody: { minWidth: 0, flex: 1 },
  hookStatsRunError: { color: theme.color.accent.negative, ...theme.platformTypography.caption },
  reasoning: { gap: theme.spacing[2] },
  reasoningButton: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], minHeight: theme.metrics.toolbar.touchTarget },
  reasoningDot: { width: theme.metrics.control.activityDot, height: theme.metrics.control.activityDot, borderRadius: theme.radii.full },
  reasoningDone: { backgroundColor: theme.color.accent.positive },
  reasoningActive: { backgroundColor: theme.color.accent.blue },
  reasoningTitle: { flex: 1, color: theme.color.text.secondary, ...theme.platformTypography.body, fontWeight: "500" },
  thinkingPlaceholder: { minHeight: theme.metrics.toolbar.touchTarget, flexDirection: "row", alignItems: "center" },
  thinkingPlaceholderText: { color: theme.color.text.secondary, ...theme.platformTypography.body },
  cadencedText: { position: "relative", minWidth: 0, flexShrink: 1, overflow: "hidden" },
  cadencedTextSweep: { position: "absolute", top: 0, bottom: 0, left: 0, overflow: "hidden" },
  cadencedTextHighlight: { color: theme.color.text.primary, opacity: 0.72 },
  reasoningDetail: { marginLeft: theme.spacing[4], color: theme.color.text.tertiary, ...theme.platformTypography.body },
  chevronOpen: { transform: [{ rotate: "90deg" }] },
  activityDisclosure: { minWidth: 0, maxWidth: "100%" },
  activityDisclosureHeader: { minHeight: theme.metrics.toolbar.touchTarget, maxWidth: "100%", flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: theme.spacing[2], paddingHorizontal: 0 },
  activityDisclosureTitleRow: { minWidth: 0, flexShrink: 1, flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  activityDisclosureIcon: { width: theme.metrics.control.icon, height: theme.metrics.control.icon, alignItems: "center", justifyContent: "center" },
  activityDisclosureSummary: { flexShrink: 1, color: theme.color.text.secondary, ...theme.platformTypography.body, fontWeight: "500" },
  activityDisclosureDetail: { minWidth: 0, flexShrink: 1, color: theme.color.text.tertiary, ...theme.platformTypography.body },
  activityDisclosureBody: { minWidth: 0, gap: theme.spacing[2], paddingLeft: theme.spacing[5], paddingBottom: theme.spacing[1] },
  patchActivities: { minWidth: 0, gap: theme.spacing[1] },
  toolAccessory: { width: 16, height: 20, alignItems: "center", justifyContent: "center" },
  createdThreadCard: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: theme.spacing[3], paddingHorizontal: theme.spacing[3], paddingVertical: theme.spacing[2], borderRadius: theme.radii.xl, backgroundColor: theme.material.grouped },
  createdThreadIcon: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: theme.radii.lg, backgroundColor: theme.color.surface.subtle },
  createdThreadCopy: { minWidth: 0, flex: 1, gap: 1 },
  createdThreadTitle: { color: theme.color.text.primary, ...theme.platformTypography.label, fontWeight: "500" },
  createdThreadAction: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  createdThreadActionText: { color: theme.color.text.tertiary, ...theme.platformTypography.sidebarMeta },
  codexAppToolRow: { minHeight: theme.metrics.toolbar.touchTarget, maxWidth: "100%", flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: theme.spacing[2], paddingHorizontal: theme.spacing[1], borderRadius: theme.radii.sm },
  codexAppToolTitle: { minWidth: 0, flexShrink: 1, color: theme.color.text.tertiary, ...theme.platformTypography.label },
  handoffTool: { gap: theme.spacing[1] },
  handoffSteps: { gap: theme.spacing[2], paddingLeft: theme.spacing[5], paddingBottom: theme.spacing[1] },
  handoffStep: { minHeight: 22, flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  handoffStepIcon: { width: 16, height: 18, alignItems: "center", justifyContent: "center" },
  handoffStepText: { minWidth: 0, flexShrink: 1, color: theme.color.text.secondary, ...theme.platformTypography.body },
  handoffStepFailed: { color: theme.color.accent.negative },
  code: { marginHorizontal: theme.spacing[3], marginBottom: theme.spacing[3], padding: theme.spacing[2], borderRadius: theme.radii.sm, color: theme.color.text.secondary, backgroundColor: theme.color.surface.code, fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }), ...theme.platformTypography.code },
  output: { paddingHorizontal: theme.spacing[3], paddingBottom: theme.spacing[3], color: theme.color.text.tertiary, fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }), ...theme.platformTypography.code },
  toolParts: { gap: theme.spacing[2], paddingTop: theme.spacing[1] },
  webMcpBody: { gap: theme.spacing[1], paddingTop: theme.spacing[1] },
  codeLabel: { paddingHorizontal: theme.spacing[3], color: theme.color.text.tertiary, ...theme.platformTypography.sidebarMeta },
  toolPartError: { paddingHorizontal: theme.spacing[3], paddingBottom: theme.spacing[3], color: theme.color.accent.negative, ...theme.platformTypography.code },
  toolPartImage: { width: "100%", height: 240, backgroundColor: theme.color.surface.code },
  imageViewStrip: { gap: theme.spacing[2], paddingBottom: theme.spacing[1] },
  imageViewPreview: { width: 144, height: 104, overflow: "hidden", alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.border.subtle, borderRadius: theme.radii.lg, backgroundColor: theme.color.surface.raised },
  imageViewImage: { width: "100%", height: "100%" },
  toolPartResource: { paddingHorizontal: theme.spacing[3], paddingBottom: theme.spacing[3], color: theme.color.accent.blue, ...theme.platformTypography.body },
  autoReviewList: { gap: theme.spacing[1], paddingHorizontal: theme.spacing[3], paddingBottom: theme.spacing[2] },
  autoReview: { gap: theme.spacing[1] },
  autoReviewHeader: { minHeight: theme.metrics.toolbar.touchTarget, flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  autoReviewTitle: { minWidth: 0, flexShrink: 1, color: theme.color.text.tertiary, ...theme.platformTypography.body },
  autoReviewWarning: { color: theme.color.accent.negative },
  autoReviewSummary: { paddingBottom: theme.spacing[1], color: theme.color.text.secondary, ...theme.platformTypography.body },
  diffCounts: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  additions: { color: theme.color.accent.positive, ...theme.platformTypography.code },
  deletions: { color: theme.color.accent.negative, ...theme.platformTypography.code },
  fileRow: { minHeight: theme.metrics.toolbar.touchTarget, flexDirection: "row", alignItems: "center", gap: theme.spacing[3], paddingHorizontal: theme.spacing[3], borderTopWidth: 1, borderTopColor: theme.color.border.soft },
  filePath: { flex: 1, color: theme.color.text.secondary, ...theme.platformTypography.code },
  viewChanges: { height: theme.metrics.conversation.toolActionHeight, flexDirection: "row", alignItems: "center", gap: theme.spacing[2], paddingHorizontal: theme.spacing[3], borderTopWidth: 1, borderTopColor: theme.color.border.soft },
  viewChangesText: { color: theme.color.text.secondary, ...theme.platformTypography.label },
  turnDiffLive: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: theme.spacing[1] },
  turnDiffLiveText: { color: theme.color.text.secondary, ...theme.platformTypography.body },
  turnDiffCard: { overflow: "hidden", borderWidth: 1, borderColor: theme.color.border.soft, borderRadius: theme.radii.xl, backgroundColor: theme.material.grouped },
  turnDiffHeader: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: theme.spacing[3], padding: theme.spacing[2] },
  turnDiffIcon: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: theme.radii.lg, backgroundColor: theme.color.surface.subtle },
  turnDiffCopy: { minWidth: 0, flex: 1, gap: 1 },
  turnDiffTitle: { color: theme.color.text.primary, ...theme.platformTypography.label, fontWeight: "500" },
  turnDiffReview: { minHeight: 28, justifyContent: "center", paddingHorizontal: theme.spacing[2], borderWidth: 1, borderColor: theme.color.border.default, borderRadius: theme.radii.md },
  turnDiffReviewText: { color: theme.color.text.primary, ...theme.platformTypography.sidebarMeta },
  turnDiffFiles: { borderTopWidth: 1, borderTopColor: theme.color.border.soft },
  automationUpdateCard: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: theme.spacing[3], marginTop: theme.spacing[3], marginBottom: theme.spacing[2], padding: theme.spacing[2], overflow: "hidden", borderWidth: 1, borderColor: theme.color.border.soft, borderRadius: theme.radii.xl, backgroundColor: theme.material.grouped },
  automationUpdateSubtitle: { color: theme.color.text.tertiary, ...theme.platformTypography.sidebarMeta },
  semanticCard: { gap: theme.spacing[2], padding: theme.spacing[3], borderWidth: 1, borderColor: theme.color.border.default, borderRadius: theme.radii.xl, backgroundColor: theme.material.grouped },
  pendingRequestRegion: { width: "100%", alignItems: "center", paddingHorizontal: theme.spacing[6] },
  pendingRequestSurface: {
    width: "100%",
    maxWidth: theme.metrics.composer.maximumWidth,
    overflow: "hidden",
    borderRadius: 24,
    backgroundColor: theme.material.grouped,
    shadowColor: theme.shadow.prominent.color,
    shadowOpacity: theme.shadow.prominent.opacity,
    shadowRadius: theme.shadow.prominent.radius,
    shadowOffset: { width: 0, height: theme.shadow.prominent.offsetY },
    elevation: theme.shadow.prominent.elevation,
  },
  pendingSemanticCard: { borderWidth: 0, borderRadius: 24, padding: theme.spacing[4], backgroundColor: theme.material.grouped },
  awaitingApproval: { minHeight: 20, justifyContent: "center", paddingLeft: theme.spacing[6] },
  awaitingApprovalText: { color: theme.color.text.tertiary, opacity: 0.45, ...theme.platformTypography.body },
  completedInteraction: { minHeight: theme.metrics.toolbar.touchTarget, flexDirection: "row", alignItems: "center", gap: theme.spacing[2], paddingLeft: theme.spacing[4] },
  completedInteractionTitle: { color: theme.color.text.secondary, ...theme.platformTypography.body },
  completedInteractionStatus: { color: theme.color.text.tertiary, ...theme.platformTypography.caption },
  semanticTitle: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  semanticTitleText: { flex: 1, color: theme.color.text.primary, ...theme.platformTypography.label },
  semanticStatus: { color: theme.color.text.tertiary, ...theme.platformTypography.sidebarMeta },
  semanticBody: { color: theme.color.text.secondary, ...theme.platformTypography.body },
  agentActivity: { gap: theme.spacing[1] },
  activityContent: { gap: 16 },
  workStatusLabel: { color: theme.color.text.secondary, ...theme.platformTypography.body, fontVariant: ["tabular-nums"] },
  workStatusButton: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 4, borderWidth: 1, borderColor: "transparent", borderRadius: 6 },
  workStatusRuleRow: { paddingTop: 4 },
  workStatusRule: { width: "100%", borderTopWidth: 1, borderColor: theme.color.border.default },
  workStatusDivider: { gap: 8, overflow: "hidden" },
  agentActivityRows: { gap: theme.spacing[2], paddingLeft: theme.spacing[4] },
  subagentActivity: { gap: theme.spacing[2] },
  subagentHeader: { minHeight: theme.metrics.toolbar.touchTarget, flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  subagentChips: { minWidth: 0, flex: 1, flexDirection: "row", gap: theme.spacing[1] },
  subagentChip: { maxWidth: 152, height: 28, flexDirection: "row", alignItems: "center", gap: theme.spacing[1], paddingHorizontal: theme.spacing[2], borderWidth: 1, borderColor: theme.color.border.soft, borderRadius: theme.radii.full },
  subagentAvatar: { width: 16, height: 16, overflow: "hidden", color: theme.color.text.secondary, textAlign: "center", ...theme.platformTypography.caption },
  subagentName: { flexShrink: 1, color: theme.color.text.secondary, ...theme.platformTypography.label },
  subagentStatus: { color: theme.color.text.tertiary, ...theme.platformTypography.caption },
  subagentRows: { gap: theme.spacing[2], paddingLeft: theme.spacing[4] },
  subagentRow: { gap: theme.spacing[1] },
  interactionActions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  interactionButton: { paddingHorizontal: theme.spacing[3], paddingVertical: theme.spacing[2], borderWidth: 1, borderColor: theme.color.border.default, borderRadius: theme.radii.lg, backgroundColor: theme.material.raised },
  interactionButtonText: { color: theme.color.text.primary, ...theme.platformTypography.label },
  approvalCommand: { paddingHorizontal: theme.spacing[3], paddingVertical: theme.spacing[2], borderRadius: theme.radii.md, backgroundColor: theme.color.surface.code, color: theme.color.text.primary, ...theme.platformTypography.code },
  approvalDetail: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[3] },
  mcpApprovalHeader: { minHeight: 20, flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  mcpApprovalConnector: { color: theme.color.text.secondary, ...theme.platformTypography.label, fontWeight: "500" },
  mcpApprovalRisk: { color: theme.color.accent.warning, ...theme.platformTypography.label, fontWeight: "500" },
  mcpApprovalParams: { gap: theme.spacing[1], paddingTop: theme.spacing[1] },
  mcpApprovalParam: { minWidth: 0, flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[3] },
  mcpApprovalParamLabel: { width: 96, color: theme.color.text.tertiary, ...theme.platformTypography.sidebarMeta },
  mcpApprovalParamValue: { minWidth: 0, flex: 1, gap: 2 },
  externalToolFooter: { gap: theme.spacing[3] },
  externalToolPersist: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: theme.spacing[2] },
  externalToolCheckbox: { width: 16, height: 16, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.color.border.default, borderRadius: theme.radii.sm },
  externalToolCheckboxChecked: { backgroundColor: theme.color.surface.subtle },
  questionHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: theme.spacing[2] },
  questionPagination: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  questionOptions: { gap: theme.spacing[1] },
  questionOption: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: theme.spacing[2], paddingHorizontal: theme.spacing[2], paddingVertical: theme.spacing[2], borderRadius: theme.radii.lg },
  questionOptionSelected: { backgroundColor: theme.color.surface.subtle },
  questionOptionKey: { width: 20, height: 20, textAlign: "center", textAlignVertical: "center", borderWidth: 1, borderColor: theme.color.border.default, borderRadius: theme.radii.sm, color: theme.color.text.tertiary, ...theme.platformTypography.caption },
  questionOptionCopy: { flex: 1, gap: 1 },
  questionInput: { minHeight: 42, paddingHorizontal: theme.spacing[3], borderRadius: theme.radii.lg, backgroundColor: theme.material.raised, color: theme.color.text.primary, ...theme.platformTypography.body },
  optionPicker: { overflow: "hidden", borderRadius: 24, backgroundColor: theme.material.grouped },
  optionPickerHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: theme.spacing[3], paddingTop: theme.spacing[4], paddingRight: theme.spacing[3], paddingBottom: theme.spacing[3], paddingLeft: theme.spacing[4] },
  optionPickerQuestion: { minWidth: 0, flex: 1, color: theme.color.text.primary, ...theme.platformTypography.label },
  optionPickerDismiss: { width: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: theme.radii.md },
  optionPickerChoices: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2], paddingHorizontal: theme.spacing[3], paddingBottom: theme.spacing[4] },
  optionPickerChoice: { minHeight: 34, justifyContent: "center", paddingHorizontal: theme.spacing[3], paddingVertical: theme.spacing[1], borderWidth: 1, borderColor: theme.color.border.default, borderRadius: theme.radii.full },
  optionPickerChoiceSelected: { backgroundColor: theme.color.surface.subtle },
  optionPickerChoiceText: { color: theme.color.text.primary, ...theme.platformTypography.body },
  optionPickerInput: { minWidth: 134, minHeight: 34, flexGrow: 1, paddingHorizontal: theme.spacing[3], paddingVertical: theme.spacing[1], borderWidth: 1, borderColor: theme.color.border.default, borderRadius: theme.radii.lg, backgroundColor: theme.material.raised, color: theme.color.text.primary, ...theme.platformTypography.body },
  optionPickerFooter: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2], paddingHorizontal: theme.spacing[3], paddingBottom: theme.spacing[3] },
  optionPickerSkip: { minHeight: 32, justifyContent: "center", paddingHorizontal: theme.spacing[3] },
  optionPickerSkipText: { color: theme.color.text.secondary, ...theme.platformTypography.body },
  optionPickerSubmit: { minHeight: 32, justifyContent: "center", paddingHorizontal: theme.spacing[3], borderRadius: theme.radii.lg, backgroundColor: theme.color.button.primary },
  optionPickerSubmitText: { color: theme.color.text.onAccent, ...theme.platformTypography.label },
  optionPickerDisabled: { opacity: theme.metrics.interaction.disabledOpacity },
  setupTask: { gap: theme.spacing[2], overflow: "hidden", borderRadius: 24, paddingBottom: theme.spacing[1], backgroundColor: theme.material.grouped },
  setupTaskHeaderCopy: { minWidth: 0, flex: 1, gap: 2 },
  setupContext: { gap: theme.spacing[2], overflow: "hidden", borderRadius: 24, backgroundColor: theme.material.grouped },
  setupContextList: { maxHeight: 216, paddingHorizontal: theme.spacing[2] },
  setupContextRow: { minHeight: 50, flexDirection: "row", alignItems: "center", gap: theme.spacing[2], paddingHorizontal: theme.spacing[2], paddingVertical: theme.spacing[1], borderRadius: theme.radii.lg },
  setupContextLogo: { width: 30, height: 30, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.color.border.soft, borderRadius: theme.radii.md, backgroundColor: theme.material.raised },
  elicitationForm: { gap: theme.spacing[3] },
  elicitationField: { gap: theme.spacing[2] },
  elicitationLabel: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: theme.spacing[2] },
  elicitationUrl: { paddingHorizontal: theme.spacing[3], paddingVertical: theme.spacing[2], borderRadius: theme.radii.lg, backgroundColor: theme.color.surface.code },
  elicitationUrlText: { color: theme.color.accent.blue, ...theme.platformTypography.body },
  elicitationError: { color: theme.color.accent.negative, ...theme.platformTypography.caption },
  eventDivider: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  eventLine: { height: 1, flex: 1, backgroundColor: theme.color.border.soft },
  eventText: { color: theme.color.text.tertiary, ...theme.platformTypography.caption },
  generatedImagePreview: { alignSelf: "flex-start", width: "100%", maxWidth: 400, overflow: "hidden", borderRadius: 16, backgroundColor: theme.material.raised },
  generatedImage: { width: "100%", maxHeight: 560, backgroundColor: theme.material.raised },
  generatedImagePlaceholder: { alignSelf: "flex-start", width: "24%", maxWidth: 174, aspectRatio: 1, borderRadius: 16, backgroundColor: theme.material.grouped },
  empty: { flex: 1, minHeight: theme.metrics.conversation.emptyMinimumHeight, alignItems: "center", justifyContent: "center", gap: theme.spacing[3] },
  emptyMark: { width: theme.metrics.toolbar.touchTarget, height: theme.metrics.toolbar.touchTarget, alignItems: "center", justifyContent: "center", marginBottom: theme.spacing[1], borderRadius: theme.radii.xl, backgroundColor: theme.material.grouped },
  emptyTitle: { color: theme.color.text.primary, ...theme.platformTypography.emptyTitle },
  emptyText: { maxWidth: theme.metrics.conversation.emptyMaximumWidth, color: theme.color.text.tertiary, ...theme.platformTypography.body, textAlign: "center" },
  suggestions: { width: "100%", maxWidth: theme.metrics.conversation.emptyMaximumWidth, gap: theme.spacing[2], marginTop: theme.spacing[3] },
  suggestion: { height: theme.metrics.conversation.suggestionHeight, flexDirection: "row", alignItems: "center", gap: theme.spacing[3], paddingHorizontal: theme.spacing[4], borderWidth: 1, borderColor: theme.material.separator, borderRadius: theme.radii.xl, backgroundColor: theme.material.raised },
  suggestionText: { flex: 1, color: theme.color.text.primary, ...theme.platformTypography.label },
  pressed: { opacity: theme.metrics.interaction.pressedOpacity },
}));
