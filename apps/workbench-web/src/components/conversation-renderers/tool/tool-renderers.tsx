import { useIntl } from "@opencraft/i18n/react";
import { collaborationMessages, collaborationStateMessage } from "./collaboration-messages";
import { CheckIcon as Check, ChevronRightIcon as ChevronRight, LoadingRingIcon as LoaderCircle, CloseIcon as X } from "@opencraft/design-system-web/action-icons";
import {
  threadToolNavigationTarget, createdThreadToolResult,
  deriveSubagentActivityGroupPresentation, deriveSubagentActivityPresentation, subagentHeaderCall,
  extractToolCallContentParts, formatThreadHandoffStepLabel, isCodexAppThreadTool,
  threadHandoffToolResult, visibleThreadHandoffSteps,
  type SubagentActivityRenderUnit, type TimelineBlock, type ToolCallContentPart,
  type WebMcpToolSurfaceCall,
} from "@opencraft/chat-core";
import { ZoomableImage, LazyHighlightedCodeSurface, resolveStandardChatResource } from "@opencraft/chat-render-web";
import { CircleIcon as Circle, CodeIcon as Code2, GlobeIcon as Globe2, ImageIcon, MessageIcon as MessageSquare } from "@opencraft/design-system-web/action-icons";
import { lazy, Suspense, useCallback, useContext, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useDisclosureReflow } from "../../use-disclosure-reflow";
import { useDisclosureHeight } from "../../use-disclosure-height";
import { ConversationDocumentContext, browserReadableImageSource } from "../../conversation/document-context";
import { useConversationMediaSource } from "../../conversation/conversation-media-source";
import { ModalSurface } from "../../modal";
import { ActivityRowContent } from "../activity/activity-row-content";
import { AgentActivityIcon } from "../../activity-glyphs";
import { ActivityIcon, activityIcon } from "../activity/activity-icon";
import { AutomaticApprovalReviewIcon, AutomaticApprovalReviewList } from "../activity/command-and-review-renderers";
import { ActivityDisclosure, useActivityOpen } from "../activity/activity-disclosure";
import {
  SubagentNavigationContext, ToolCallContentRendererContext, ToolCallIconRendererContext,
  useToolActivityPresentation,
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
    case "audio": body = <audio className="thread-tool-details__audio" controls src={browserReadableImageSource(part.source, undefined) ?? undefined} />; break;
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
  const presentation = useToolActivityPresentation(block);
  const navigation = useContext(SubagentNavigationContext);
  const [open, setOpen] = useActivityOpen(presentation.state === "running", false, `thread-handoff:${block.id}`);
  const created = createdThreadToolResult(block);
  const target = threadToolNavigationTarget(block);
  const handoff = threadHandoffToolResult(block);
  if (created !== null) return <button type="button" className="thread-created-thread-card" aria-label="Open chat"
    disabled={navigation.open === null} onClick={() => navigation.open?.(created.threadId, created.title)}>
    <span className="thread-created-thread-card__icon"><MessageSquare size={14} /></span>
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
  const source = context.resolveGeneratedImageSource?.(block) ?? block.uri ?? block.savedPath;
  const identity = JSON.stringify([context.hostId, context.conversationId, context.cwd, block.id, source]);
  return source === null ? <GeneratedImagePending running={block.status === "pending" || block.status === "running"} />
    : <GeneratedImage key={identity} block={block} source={source} />;
}

function GeneratedImagePending({ running, loading = false }: { running: boolean; loading?: boolean }) {
  if (!running && !loading) return null;
  const label = running ? "Generating image" : "Loading generated image";
  return <div className="thread-generated-image-gallery thread-generated-image-gallery--pending"
    data-testid="generated-image-gallery" role="progressbar" aria-label={label} aria-valuetext={label}>
    <div className="thread-generated-image-placeholder" />
  </div>;
}

function GeneratedImage({ block, source }: { block: Image; source: string }) {
  const context = useContext(ConversationDocumentContext);
  const [open, setOpen] = useState(false);
  const resolveDirect = useCallback((path: string) =>
    context.resolveGeneratedImageSource?.(block) ?? browserReadableImageSource(path, context.resolveImageSource),
  [block, context.resolveGeneratedImageSource, context.resolveImageSource]);
  const media = useConversationMediaSource(source, block.id, resolveDirect);
  if (media.source === null) return <GeneratedImagePending
    running={block.status === "pending" || block.status === "running"} loading={media.status === "loading"} />;
  const alt = "Generated image 1";
  return <div className="thread-generated-image-gallery" data-testid="generated-image-gallery">
    <div className="thread-generated-image-preview-wrap">
      <button type="button" className="thread-generated-image-preview" data-testid="generated-image-preview"
        aria-label={alt} onClick={() => context.onOpenGeneratedImage ? context.onOpenGeneratedImage(block) : setOpen(true)}>
        <img src={media.source} alt={alt} draggable onLoad={() => media.requestMeasurement("image-load")} />
      </button>
      {context.onEditGeneratedImage ? <button type="button" className="thread-generated-image-edit"
        aria-label="Edit generated image 1" onClick={() => context.onEditGeneratedImage?.(block)}>Edit</button> : null}
    </div>
    {open ? <ModalSurface label={alt} className="thread-generated-image-lightbox__dialog" layer="nested"
      presentation="fullscreen" showCloseButton={false} onDismiss={() => setOpen(false)}>
      <ZoomableImage onBackgroundClick={() => setOpen(false)} src={media.source} alt={alt} />
      <div className="thread-generated-image-lightbox__toolbar">
        <a href={media.source} download={block.savedPath?.split(/[\\/]/u).at(-1) ?? "generated-image.png"}>Save</a>
        <button type="button" aria-label="Close generated image 1" onClick={() => setOpen(false)}><X size={18} /></button>
      </div>
    </ModalSurface> : null}
  </div>;
}

type Agent = ReturnType<typeof deriveSubagentActivityPresentation>["agents"][number];
function Avatar({ agent }: { agent: Agent }) {
  // Stable presentation only; thread identity and status remain owned by core.
  let color = 0;
  for (const character of agent.threadId) color = (color * 31 + character.codePointAt(0)!) % 360;
  return <span className="thread-subagent-avatar" aria-hidden data-status={agent.status}
    style={{ "--agent-hue": color + "deg" } as CSSProperties}>{agent.displayName.slice(0, 1).toLocaleUpperCase()}</span>;
}

type AgentToggle = {
  readonly label: string; readonly open: boolean; readonly disabled: boolean;
  readonly onClick: (event: import("react").MouseEvent<HTMLButtonElement>) => void;
};

function Agents({ blocks, grouped, restoreKey, renderToggle }: {
  blocks: readonly AgentBlock[]; grouped: boolean; restoreKey: string;
  renderToggle: (props: AgentToggle) => import("react").ReactNode;
}) {
  const navigation = useContext(SubagentNavigationContext);
  const intl = useIntl();
  const toolName = (tool:AgentBlock["tool"]) => intl.formatMessage(tool === "spawnAgent" ? collaborationMessages.create
    : tool === "sendInput" ? collaborationMessages.send : tool === "resumeAgent" ? collaborationMessages.resume
    : tool === "wait" ? collaborationMessages.wait : tool === "closeAgent" ? collaborationMessages.close : collaborationMessages.collaborate);
  const stateName = (state:string) => intl.formatMessage(collaborationStateMessage(state));
  const deliveryName = (state:AgentBlock["deliveryStatus"]) => intl.formatMessage(state === null ? collaborationMessages.none
    : collaborationMessages[state]);
  const presentation = grouped ? deriveSubagentActivityGroupPresentation(blocks)
    : deriveSubagentActivityPresentation(blocks[0]!);
  const detailsByThread = new Map<string, { block: AgentBlock; actionLabel: string }>();
  for (const block of blocks) {
    const detail = deriveSubagentActivityPresentation(block);
    for (const agent of detail.agents) detailsByThread.set(agent.threadId, { block, actionLabel: detail.actionLabel });
  }
  const headerCall = subagentHeaderCall(blocks)!;
  const running = blocks.some(block => block.status === "running" || block.status === "pending");
  const [open, setOpen] = useActivityOpen(running, false, restoreKey);
  const [showAllAgents, setShowAllAgents] = useActivityOpen(false, false,
    JSON.stringify(["subagent-members", restoreKey]));
  const visibleAgents = showAllAgents ? presentation.agents : presentation.agents.slice(0, 3);
  const hiddenAgentCount = presentation.agents.length - visibleAgents.length;
  const reflow = useDisclosureReflow();
  const height = useDisclosureHeight("auto");
  if (!grouped && blocks[0]!.tool === null && blocks[0]!.activityKind !== null && presentation.agents.length === 1) {
    const agent = presentation.agents[0]!;
    const canOpen = navigation.open !== null && agent.threadId.length > 0;
    return <button type="button" className="thread-subagent-inline" data-status={agent.displayStatus}
      disabled={!canOpen} aria-label={canOpen ? intl.formatMessage(collaborationMessages.open,{name:agent.displayName}) : undefined}
      onClick={() => navigation.open?.(agent.threadId, agent.displayName)}>
      <Avatar agent={agent} /><span>{intl.formatMessage(collaborationMessages.inline,{name:agent.displayName,status:stateName(agent.statusLabel)})}</span>
    </button>;
  }
  return <section className="thread-subagent-activity" data-status={presentation.summaryStatus} data-open={open || undefined}>
    <div className="thread-subagent-activity__header">
      {renderToggle({ label: toolName(headerCall.tool), open, disabled: !presentation.expandable, onClick: event => {
          reflow.begin(event.currentTarget); setOpen(!open);
        } })}
      <div className="thread-subagent-chips">{visibleAgents.map(agent =>
        <button key={agent.threadId} type="button" className="thread-subagent-chip" data-status={agent.status}
          title={agent.model ?? undefined} aria-label={intl.formatMessage(collaborationMessages.open,{name:agent.displayName})}
          disabled={navigation.open === null} onClick={() => navigation.open?.(agent.threadId, agent.displayName)}>
          <Avatar agent={agent} /><span>{agent.displayName}</span>{agent.role ? <small>{agent.role}</small> : null}
        </button>)}
        {hiddenAgentCount > 0 ? <button type="button" className="thread-subagent-chips__more"
          onClick={() => setShowAllAgents(true)}>{intl.formatMessage(collaborationMessages.more,{count:hiddenAgentCount})}</button> : null}
      </div>
      <span className="thread-subagent-activity__status" data-child-runtime-status={presentation.groupStatusLabel} data-summary-status={presentation.summaryStatus}>{stateName(presentation.summaryStatus)}</span>
      {presentation.expandable ? <ChevronRight size={12} className="thread-subagent-activity__chevron" /> : null}
    </div>
    <AnimatePresence initial={false}>{open && presentation.expandable ? <motion.div className="thread-subagent-details"
      initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
      style={{ height }} transition={{ duration: 0.3 }} onAnimationComplete={reflow.complete}>
      <div className="thread-subagent-details__inner">
      {blocks.map(block => {
        const detail = deriveSubagentActivityPresentation(block);
        const status = detail.groupStatusLabel;
        return <p key={block.id} className="thread-subagent-details__meta"
          title={intl.formatMessage(collaborationMessages.axes,{tool:stateName(block.toolCallStatus),delivery:deliveryName(block.deliveryStatus),child:stateName(status)})}
          data-tool-call-status={block.toolCallStatus} data-delivery-status={block.deliveryStatus ?? "none"}
          data-child-runtime-status={status === "started working" ? "working" : status === "finished" ? "done" : status}>
          {toolName(block.tool)} · {stateName(detail.summaryStatus)}
        </p>;
      })}
      {presentation.agents.map(agent => {
        const { block } = detailsByThread.get(agent.threadId)!;
        return <div key={agent.threadId} className="thread-subagent-details__row" data-status={agent.status}>
          <Avatar agent={agent} /><div><p><span>{toolName(block.tool)} </span><strong>{agent.displayName}</strong>
            {block.prompt && block.tool === "spawnAgent" ? <>：<span>{block.prompt}</span></>
              : block.prompt && (block.tool === "sendInput" || block.tool === "resumeAgent") ? <>: <span>{block.prompt}</span></>
              : !block.prompt && block.action ? <> · {block.action}</> : null}
</p>

            {agent.statusMessage ? <p className="thread-subagent-details__message">{agent.statusMessage}</p> : null}
          </div></div>;
      })}
      {!grouped && blocks[0]?.tool === "wait" && blocks[0].prompt ?
        <p className="thread-subagent-details__input">{intl.formatMessage(collaborationMessages.input,{input:blocks[0].prompt})}</p> : null}
      {!grouped && (blocks[0]?.reasoningEffort || blocks[0]?.agentPath) ?
        <p className="thread-subagent-details__meta">{[
          blocks[0].reasoningEffort ? intl.formatMessage(collaborationMessages.reasoning,{effort:blocks[0].reasoningEffort}) : null, blocks[0].agentPath,
        ].filter(Boolean).join(" · ")}</p> : null}
    </div></motion.div> : null}</AnimatePresence>
  </section>;
}

export function SubagentBlock({ block }: { block: AgentBlock }) {
  return <Agents blocks={[block]} grouped={false} restoreKey={JSON.stringify(["subagent", block.id])} renderToggle={props =>
    <button type="button" className="thread-subagent-activity__toggle thread-activity-item__header"
      aria-expanded={props.open} disabled={props.disabled} onClick={props.onClick}>
      <ActivityIcon><AgentActivityIcon /></ActivityIcon><span className="thread-activity-item__summary">{props.label}</span>
    </button>} />;
}

export function SubagentActivityGroup({ unit }: { readonly unit: SubagentActivityRenderUnit }) {
  return unit.blocks.length > 0 ? <Agents blocks={unit.blocks} grouped={unit.blocks.length > 1}
    restoreKey={JSON.stringify(["subagent-group", unit.id])} renderToggle={props =>
    <button type="button" className="thread-subagent-activity__toggle thread-activity-item__header"
      aria-expanded={props.open} disabled={props.disabled} onClick={props.onClick}>
      <ActivityIcon><AgentActivityIcon /></ActivityIcon><span className="thread-activity-item__summary">{props.label}</span>
    </button>} /> : <></>;
}
