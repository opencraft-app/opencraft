import {
  codexAppThreadNavigationTarget,
  createdThreadToolResult,
  deriveSubagentActivityGroupPresentation,
  deriveSubagentActivityPresentation,
  extractToolCallContentParts,
  formatThreadHandoffStepLabel,
  isCodexAppThreadTool,
  subagentInlineStatusLabel,
  threadHandoffToolResult,
  visibleThreadHandoffSteps,
  type SubagentActivityRenderUnit,
  type TimelineBlock,
  type ToolActivityPresentation,
  type ToolCallContentPart,
  type WebMcpToolSurfaceCall,
} from "@opencraft/chat-core";
import {
  LazyHighlightedCodeSurface,
  resolveStandardChatResource,
} from "@opencraft/chat-render-web";
import {
  Bot,
  Check,
  ChevronRight,
  Circle,
  Code2,
  Globe2,
  ImageIcon,
  LoaderCircle,
  MessageSquare,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";

import {
  browserReadableImageSource,
  ConversationDocumentContext,
} from "../../conversation/document-context";
import { activityIcon } from "../activity/activity-icon";
import {
  AutomaticApprovalReviewIcon,
  AutomaticApprovalReviewList,
} from "../activity/command-and-review-renderers";
import {
  ActivityDisclosure,
  CadencedShimmer,
  useCodexActivityOpen,
} from "../activity/activity-disclosure";
import {
  SubagentNavigationContext,
  ToolCallContentRendererContext,
  ToolCallIconRendererContext,
  useToolActivityPresentation,
} from "../render-contexts";

function JsonPreview({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return <pre>{text}</pre>;
}

function ToolJsonPreview({ documentId, showActions = false, title, value }: {
  readonly documentId: string;
  readonly showActions?: boolean;
  readonly title?: string;
  readonly value: unknown;
}) {
  const documentContext = useContext(ConversationDocumentContext);
  return (
    <LazyHighlightedCodeSurface
      code={serializeToolValue(value)}
      documentId={documentId}
      language="json"
      showActions={showActions}
      theme={documentContext.theme}
      title={title}
    />
  );
}

function parseWebMcpJson(value: string | null, truncated: boolean): unknown {
  if (value === null || truncated) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function sentenceCaseToolName(value: string): string {
  const normalized = value.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[_-]+/gu, " ").trim();
  return normalized.length === 0 ? value : normalized.charAt(0).toLocaleUpperCase() + normalized.slice(1);
}

function WebMcpToolActivity({ call, parentId }: {
  readonly call: WebMcpToolSurfaceCall;
  readonly parentId: string;
}) {
  const [open, setOpen] = useCodexActivityOpen(false);
  const summary = call.kind === "listTools" ? "Listed website tools" : call.title ?? sentenceCaseToolName(call.name);
  const input = call.kind === "invokeTool" ? parseWebMcpJson(call.inputJson, call.inputTruncated) : null;
  const tool = {
    name: call.name,
    ...(call.title === null ? {} : { title: call.title }),
    ...(call.description === null ? {} : { description: call.description }),
    ...(call.sourceHostname === null ? {} : { website: call.sourceHostname }),
    ...(call.readOnlyHint === null ? {} : { readOnlyHint: call.readOnlyHint }),
    ...(input === null ? {} : { input }),
    ...(call.inputTruncated ? { inputTruncated: true } : {}),
  };
  const output = parseWebMcpJson(call.outputJson, call.outputTruncated);
  return (
    <ActivityDisclosure
      detail={null}
      icon={<Globe2 size={14} />}
      onOpenChange={setOpen}
      open={open}
      running={false}
      status="completed"
      summary={summary}
    >
      <div className="thread-webmcp-details">
        <ToolJsonPreview
          documentId={`webmcp:${parentId}:${call.name}:tool`}
          title={call.inputTruncated ? "Tool (input truncated)" : "Tool"}
          value={tool}
        />
        {output === null ? null : (
          <ToolJsonPreview
            documentId={`webmcp:${parentId}:${call.name}:result`}
            title={call.outputTruncated ? "Result (truncated)" : "Result"}
            value={output}
          />
        )}
      </div>
    </ActivityDisclosure>
  );
}

function toolContentRoleLabel(role: ToolCallContentPart["role"]): string {
  return role === "input" ? "Input" : role === "output" ? "Output" : "Error";
}

function formatToolContentAnnotations(part: ToolCallContentPart): string | null {
  if (part.annotations === undefined) return null;
  const values: string[] = [];
  if (part.annotations.audience.length > 0) values.push(`audience=${part.annotations.audience.join(", ")}`);
  if (part.annotations.priority !== null) values.push(`priority=${String(part.annotations.priority)}`);
  if (part.annotations.lastModified !== null) values.push(`lastModified=${part.annotations.lastModified}`);
  return values.length === 0 ? null : `Annotations: ${values.join("; ")}`;
}

function ToolCallContentPartView({ contentId, part }: { contentId: string; part: ToolCallContentPart }) {
  const annotations = formatToolContentAnnotations(part);
  if (part.kind === "text") {
    if (part.role === "error") return <div className="thread-tool-details__error"><pre>{part.text}</pre></div>;
    return (
      <div className="thread-tool-details__plaintext">
        <header>plaintext</header>
        <pre>{annotations === null ? part.text : `${part.text}\n${annotations}`}</pre>
      </div>
    );
  }
  if (part.kind === "json") return <ToolJsonPreview documentId={contentId} value={part.value} />;
  if (part.kind === "unknown") return <pre className="thread-tool-details__unknown">{serializeToolValue(part.value)}</pre>;
  if (part.kind === "image") {
    return <div><img alt={part.alt ?? "Image returned by tool"} className="thread-tool-details__image" loading="lazy" src={part.source} />{annotations ? <p className="thread-tool-details__annotations">{annotations}</p> : null}</div>;
  }
  if (part.kind === "audio") {
    return <div><audio className="thread-tool-details__audio" controls preload="metadata" src={part.source} />{annotations ? <p className="thread-tool-details__annotations">{annotations}</p> : null}</div>;
  }
  if (part.kind === "embedded-resource") {
    return (
      <div className="thread-tool-details__embedded-resource">
        <div><b>URI</b><span>{part.uri}</span></div>
        {part.mimeType ? <div><b>MIME type</b><span>{part.mimeType}</span></div> : null}
        {annotations ? <div><b>Annotations</b><span>{annotations.replace(/^Annotations:\s*/u, "")}</span></div> : null}
        {part.content ? <div className="thread-tool-details__embedded-content"><b>Content</b><pre>{part.content}</pre></div> : null}
      </div>
    );
  }
  return (
    <div className="thread-tool-details__resource-link">
      <div>Read {part.name}</div>
      {annotations ? <p className="thread-tool-details__annotations">{annotations}</p> : null}
    </div>
  );
}

function serializeToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function rawToolCallValue(block: Extract<TimelineBlock, { type: "tool-call" }>) {
  const output = typeof block.output === "object" && block.output !== null && !Array.isArray(block.output)
    ? block.output as Readonly<Record<string, unknown>>
    : null;
  const result = block.kind === "mcp"
    ? block.errorMessage !== null
      ? { type: "error", kind: "protocol", error: block.errorMessage, rawError: { message: block.errorMessage }, raw: block.output ?? undefined }
      : block.output === null
        ? null
        : {
            type: "success",
            content: Array.isArray(output?.content) ? output.content : [],
            structuredContent: output?.structuredContent ?? null,
            raw: block.output,
          }
    : { success: block.status === "complete", contentItems: block.output };
  return {
    callId: block.callId,
    invocation: {
      server: block.server ?? block.namespace,
      tool: block.name,
      arguments: block.input,
    },
    durationMs: block.durationMs,
    result,
  };
}

function RawToolCallDialog({ block, onClose }: {
  readonly block: Extract<TimelineBlock, { type: "tool-call" }>;
  readonly onClose: () => void;
}) {
  const title = `Raw ${block.server ?? block.namespace ?? "tool"}.${block.name} tool call output`;
  const rawValue = rawToolCallValue(block);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return createPortal(
    <div className="thread-tool-raw-dialog__backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section aria-label={title} aria-modal="true" className="thread-tool-raw-dialog" role="dialog">
        <header>
          <strong>{title}</strong>
          <div>
            <button aria-label="Close" className="thread-tool-raw-dialog__close" onClick={onClose} type="button"><X size={14} /></button>
          </div>
        </header>
        <div className="thread-tool-raw-dialog__body">
          <ToolJsonPreview documentId={`tool-raw:${block.id}`} showActions value={rawValue} />
        </div>
      </section>
    </div>,
    document.body,
  );
}

function ToolCallContent({ block, parts }: {
  readonly block: Extract<TimelineBlock, { type: "tool-call" }>;
  readonly parts: readonly ToolCallContentPart[];
}) {
  const [rawOpen, setRawOpen] = useState(false);
  return (
    <div className="thread-tool-details" data-kind={block.kind}>
      {parts.map((part, index) => (
        <section data-role={part.role} key={`${part.role}:${part.kind}:${index}`}>
          {block.kind !== "mcp" && (index === 0 || parts[index - 1]?.role !== part.role) ? <span>{toolContentRoleLabel(part.role)}</span> : null}
          <ToolCallContentPartView contentId={`tool-result:${block.id}:${part.role}:${index}`} part={part} />
        </section>
      ))}
      {parts.length === 0 ? <p className="thread-tool-details__empty">Tool returned no content</p> : null}
      <button aria-label="Show raw tool call output" className="thread-tool-details__raw" onClick={() => setRawOpen(true)} title="Show raw tool call output" type="button"><Code2 size={12} /></button>
      {rawOpen ? <RawToolCallDialog block={block} onClose={() => setRawOpen(false)} /> : null}
    </div>
  );
}

function ToolCallBlock({ block }: { block: Extract<TimelineBlock, { type: "tool-call" }> }) {
  const presentation = useToolActivityPresentation(block);
  const renderContent = useContext(ToolCallContentRendererContext);
  const renderIcon = useContext(ToolCallIconRendererContext);
  const contentParts = extractToolCallContentParts(block);
  const displayParts = block.kind === "mcp"
    ? contentParts.filter((part) => part.role !== "input")
    : contentParts;
  const customContent = renderContent?.(block, presentation);
  const hasCustomContent = customContent !== undefined;
  const hasCustomBody = hasCustomContent && customContent !== null && customContent !== false;
  // Codex's MCP surface owns a persistent, initially-collapsed disclosure.
  // The live-auto-open state machine belongs to generic Activity rows, not MCP.
  const [mcpOpen, setMcpOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useCodexActivityOpen(presentation.state === "running");
  const open = block.kind === "mcp" ? mcpOpen : activityOpen;
  const setOpen = block.kind === "mcp" ? setMcpOpen : setActivityOpen;
  const createdThread = createdThreadToolResult(block);
  const hostIcon = renderIcon?.(block, presentation);
  const icon = hostIcon === undefined ? activityIcon(presentation.icon) : hostIcon;
  if (createdThread !== null && !hasCustomContent) {
    return <CreatedThreadToolCard result={createdThread} />;
  }
  if (isCodexAppThreadTool(block) && !hasCustomContent) {
    return <CodexAppThreadToolRow block={block} presentation={presentation} />;
  }
  return (
    <>
      <ActivityDisclosure
      accessory={block.automaticApprovalReviews.length > 0 ? <AutomaticApprovalReviewIcon /> : null}
      bodyVariant={block.kind === "mcp" ? "grouped" : "default"}
      detail={presentation.detail}
      icon={icon}
      onOpenChange={setOpen}
      open={open}
      running={presentation.state === "running"}
      status={presentation.state}
      summary={presentation.summary}
      unmountBodyWhenCollapsed={block.kind === "mcp"}
    >
      {presentation.canExpand || hasCustomBody || block.automaticApprovalReviews.length > 0 ? (
        <>
          {hasCustomContent ? customContent : presentation.canExpand ? <ToolCallContent block={block} parts={displayParts} /> : null}
          <AutomaticApprovalReviewList reviews={block.automaticApprovalReviews} />
        </>
      ) : null}
      </ActivityDisclosure>
      {block.webMcpCalls?.map((call, index) => (
        <WebMcpToolActivity call={call} key={`${call.kind}:${call.name}:${index}`} parentId={block.id} />
      ))}
    </>
  );
}

/** Source-faithful standalone ImageView activity with one disclosure per contiguous run. */
function ImageViewToolBlock({ block }: { readonly block: Extract<TimelineBlock, { type: "tool-call" }> }) {
  const documentContext = useContext(ConversationDocumentContext);
  const presentation = useToolActivityPresentation(block);
  const paths = block.imagePaths ?? [];
  const [open, setOpen] = useState(false);
  return (
    <ActivityDisclosure
      bodyVariant="unindented"
      icon={<ImageIcon aria-hidden="true" size={14} />}
      onOpenChange={setOpen}
      open={open}
      running={false}
      status={presentation.state}
      summary={presentation.summary}
      unmountBodyWhenCollapsed
    >
      {paths.length === 0 ? null : (
        <div className="thread-image-view" role="list">
          <div className="thread-image-view__strip">
            {paths.map((path, index) => {
              const source = browserReadableImageSource(path, documentContext.resolveImageSource);
              const openImage = () => {
                const decision = resolveStandardChatResource(path, {
                  cwd: documentContext.cwd,
                  externalResourcePolicy: "allow",
                });
                if (decision.allowed && decision.target !== null) {
                  documentContext.onOpenResource?.(decision.target, decision);
                }
              };
              return (
                <button
                  aria-label={`Open inspected image ${index + 1}`}
                  className="thread-image-view__preview"
                  key={`${path}:${index}`}
                  onClick={openImage}
                  role="listitem"
                  title={path}
                  type="button"
                >
                  {source === null
                    ? <span className="thread-image-view__fallback"><ImageIcon aria-hidden="true" size={24} /></span>
                    : <img alt="Inspected image" loading="lazy" src={source} />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </ActivityDisclosure>
  );
}

function GeneratedImageBlock({ block }: { readonly block: Extract<TimelineBlock, { type: "image" }> }) {
  const documentContext = useContext(ConversationDocumentContext);
  const [previewOpen, setPreviewOpen] = useState(false);
  const running = block.status === "pending" || block.status === "running";
  const source = documentContext.resolveGeneratedImageSource?.(block) ?? block.uri;

  useEffect(() => {
    if (!previewOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setPreviewOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewOpen]);

  if (source === null) {
    // Codex suppresses terminal failure/interruption items with no image. Only
    // the in-progress item owns a gallery placeholder.
    if (!running) return null;
    return (
      <div
        aria-label="Generating image"
        aria-valuetext="Generating image"
        className="thread-generated-image-gallery thread-generated-image-gallery--pending"
        data-testid="generated-image-gallery"
        role="progressbar"
      >
        <div className="thread-generated-image-placeholder" />
      </div>
    );
  }

  const openPreview = () => {
    if (documentContext.onOpenGeneratedImage !== undefined) {
      documentContext.onOpenGeneratedImage(block);
      return;
    }
    setPreviewOpen(true);
  };
  const alt = "Generated image 1";
  const lightbox = previewOpen ? createPortal(
    <div
      className="thread-generated-image-lightbox"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) setPreviewOpen(false);
      }}
      role="presentation"
    >
      <div aria-label={alt} aria-modal="true" className="thread-generated-image-lightbox__dialog" role="dialog">
        <div className="thread-generated-image-lightbox__toolbar">
          {documentContext.onEditGeneratedImage === undefined ? null : (
            <button onClick={() => documentContext.onEditGeneratedImage?.(block)} type="button">Edit</button>
          )}
          <a download={block.savedPath?.split(/[\\/]/u).at(-1) ?? "generated-image-1.png"} href={source}>Save</a>
          <button aria-label="Close image preview" onClick={() => setPreviewOpen(false)} type="button"><X size={18} /></button>
        </div>
        <img alt={alt} draggable={false} src={source} />
      </div>
    </div>,
    document.body,
  ) : null;
  return (
    <>
      <div className="thread-generated-image-gallery" data-testid="generated-image-gallery">
        <div className="thread-generated-image-preview-wrap">
          <button
            aria-label={alt}
            className="thread-generated-image-preview"
            data-testid="generated-image-preview"
            onClick={openPreview}
            type="button"
          >
            <img alt={alt} draggable="true" src={source} />
          </button>
          {documentContext.onEditGeneratedImage === undefined ? null : (
            <button
              aria-label="Edit generated image 1"
              className="thread-generated-image-edit"
              onClick={() => documentContext.onEditGeneratedImage?.(block)}
              type="button"
            >Edit</button>
          )}
        </div>
      </div>
      {lightbox}
    </>
  );
}

function CodexAppThreadToolRow({ block, presentation }: {
  readonly block: Extract<TimelineBlock, { type: "tool-call" }>;
  readonly presentation: ToolActivityPresentation;
}) {
  const navigation = useContext(SubagentNavigationContext);
  const target = codexAppThreadNavigationTarget(block);
  const canOpen = target !== null && navigation.open !== null;
  const handoff = threadHandoffToolResult(block);
  const handoffSteps = useMemo(() => handoff === null ? [] : visibleThreadHandoffSteps(handoff), [handoff]);
  const [handoffOpen, setHandoffOpen] = useCodexActivityOpen(presentation.state === "running");
  if (handoff !== null && handoffSteps.length > 0) {
    return (
      <ActivityDisclosure
        bodyVariant="unindented"
        icon={<Bot size={14} />}
        onOpenChange={setHandoffOpen}
        open={handoffOpen}
        running={presentation.state === "running"}
        status={presentation.state}
        summary={presentation.summary}
      >
        <div className="thread-handoff-steps">
          {handoffSteps.map((step) => <ThreadHandoffStepRow handoff={handoff} key={step.id} step={step} />)}
        </div>
      </ActivityDisclosure>
    );
  }
  const content = (
    <>
      <span className="thread-activity-item__icon"><Bot size={14} /></span>
      <CadencedShimmer active={presentation.state === "running"} className="thread-activity-item__summary">{presentation.summary}</CadencedShimmer>
    </>
  );
  return canOpen ? (
    <button
      aria-label={`Open ${target.displayName.toLocaleLowerCase()}`}
      className="thread-codex-app-tool-row is-interactive"
      data-status={presentation.state}
      onClick={() => navigation.open?.(target.threadId, target.displayName)}
      type="button"
    >
      {content}
    </button>
  ) : (
    <div className="thread-codex-app-tool-row" data-status={presentation.state}>{content}</div>
  );
}

function ThreadHandoffStepRow({ handoff, step }: {
  readonly handoff: NonNullable<ReturnType<typeof threadHandoffToolResult>>;
  readonly step: ReturnType<typeof visibleThreadHandoffSteps>[number];
}) {
  const label = formatThreadHandoffStepLabel(step.id, handoff);
  const statusLabel = step.status === "running" ? "In progress"
    : step.status === "done" ? "Completed"
    : step.status === "failed" ? "Failed"
    : "Pending";
  return (
    <div className="thread-handoff-step" data-status={step.status}>
      <span aria-label={`${statusLabel}:`} className="thread-handoff-step__icon">
        {step.status === "running" ? <LoaderCircle size={13} />
          : step.status === "done" ? <Check size={13} />
          : step.status === "failed" ? <X size={13} />
          : <Circle size={9} />}
      </span>
      <span>{label}</span>
    </div>
  );
}

function CreatedThreadToolCard({ result }: {
  readonly result: NonNullable<ReturnType<typeof createdThreadToolResult>>;
}) {
  const navigation = useContext(SubagentNavigationContext);
  const canOpen = navigation.open !== null;
  return (
    <button
      aria-label="Open chat"
      className="thread-created-thread-card"
      disabled={!canOpen}
      onClick={() => navigation.open?.(result.threadId, result.title)}
      type="button"
    >
      <span className="thread-created-thread-card__icon"><MessageSquare size={14} /></span>
      <span className="thread-created-thread-card__copy">
        <strong>{result.title}</strong>
      </span>
      <span className="thread-created-thread-card__action">Open chat <ChevronRight size={13} /></span>
    </button>
  );
}

type DerivedSubagentAgent = ReturnType<typeof deriveSubagentActivityPresentation>["agents"][number];

function agentHue(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 360;
}

function SubagentAvatar({ agent }: { readonly agent: DerivedSubagentAgent }) {
  return (
    <span
      aria-hidden="true"
      className="thread-subagent-avatar"
      data-status={agent.status}
      style={{ "--agent-hue": String(agentHue(agent.threadId)) + "deg" } as CSSProperties}
    >
      {agent.displayName.slice(0, 1).toUpperCase()}
    </span>
  );
}

function SubagentChip({ agent }: { readonly agent: DerivedSubagentAgent }) {
  const navigation = useContext(SubagentNavigationContext);
  const canOpen = navigation.open !== null && agent.threadId.length > 0;
  return (
    <button
      aria-label={"Open " + agent.displayName + " subagent"}
      className="thread-subagent-chip"
      data-status={agent.status}
      disabled={!canOpen}
      onClick={() => navigation.open?.(agent.threadId, agent.displayName)}
      title={agent.model ?? undefined}
      type="button"
    >
      <SubagentAvatar agent={agent} />
      <span>{agent.displayName}</span>
      {agent.role ? <small>{agent.role}</small> : null}
    </button>
  );
}

function SubagentDetailRow({
  agent,
  block,
}: {
  readonly agent: DerivedSubagentAgent;
  readonly block: Extract<TimelineBlock, { type: "subagent" }>;
}) {
  const verb = deriveSubagentActivityPresentation(block).actionLabel;
  return (
    <div className="thread-subagent-details__row" data-status={agent.status}>
      <SubagentAvatar agent={agent} />
      <div>
        <p>
          <span>{verb} </span>
          <strong>{agent.displayName}</strong>
          {block.tool === "spawnAgent" && block.prompt ? <> with the instructions: <span>{block.prompt}</span></>
            : (block.tool === "sendInput" || block.tool === "resumeAgent") && block.prompt ? <>: <span>{block.prompt}</span></>
            : null}
          <small> · {agent.statusLabel}</small>
        </p>
        {agent.statusMessage ? <p className="thread-subagent-details__message">{agent.statusMessage}</p> : null}
      </div>
    </div>
  );
}

function SubagentBlock({ block }: { block: Extract<TimelineBlock, { type: "subagent" }> }) {
  const derived = useMemo(() => deriveSubagentActivityPresentation(block), [block]);
  const [open, setOpen] = useCodexActivityOpen(block.status === "running" || block.status === "pending");
  const [showAllAgents, setShowAllAgents] = useState(false);
  const navigation = useContext(SubagentNavigationContext);
  const visibleAgents = showAllAgents ? derived.agents : derived.agents.slice(0, 3);
  const hiddenCount = derived.agents.length - visibleAgents.length;
  if (block.activityKind !== null && block.tool === null && derived.agents.length === 1) {
    const agent = derived.agents[0]!;
    const canOpen = navigation.open !== null && agent.threadId.length > 0;
    return (
      <button
        aria-label={canOpen ? "Open " + agent.displayName + " subagent" : undefined}
        className="thread-subagent-inline"
        data-status={agent.displayStatus}
        disabled={!canOpen}
        onClick={() => navigation.open?.(agent.threadId, agent.displayName)}
        type="button"
      >
        <SubagentAvatar agent={agent} />
        <span>{subagentInlineStatusLabel(agent)}</span>
      </button>
    );
  }
  return (
    <section className="thread-subagent-activity" data-open={open || undefined} data-status={block.status}>
      <div className="thread-subagent-activity__header">
        <button
          aria-expanded={derived.expandable ? open : undefined}
          className="thread-subagent-activity__toggle"
          disabled={!derived.expandable}
          onClick={() => setOpen(!open)}
          type="button"
        >
          <Bot aria-hidden="true" size={14} />
          <span>{derived.actionLabel}</span>
        </button>
        <div className="thread-subagent-chips">
          {visibleAgents.map((agent) => <SubagentChip agent={agent} key={agent.threadId} />)}
          {hiddenCount > 0 ? (
            <button className="thread-subagent-chips__more" onClick={() => setShowAllAgents(true)} type="button">{hiddenCount} more</button>
          ) : null}
        </div>
        <span className="thread-subagent-activity__status">{derived.groupStatusLabel}</span>
        {derived.expandable ? <ChevronRight aria-hidden="true" className="thread-subagent-activity__chevron" size={13} /> : null}
      </div>
      <AnimatePresence initial={false}>
        {open && derived.expandable ? (
          <motion.div
            animate={{ height: "auto", opacity: 1 }}
            className="thread-subagent-details"
            exit={{ height: 0, opacity: 0 }}
            initial={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          >
            <div className="thread-subagent-details__inner">
              {derived.agents.map((agent) => <SubagentDetailRow agent={agent} block={block} key={agent.threadId} />)}
              {block.tool === "wait" && block.prompt ? <p className="thread-subagent-details__input">Input: {block.prompt}</p> : null}
              {block.reasoningEffort || block.agentPath ? (
                <p className="thread-subagent-details__meta">
                  {block.reasoningEffort ? "Reasoning: " + block.reasoningEffort : null}
                  {block.reasoningEffort && block.agentPath ? " · " : null}
                  {block.agentPath ?? null}
                </p>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

function SubagentActivityGroup({ unit }: { readonly unit: SubagentActivityRenderUnit }) {
  if (unit.blocks.length === 1) return <SubagentBlock block={unit.blocks[0]!} />;
  return <AggregatedSubagentActivity unit={unit} />;
}

function AggregatedSubagentActivity({ unit }: { readonly unit: SubagentActivityRenderUnit }) {
  const derived = useMemo(() => deriveSubagentActivityGroupPresentation(unit.blocks), [unit.blocks]);
  const running = unit.blocks.some((block) => block.status === "running" || block.status === "pending");
  const failed = unit.blocks.some((block) => block.status === "failed");
  const interrupted = unit.blocks.some((block) => block.status === "interrupted");
  const status = running ? "running" : failed ? "failed" : interrupted ? "interrupted" : "complete";
  const [open, setOpen] = useCodexActivityOpen(running);
  const [showAllAgents, setShowAllAgents] = useState(false);
  const visibleAgents = showAllAgents ? derived.agents : derived.agents.slice(0, 3);
  const hiddenCount = derived.agents.length - visibleAgents.length;
  const blockForAgent = useCallback((threadId: string) => {
    for (let index = unit.blocks.length - 1; index >= 0; index -= 1) {
      const block = unit.blocks[index]!;
      if (deriveSubagentActivityPresentation(block).agents.some((agent) => agent.threadId === threadId)) return block;
    }
    return unit.blocks.at(-1)!;
  }, [unit.blocks]);
  return (
    <section className="thread-subagent-activity" data-open={open || undefined} data-status={status}>
      <div className="thread-subagent-activity__header">
        <button
          aria-expanded={derived.expandable ? open : undefined}
          className="thread-subagent-activity__toggle"
          disabled={!derived.expandable}
          onClick={() => setOpen(!open)}
          type="button"
        >
          <Bot aria-hidden="true" size={14} />
          <span>{derived.actionLabel}</span>
        </button>
        <div className="thread-subagent-chips">
          {visibleAgents.map((agent) => <SubagentChip agent={agent} key={agent.threadId} />)}
          {hiddenCount > 0 ? (
            <button className="thread-subagent-chips__more" onClick={() => setShowAllAgents(true)} type="button">{hiddenCount} more</button>
          ) : null}
        </div>
        <span className="thread-subagent-activity__status">{derived.groupStatusLabel}</span>
        {derived.expandable ? <ChevronRight aria-hidden="true" className="thread-subagent-activity__chevron" size={13} /> : null}
      </div>
      <AnimatePresence initial={false}>
        {open && derived.expandable ? (
          <motion.div
            animate={{ height: "auto", opacity: 1 }}
            className="thread-subagent-details"
            exit={{ height: 0, opacity: 0 }}
            initial={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          >
            <div className="thread-subagent-details__inner">
              {derived.agents.map((agent) => (
                <SubagentDetailRow agent={agent} block={blockForAgent(agent.threadId)} key={agent.threadId} />
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}


export {
  GeneratedImageBlock,
  ImageViewToolBlock,
  JsonPreview,
  SubagentActivityGroup,
  SubagentBlock,
  ToolCallBlock,
};
