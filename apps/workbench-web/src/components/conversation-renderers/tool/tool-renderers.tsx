import { MediaPlayer } from "@opencraft/file-preview-web/media-player";
import { workbenchIconMetrics } from "@opencraft/design-system/tokens";
import { ConversationAppearanceIcon } from "../../conversation-appearance";
import { useRevealSearchItem } from "../../conversation/search-target";
import { FormattedList, FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { collaborationMessages, collaborationStateMessage } from "./collaboration-messages";
import { CheckIcon as Check, ChevronRightIcon as ChevronRight, LoadingRingIcon as LoaderCircle, CloseIcon as X } from "@opencraft/design-system-web/action-icons";
import {
  threadToolNavigationTarget, createdThreadToolResult,
  deriveSubagentActivitySummary, deriveSubagentActivityPresentation,
  type SubagentActivityMember,
  extractToolCallContentParts, formatThreadHandoffStepLabel, isCodexAppThreadTool,
  threadHandoffToolResult, visibleThreadHandoffSteps,
  type SubagentActivityRenderUnit, type TimelineBlock, type ToolCallContentPart,
  type WebMcpToolSurfaceCall,
} from "@opencraft/chat-core";
import { ImagePreview, LazyHighlightedCodeSurface, resolveStandardChatResource } from "@opencraft/chat-render-web";
import { CircleIcon as Circle, CodeIcon as Code2, GlobeIcon as Globe2, ImageIcon, MessageIcon as MessageSquare } from "@opencraft/design-system-web/action-icons";
import { lazy, Suspense, useCallback, useContext, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Button, IconButton, InlineAction } from "@opencraft/design-system-web/button";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { useDisclosureReflow } from "../../use-disclosure-reflow";
import { useDisclosureHeight } from "../../use-disclosure-height";
import { ConversationDocumentContext, browserReadableImageSource } from "../../conversation/document-context";
import { useConversationMediaSource } from "../../conversation/conversation-media-source";
import { usePreviewImageEdit } from "../../conversation/use-preview-image-edit";
import { ModalSurface } from "../../modal";
import { ActivityRowContent } from "../activity/activity-row-content";
import { activityIcon } from "../activity/activity-icon";
import { AutomaticApprovalReviewIcon, AutomaticApprovalReviewList } from "../activity/command-and-review-renderers";
import { ActivityDisclosure, useActivityOpen } from "../activity/activity-disclosure";
import {
  SubagentNavigationContext, ToolCallContentRendererContext, ToolCallIconRendererContext,
  useToolActivityPresentation,
  useHistoryItemDetail,
} from "../render-contexts";

type Tool = Extract<TimelineBlock, { type: "tool-call" }>;
type Image = Extract<TimelineBlock, { type: "image" }>;
type AgentBlock = Extract<TimelineBlock, { type: "subagent" }>;
const AppSurface = lazy(() => import("../../../mcp-apps/app-surface"));

function json(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
}

export function JsonPreview({ value }: { value: unknown }) {
  return value == null ? <></> : <pre>{json(value)}</pre>;
}

function JsonSurface({ value, documentId, showActions = false, title = "JSON" }: { value: unknown; documentId: string; showActions?: boolean; title?: string }) {
  const { theme } = useContext(ConversationDocumentContext);
  return <LazyHighlightedCodeSurface code={json(value)} language="json" title={title}
    documentId={documentId} theme={theme} showActions={showActions} />;
}

function ResourceLink({ target, children }: { target: string; children: import("react").ReactNode }) {
  const context = useContext(ConversationDocumentContext);
  const decision = resolveStandardChatResource(target, { cwd: context.cwd, externalResourcePolicy: "allow" });
  return <a href={decision.allowed ? decision.target ?? undefined : undefined}
    onClick={event => {
      event.preventDefault();
      if (decision.allowed && decision.target !== null) context.onOpenResource?.(decision.target, decision);
    }}>{children}</a>;
}

function ToolImage({ source, alt, id }: { source: string; alt: string; id: string }) {
  const context = useContext(ConversationDocumentContext);
  const media = useConversationMediaSource(source, id, context.resolveImageSource);
  return media.source === null ? <span>{media.status === "loading" ? "Loading image…" : "Image unavailable"}</span>
    : <img className="thread-tool-details__image" src={media.source} alt={alt} onLoad={() => media.requestMeasurement("image-load")} />;
}

function ContentPart({ part, id, showRole }: { part: ToolCallContentPart; id: string; showRole: boolean }) {
  let body;
  switch (part.kind) {
    case "text":
      body = part.role === "error" ? <pre className="thread-tool-details__error">{part.text}</pre>
        : <div className="thread-tool-details__plaintext"><header>plaintext</header><pre>{part.text}</pre></div>;
      break;
    case "json": body = <JsonSurface value={part.value} documentId={id} />; break;
    case "unknown": body = <div className="thread-tool-details__unknown"><JsonPreview value={part.value} /></div>; break;
    case "image": body = <div><ToolImage source={part.source} alt={part.alt ?? "Tool image"} id={id} /></div>; break;
    case "audio": body = <MediaPlayer kind="audio" className="thread-tool-details__audio" source={browserReadableImageSource(part.source, undefined) ?? undefined} />; break;
    case "resource-link": body = <div className="thread-tool-details__resource-link"><ResourceLink target={part.uri}>Read {part.name}</ResourceLink></div>; break;
    case "embedded-resource": body = <div className="thread-tool-details__embedded-resource">
      <div><b>URI</b><ResourceLink target={part.uri}>{part.uri}</ResourceLink></div>
      {part.mimeType ? <div><b>MIME type</b><span>{part.mimeType}</span></div> : null}
      {part.content !== null ? <div><b>Content</b><pre className="thread-tool-details__embedded-content">{part.content}</pre></div> : null}
    </div>; break;
  }
  return <section data-role={part.role}>{showRole ? <span>{part.role === "input" ? "Input" : part.role === "output" ? "Output" : "Error"}</span> : null}{body}{part.annotations ? <div className="thread-tool-details__annotations">
    {part.annotations.audience.length > 0 ? <span>Audience: {part.annotations.audience.join(", ")}</span> : null}
    {part.annotations.priority !== null ? <span>Priority: {part.annotations.priority}</span> : null}
    {part.annotations.lastModified !== null ? <span>Last modified: {part.annotations.lastModified}</span> : null}
  </div> : null}</section>;
}

function websiteToolValue(value: string | null, truncated: boolean): unknown {
  if (value === null || truncated) return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function WebToolCall({ call, documentId }: { call: WebMcpToolSurfaceCall; documentId: string }) {
  const [open, setOpen] = useActivityOpen(false, false, JSON.stringify(["webmcp", documentId, call.name]));
  const words = call.name.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[_-]+/gu, " ").trim();
  const summary = call.kind === "listTools" ? "Listed website tools"
    : call.title ?? (words ? words[0]!.toLocaleUpperCase() + words.slice(1) : call.name);
  const input = call.kind === "invokeTool" ? websiteToolValue(call.inputJson, call.inputTruncated) : null;
  const details = {
    name: call.name,
    ...(call.title === null ? {} : { title: call.title }),
    ...(call.description === null ? {} : { description: call.description }),
    ...(call.sourceHostname === null ? {} : { website: call.sourceHostname }),
    ...(call.readOnlyHint === null ? {} : { readOnlyHint: call.readOnlyHint }),
    ...(input === null ? {} : { input }),
    ...(call.inputTruncated ? { inputTruncated: true } : {}),
  };
  const output = websiteToolValue(call.outputJson, call.outputTruncated);
  return <ActivityDisclosure icon={<Globe2 />} summary={summary} open={open}
    onOpenChange={setOpen} running={false} unmountBodyWhenCollapsed>
    <div className="thread-webmcp-details">
      <JsonSurface value={details} documentId={documentId + ":tool"}
        title={call.inputTruncated ? "Tool (input truncated)" : "Tool"} />
      {output === null ? null : <JsonSurface value={output} documentId={documentId + ":result"}
        title={call.outputTruncated ? "Result (truncated)" : "Result"} />}
    </div>
  </ActivityDisclosure>;
}

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function RawToolOutput({ block }: { block: Tool }) {
  const [open, setOpen] = useState(false);
  const title = "Raw " + [block.server ?? block.namespace, block.name].filter(Boolean).join(".") + " tool call output";
  const output = object(block.output);
  const result = block.kind === "mcp"
    ? block.errorMessage !== null
      ? { type: "error", kind: "protocol", error: block.errorMessage, rawError: { message: block.errorMessage }, raw: block.output ?? undefined }
      : block.output === null
        ? null
        : { type: "success", content: Array.isArray(output?.content) ? output.content : [],
            structuredContent: output?.structuredContent ?? null, raw: block.output }
    : { success: block.status === "complete", contentItems: block.output };
  const value = {
    callId: block.callId,
    invocation: { server: block.server ?? block.namespace, tool: block.name, arguments: block.input },
    durationMs: block.durationMs,
    result,
  };
  return <><button type="button" className="thread-tool-details__raw" title="Show raw tool call output"
    aria-label="Show raw tool call output" onClick={() => setOpen(true)}><Code2 size={12} /></button>
    {open ? <ModalSurface label={title} size="wide" layer="nested" onDismiss={() => setOpen(false)}>
      <h2>{title}</h2><JsonSurface value={value} documentId={block.id + ":raw"} showActions />
    </ModalSurface> : null}</>;
}

function ThreadTool({ block }: { block: Tool }) {
  const documentContext = useContext(ConversationDocumentContext);
  const presentation = useToolActivityPresentation(block);
  const navigation = useContext(SubagentNavigationContext);
  const [open, setOpen] = useActivityOpen(presentation.state === "running", false, `thread-handoff:${block.id}`);
  const created = createdThreadToolResult(block);
  const target = threadToolNavigationTarget(block);
  const handoff = threadHandoffToolResult(block);
  if (created !== null) return <button type="button" className="thread-created-thread-card" aria-label="Open chat"
    disabled={navigation.open === null} onClick={() => navigation.open?.(created.threadId, created.title)}>
    <span className="thread-created-thread-card__icon"><ConversationAppearanceIcon hostId={documentContext.hostId ?? ""} threadId={created.threadId} size={workbenchIconMetrics.core.panel} fallback={<MessageSquare size={14} />} /></span>
    <span className="thread-created-thread-card__copy"><strong>{created.title}</strong></span>
    <span className="thread-created-thread-card__action">Open chat <ChevronRight size={13} /></span>
  </button>;
  const handoffSteps = handoff === null ? [] : visibleThreadHandoffSteps(handoff);
  if (handoff !== null && handoffSteps.length > 0) {
    return <ActivityDisclosure icon={activityIcon(presentation.icon)} summary={presentation.summary} open={open} onOpenChange={setOpen}
      running={presentation.state === "running"} status={presentation.state} bodyVariant="unindented">
      <div className="thread-handoff-steps">{handoffSteps.map((step, index) =>
        <div key={step.id + ":" + index} className="thread-handoff-step" data-status={step.status}>
          <span className="thread-handoff-step__icon" aria-label={({
            done: "Completed:", running: "Running:", failed: "Failed:", pending: "Pending:",
          } as const)[step.status]}>{step.status === "done" ? <Check size={14} />
            : step.status === "running" ? <LoaderCircle size={14} /> : step.status === "failed" ? <X size={14} /> : <Circle size={14} />}</span>
          <span>{formatThreadHandoffStepLabel(step.id, handoff)}</span>
        </div>)}
      </div>
    </ActivityDisclosure>;
  }
  const summary = <ActivityRowContent icon={activityIcon(presentation.icon)} summary={presentation.summary}
    running={presentation.state === "running"} />;
  return target !== null ? <button type="button" className="thread-tool-row thread-activity-item__header is-interactive" aria-label="Open chat"
    disabled={navigation.open === null} onClick={() => navigation.open?.(target.threadId, target.displayName)}>{summary}</button>
    : <div className="thread-tool-row thread-activity-item__header">{summary}</div>;
}

export function ToolCallBlock({ block }: { block: Tool }) {
  const presentation = useToolActivityPresentation(block);
  const customContent = useContext(ToolCallContentRendererContext);
  const customIcon = useContext(ToolCallIconRendererContext);
  const content = customContent?.(block, presentation);
  const hasCustomBody = content !== undefined && content !== null && content !== false;
  const [open, setOpen] = useActivityOpen(block.kind !== "mcp" && presentation.state === "running"
    && (presentation.canExpand || hasCustomBody), false, `tool:${block.id}`);
  useRevealSearchItem(block.sourceItemIds, () => setOpen(true));
  useHistoryItemDetail(block, open);
  const icon = customIcon?.(block, presentation);
  if (block.kind === "image-view") return <ImageViewToolBlock block={block} />;
  if (isCodexAppThreadTool(block) && content === undefined) return <ThreadTool block={block} />;
  const parts = extractToolCallContentParts(block).filter(part => block.kind !== "mcp" || part.role !== "input");
  const hasCoreBody = presentation.canExpand;
  const coreBody = hasCoreBody ? <div className="thread-tool-details" data-kind={block.kind}>
    {parts.length > 0 ? parts.map((part, index) => <ContentPart key={index} part={part} id={block.id + ":" + index}
      showRole={block.kind !== "mcp" && (index === 0 || parts[index - 1]?.role !== part.role)} />)
      : <p className="thread-tool-details__empty">Tool returned no content</p>}
    <RawToolOutput block={block} />
  </div> : undefined;
  const body = content === undefined ? coreBody : content;
  const hasBody = (content === undefined ? hasCoreBody : hasCustomBody) || block.automaticApprovalReviews.length > 0;
  return <><ActivityDisclosure icon={icon === undefined ? activityIcon(presentation.icon) : icon}
    summary={presentation.summary} detail={presentation.detail} open={open} onOpenChange={setOpen}
    running={presentation.state === "running"} status={presentation.state}
    bodyVariant={hasBody ? "grouped" : "default"}
    accessory={block.automaticApprovalReviews.length > 0 ? <AutomaticApprovalReviewIcon /> : undefined}
    unmountBodyWhenCollapsed>
    {hasBody ? <>{body}<AutomaticApprovalReviewList blockId={block.id} reviews={block.automaticApprovalReviews} /></> : undefined}
  </ActivityDisclosure>
    {block.appResourceUri !== null ? <Suspense fallback={null}><AppSurface block={block} /></Suspense> : null}
    {block.webMcpCalls?.map((call, index) => <WebToolCall key={call.name + ":" + index} call={call}
      documentId={block.id + ":webmcp:" + index} />)}
  </>;
}

function InspectedImage({ path, index, id }: { path: string; index: number; id: string }) {
  const context = useContext(ConversationDocumentContext);
  const media = useConversationMediaSource(path, id, context.resolveImageSource);
  const decision = resolveStandardChatResource(path, { cwd: context.cwd, externalResourcePolicy: "allow" });
  return <button type="button" className="thread-image-view__preview" title={path}
    aria-label={"Open inspected image " + (index + 1)} disabled={!decision.allowed || context.onOpenResource === undefined}
    onClick={() => {
      if (decision.allowed && decision.target !== null) context.onOpenResource?.(decision.target, decision);
    }}>{media.source !== null ? <img src={media.source} alt={path} onLoad={() => media.requestMeasurement("image-load")} />
      : <span>{media.status === "loading" ? "Loading image…" : "Image unavailable"}</span>}</button>;
}

export function ImageViewToolBlock({ block }: { readonly block: Tool }) {
  const [open, setOpen] = useActivityOpen(false, false, JSON.stringify(["image-view", block.id]));
  const running = block.status === "pending" || block.status === "running";
  const paths = block.imagePaths ?? [];
  const summary = (running ? "Viewing " : "Viewed ") + (paths.length > 1 ? paths.length + " images" : "an image");
  return <ActivityDisclosure icon={<ImageIcon />} summary={summary} open={open} onOpenChange={setOpen}
    running={running} status={running ? "running" : block.status === "failed" ? "failed" : block.status === "interrupted" ? "interrupted" : "completed"} bodyVariant="grouped">
    {paths.length > 0 ? <div className="thread-image-view"><div className="thread-image-view__strip">{paths.map((path, index) =>
      <InspectedImage key={path + ":" + index} path={path} index={index} id={block.id + ":" + index} />)}</div></div> : undefined}
  </ActivityDisclosure>;
}

export function GeneratedImageBlock({ block }: { readonly block: Image }) {
  const context = useContext(ConversationDocumentContext);
  const [attempt, setAttempt] = useState(0);
  const owner = JSON.stringify([context.hostId, context.conversationId, block.id]);
  const [failedResource, setFailedResource] = useState<string | null>(null);
  const previous = useRef({ id: owner, dimensions: block.dimensions });
  if (previous.current.id !== owner) previous.current = { id: owner, dimensions: block.dimensions };
  else if (block.dimensions) previous.current.dimensions = block.dimensions;
  const dimensions = block.dimensions ?? previous.current.dimensions;
  // A failed derived reference restores the original Item through the existing authorized detail read.
  // Keep geometry while that fallback replaces the resource; never collapse the image slot.
  useHistoryItemDetail(block, failedResource === owner || Boolean(block.historyDetail && !block.savedPath && !block.dimensions), attempt);
  const source = context.resolveGeneratedImageSource?.(block)
    ?? (block.dimensions && block.uri ? block.uri : block.historyDetail ? block.savedPath : block.uri ?? block.savedPath);
  const identity = JSON.stringify([context.hostId, context.conversationId, context.cwd, block.id, source, block.savedPath, attempt]);
  const unavailable = useCallback(() => setFailedResource(owner), [owner]);
  return source === null ? <GeneratedImagePending dimensions={dimensions} running={block.status === "pending" || block.status === "running"} />
    : <GeneratedImage key={identity} block={block} dimensions={dimensions} source={source} onUnavailable={unavailable} onRetry={() => setAttempt(value => value + 1)} />;
}

function generatedImageFrame(dimensions: Image["dimensions"]) {
  return { className: "thread-generated-image-gallery" + (dimensions ? " thread-generated-image-gallery--sized" : ""),
    style: dimensions ? { "--generated-image-width": `${dimensions.width}px`, "--generated-image-ratio": dimensions.width / dimensions.height } as CSSProperties : undefined };
}
function GeneratedImagePending({ running, loading = false, dimensions }: { running: boolean; loading?: boolean; dimensions?: Image["dimensions"] }) {
  if (!running && !loading && !dimensions) return null;
  const label = running ? "Generating image" : "Loading generated image";
  return <div {...generatedImageFrame(dimensions)} className={generatedImageFrame(dimensions).className + " thread-generated-image-gallery--pending"}
    data-testid="generated-image-gallery" role="progressbar" aria-label={label} aria-valuetext={label}>
    <div className="thread-generated-image-placeholder" />
  </div>;
}

function GeneratedImage({ block, source, onRetry, onUnavailable, dimensions }: { block: Image; source: string; onRetry: () => void; onUnavailable: () => void; dimensions?: Image["dimensions"] }) {
  const context = useContext(ConversationDocumentContext);
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [failedSources, setFailedSources] = useState<readonly string[]>([]);
  const activeSource = failedSources.includes(source) && !(block.historyDetail && dimensions) ? block.savedPath ?? source : source;
  const resolveDirect = useCallback((path: string) =>
    (path === source ? context.resolveGeneratedImageSource?.(block) : null) ?? browserReadableImageSource(path, context.resolveImageSource),
  [block, source, context.resolveGeneratedImageSource, context.resolveImageSource]);
  const media = useConversationMediaSource(activeSource, block.id, resolveDirect);
  const markFailed = useCallback(() => {
    setFailedSources(previous => previous.includes(activeSource) ? previous : [...previous, activeSource]);
    if (block.historyDetail) onUnavailable();
  }, [activeSource, block.historyDetail, onUnavailable]);
  useEffect(() => {
    if (media.status === "unavailable") markFailed();
  }, [media.status, markFailed]);
  useEffect(() => {
    if (failedSources.length) media.requestMeasurement("image-load");
  }, [failedSources]);
  const imageEdit = usePreviewImageEdit(media.source, block.savedPath?.split(/[\\/]/u).at(-1) ?? "image.png", () => setOpen(false));
  if (failedSources.includes(activeSource)) return <div {...generatedImageFrame(dimensions)} role="status">
    <span>{intl.formatMessage({ id: "chat.image.unavailable", defaultMessage: "Image unavailable" })}</span>
    <Button size="sm" variant="ghost" onClick={onRetry}>{intl.formatMessage({ id: "common.retry", defaultMessage: "Try again" })}</Button>
  </div>;
  if (media.source === null) return <GeneratedImagePending dimensions={dimensions}
    running={block.status === "pending" || block.status === "running"} loading={media.status === "loading"} />;
  const alt = "Generated image 1";
  return <div {...generatedImageFrame(dimensions)} data-testid="generated-image-gallery">
    <div className="thread-generated-image-preview-wrap">
      <button type="button" className="thread-generated-image-preview" data-testid="generated-image-preview"
        aria-label={alt} onClick={() => context.onOpenGeneratedImage ? context.onOpenGeneratedImage(block) : setOpen(true)}>
        <img src={media.source} width={dimensions?.width} height={dimensions?.height} alt={alt} draggable onError={markFailed} onLoad={() => media.requestMeasurement("image-load")} />
      </button>
      {context.onEditGeneratedImage ? <button type="button" className="thread-generated-image-edit"
        aria-label="Edit generated image 1" onClick={() => context.onEditGeneratedImage?.(block)}>Edit</button> : null}
    </div>
    {open ? imageEdit.editor ?? <ImagePreview image={{ id: block.id, source: media.source, alt }} onClose={() => setOpen(false)}
      actions={<>{imageEdit.action}<div className="thread-generated-image-lightbox__toolbar">
        <a href={media.source} download={block.savedPath?.split(/[\\/]/u).at(-1) ?? "generated-image.png"}>Save</a>
      </div></>} /> : null}
  </div>;
}

function Avatar({ member }: { member: SubagentActivityMember }) {
  let color = 0;
  for (const character of member.threadId ?? member.key) color = (color * 31 + character.codePointAt(0)!) % 360;
  return <span className="thread-subagent-avatar" aria-hidden data-status={member.status}
    style={{ "--agent-hue": color + "deg" } as CSSProperties}>{member.displayName.slice(0, 1).toLocaleUpperCase()}</span>;
}

function SubagentDetails({ children, id, onComplete }: {
  children: import("react").ReactNode; id: string; onComplete: () => void;
}) {
  const present = useIsPresent();
  const reducedMotion = useReducedMotion();
  const height = useDisclosureHeight("auto");
  return <motion.div id={id} className="thread-subagent-details" inert={!present} aria-hidden={!present}
    initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
    style={{ height }} transition={{ duration: reducedMotion ? 0 : 0.2 }} onAnimationComplete={onComplete}>
    {children}
  </motion.div>;
}

function SubagentActivityRow({ blocks, restoreKey }: {
  blocks: readonly AgentBlock[]; restoreKey: string;
}) {
  const navigation = useContext(SubagentNavigationContext);
  const intl = useIntl();
  const detailsId = useId();
  const toolName = (tool: AgentBlock["tool"]) => intl.formatMessage(tool === "spawnAgent" ? collaborationMessages.create
    : tool === "sendInput" ? collaborationMessages.send : tool === "resumeAgent" ? collaborationMessages.resume
    : tool === "wait" ? collaborationMessages.wait : tool === "closeAgent" ? collaborationMessages.close : collaborationMessages.collaborate);
  const stateName = (state: string) => intl.formatMessage(collaborationStateMessage(state));
  const deliveryName = (state: AgentBlock["deliveryStatus"]) => intl.formatMessage(state === null ? collaborationMessages.none
    : collaborationMessages[state]);
  const presentation = deriveSubagentActivitySummary(blocks);
  const name = (value: string) => value === "Agent" ? intl.formatMessage(collaborationMessages.unnamed) : value;
  const [open, setOpen] = useActivityOpen(false, false, restoreKey);
  const [showAllAgents, setShowAllAgents] = useActivityOpen(false, false,
    JSON.stringify(["subagent-members", restoreKey]));
  const namedCount = presentation.members.length > 3 ? 2 : presentation.members.length;
  const members = presentation.members.slice(0, namedCount);
  const hiddenCount = presentation.members.length - namedCount;
  const reflow = useDisclosureReflow();
  const expandable = presentation.expandable || presentation.members.length > 1;
  const detailsByThread = new Map<string, AgentBlock>();
  const taskByThread = new Map<string, AgentBlock>();
  for (const block of blocks) {
    for (const agent of deriveSubagentActivityPresentation(block).agents) {
      detailsByThread.set(agent.threadId, block);
      if (block.prompt || block.action) taskByThread.set(agent.threadId, block);
    }
  }
  const renderName = (member: SubagentActivityMember) => member.threadId && navigation.open
    ? <InlineAction key={member.key} aria-label={intl.formatMessage(collaborationMessages.open, { name: name(member.displayName) })}
        onClick={() => navigation.open?.(member.threadId!, name(member.displayName))}>{name(member.displayName)}</InlineAction>
    : <span key={member.key}>{name(member.displayName)}</span>;
  const names = members.map(renderName);
  if (hiddenCount > 0) names.push(<InlineAction key="more" aria-expanded={open && showAllAgents} aria-controls={detailsId}
    onClick={event => { if (!open) reflow.begin(event.currentTarget); setShowAllAgents(true); setOpen(true); }}>
    {intl.formatMessage(collaborationMessages.more, { count: hiddenCount })}</InlineAction>);
  const detailMembers = showAllAgents ? presentation.members : presentation.members.slice(0, 3);
  return <section className="thread-subagent-activity" data-status={presentation.status} data-open={open || undefined}>
    <div className="thread-subagent-activity__header">
      <span className="thread-subagent-avatars" aria-hidden>
        {presentation.members.slice(0, 4).map(member => <span key={member.key} className="thread-subagent-avatar-entry"><Avatar member={member} /></span>)}
      </span>
      <span className="thread-subagent-activity__summary">
        <FormattedMessage {...collaborationMessages.activity} values={{
          names: names.length ? <FormattedList key="names" type="conjunction" value={names} /> : intl.formatMessage(collaborationMessages.unnamed),
          status: presentation.status, count: presentation.members.length || 1,
        }} />
      </span>
      {expandable ? <IconButton className="thread-subagent-activity__toggle" size="chrome" variant="ghost"
        aria-label={intl.formatMessage(open ? collaborationMessages.hideDetails : collaborationMessages.showDetails)}
        aria-expanded={open} aria-controls={detailsId} onClick={event => { reflow.begin(event.currentTarget); setOpen(!open); }}>
        <ChevronRight aria-hidden className="thread-subagent-activity__chevron" />
      </IconButton> : null}
    </div>
    <AnimatePresence initial={false} onExitComplete={reflow.complete}>{open && expandable ? <SubagentDetails id={detailsId} onComplete={reflow.complete}>
      <div className="thread-subagent-details__inner">
        {detailMembers.map(member => {
          const agent = presentation.agents.find(agent => agent.threadId === member.threadId);
          const block = member.threadId ? detailsByThread.get(member.threadId) : blocks.find(block => block.id === member.key);
          const task = member.threadId ? taskByThread.get(member.threadId) : block;
          return <div key={member.key} className="thread-subagent-details__row" data-status={member.status}>
            <Avatar member={member} /><div>
              <p>{renderName(member)} · {stateName(agent?.statusLabel ?? (member.status === "waiting" ? "starting" : member.status))}</p>
              {task?.prompt || task?.action ? <p>{task.prompt || task.action}</p> : null}
              {agent?.statusMessage ? <p className="thread-subagent-details__message">{agent.statusMessage}</p> : null}
            </div>
          </div>;
        })}
        {!showAllAgents && presentation.members.length > 3 ? <InlineAction aria-controls={detailsId}
          onClick={() => setShowAllAgents(true)}>
          {intl.formatMessage(collaborationMessages.more, { count: presentation.members.length - 3 })}
        </InlineAction> : null}
        {blocks.filter(block => block.tool !== null).map(block => <p key={block.id} className="thread-subagent-details__meta"
          data-tool-call-status={block.toolCallStatus} data-delivery-status={block.deliveryStatus ?? "none"}>
          {toolName(block.tool)} · {stateName(block.toolCallStatus)}
          {block.deliveryStatus ? <> · {deliveryName(block.deliveryStatus)}</> : null}
        </p>)}
        {blocks.length === 1 && (blocks[0]?.reasoningEffort || blocks[0]?.agentPath) ?
          <p className="thread-subagent-details__meta">{[
            blocks[0].reasoningEffort ? intl.formatMessage(collaborationMessages.reasoning, { effort: blocks[0].reasoningEffort }) : null,
            blocks[0].agentPath,
          ].filter(Boolean).join(" · ")}</p> : null}
      </div>
    </SubagentDetails> : null}</AnimatePresence>
  </section>;
}

export function SubagentBlock({ block }: { block: AgentBlock }) {
  return <SubagentActivityRow blocks={[block]} restoreKey={JSON.stringify(["subagent", block.id])} />;
}

export function SubagentActivityGroup({ unit }: { readonly unit: SubagentActivityRenderUnit }) {
  return unit.blocks.length > 0 ? <SubagentActivityRow blocks={unit.blocks}
    restoreKey={JSON.stringify(["subagent-group", unit.id])} /> : <></>;
}
