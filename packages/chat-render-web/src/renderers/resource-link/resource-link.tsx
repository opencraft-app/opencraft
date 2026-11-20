import { DocumentIcon } from "@opencraft/design-system-web/action-icons";
import { parseConversationRef } from "@opencraft/appserver-protocol/collaboration";
import { chatFileCitationPresentation, chatWebLinkLabel, chatReferenceTarget, type ChatNodeRendererProps, type ChatResourcePolicyService } from "@opencraft/chat-render-react";
import type { ChatResourceDecision } from "@opencraft/chat-render-react";
import { createContext, useContext, lazy, Suspense, type CSSProperties, type MouseEvent, type ReactNode } from "react";

import { ProseRenderer } from "../prose/prose-renderer";
import {
  externalLinkPointerIntent,
} from "./external-link-model";
import "./resource-link.scss";

const ExternalUrlPresentation = lazy(() => import("./external-url-link").then(module => ({ default: module.ExternalUrlLink })));
export function ExternalUrlLink(props: {
  readonly context: ChatNodeRendererProps["context"];
  readonly decision: ChatResourceDecision;
  readonly label: ReturnType<ChatNodeRendererProps["renderNodes"]>;
  readonly title: string | null;
}) {
  const { context, decision, label, title } = props;
  const target = decision.allowed && !context.streaming ? decision.target : null;
  const activate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!target || context.openResource) event.preventDefault();
    const intent = externalLinkPointerIntent(event);
    if (target && intent) context.openResource?.(target, decision, intent);
  };
  return <Suspense fallback={<a className="chat-external-link" href={target ?? undefined}
    aria-disabled={!target || undefined} rel="noopener noreferrer" target="_blank"
    onClick={activate} onAuxClick={event => { if (event.button === 1) activate(event); }} title={target ?? undefined}>
    {target && title ? chatWebLinkLabel(target, title) : label}
  </a>}><ExternalUrlPresentation {...props} /></Suspense>;
}

// An inline code label inside an explicit Markdown link belongs to that link.
const ResourceLinkLabel = createContext(false);
const explicitDocumentPath = /^(?:\/(?!\/)|\.\.?\/|[a-z]:[\\/]|file:\/\/\/)[^\r\n`<>|;]*\.(?:md|markdown|html|htm)$/iu;

export function mediaFilePath(value: string): string | null {
  const source = value.trim();
  if (!source.startsWith("MEDIA:")) return null;
  let path = source.slice("MEDIA:".length).trim();
  const quote = path[0];
  const quoted = quote !== undefined && ["`", "'", '"'].includes(quote) && path.at(-1) === quote;
  if (quoted) path = path.slice(1, -1);
  if (path.length === 0 || /[\r\n\x00`<>|;"']/u.test(path) || path.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(path) && !/^(?:https?:\/\/|file:\/\/\/|[a-z]:[\\/])/iu.test(path)) return null;
  if (/^https?:/iu.test(path)) {
    try { new URL(path); } catch { return null; }
    if (/\s/u.test(path)) return null;
  }
  // Unquoted prose after a path is not a delivery directive. Quoted paths
  // may contain spaces; old explicit Markdown filenames keep that support.
  if (!quoted && /\s/u.test(path) && !/\.[a-z0-9]{1,16}$/iu.test(path)) return null;
  return path;
}

function externalMediaLink(path: string, target: string, decision: ChatResourceDecision, context: ChatNodeRendererProps["context"], content: ReactNode) {
  return <a href={target} title={path} data-chat-resource-kind="external"
    onClick={event => { event.preventDefault(); context.openResource?.(target, decision); }}>
    {content}
  </a>;
}

function localMediaLink(target: string, decision: ChatResourceDecision, context: ChatNodeRendererProps["context"]) {
  return <FileResourceLink target={target} kind={decision.kind ?? "file"}
    onClick={event => { event.preventDefault(); context.openResource?.(target, decision); }} />;
}

export function createMediaFileRenderer(resources: ChatResourcePolicyService) {
  return function MediaFileRenderer(props: ChatNodeRendererProps) {
    const { node, context } = props;
    const insideLink = useContext(ResourceLinkLabel);
    if (node.kind !== "text") return null;
    const path = mediaFilePath(node.text);
    if (insideLink || context.streaming || context.openResource === undefined || path === null) {
      return <ProseRenderer {...props} />;
    }
    const decision = resources.resolve(path, context);
    if (!decision.allowed || decision.target === null
      || (decision.kind !== "file" && decision.kind !== "workspace-file" && decision.kind !== "external")) return <ProseRenderer {...props} />;
    if (decision.kind !== "external") return localMediaLink(decision.target, decision, context);
    return externalMediaLink(path, decision.target, decision, context, <code className="chat-inline-code">{path}</code>);
  };
}

export function createInlineMarkdownFileRenderer(resources: ChatResourcePolicyService) {
  return function InlineMarkdownFileRenderer({ node, context }: ChatNodeRendererProps) {
    const insideLink = useContext(ResourceLinkLabel);
    if (node.kind !== "inline-code") return null;
    const code = <code className="chat-inline-code">{node.code}</code>;
    const path = explicitDocumentPath.test(node.code) ? node.code : mediaFilePath(node.code);
    // Ordinary code retains its explicit document path rule; MEDIA is the
    // type-independent delivery directive. The resource policy owns admission.
    if (insideLink || context.streaming || context.openResource === undefined
      || path === null) return code;
    const decision = resources.resolve(path, context);
    if (!decision.allowed || decision.target === null
      || (decision.kind !== "file" && decision.kind !== "workspace-file" && decision.kind !== "external")) return code;
    if (decision.kind !== "external") return localMediaLink(decision.target, decision, context);
    return externalMediaLink(path, decision.target, decision, context, code);
  };
}

function FileGlyph() {
  return <DocumentIcon size={16} aria-hidden="true" className="chat-file-citation__icon" />;
}

const FileResourceChip = lazy(() => import("./resource-chip").then(module => ({ default: module.FileResourceChip })));
function FileResourceLink(props: {
  readonly target: string; readonly label?: string; readonly kind: string;
  readonly onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return <Suspense fallback={<a className="chat-file-citation" href={props.target} title={props.target}
    onClick={props.onClick} aria-busy="true"><FileGlyph />{props.label ?? props.target.split(/[\\/]/u).at(-1)}</a>}>
    <FileResourceChip {...props} />
  </Suspense>;
}

export function createFileCitationRenderer(resources: ChatResourcePolicyService) {
  return function FileCitationRenderer({ node, context }: ChatNodeRendererProps) {
    if (node.kind !== "directive" || node.name !== "file-citation") return null;
    const presentation = chatFileCitationPresentation(node);
    if (presentation === null) return <>{node.raw}</>;
    const decision = resources.resolve(presentation.target, context);
    const { label } = presentation;
    if (!decision.allowed || decision.target === null) {
      return <span className="chat-file-citation" title={node.attributes.path}><FileGlyph />{label}</span>;
    }
    return (
      <FileResourceLink target={decision.target} kind={decision.kind ?? "workspace-file"}
        onClick={(event) => {
          if (context.openResource !== undefined) event.preventDefault();
          context.openResource?.(decision.target!, decision);
        }} />
    );
  };
}

function linkLabelText(nodes: Extract<ChatNodeRendererProps["node"], { kind: "link" }>["children"]): string {
  return nodes.map(child => child.kind === "text" ? child.text : child.kind === "inline-code" ? child.code
    : "children" in child ? linkLabelText(child.children) : "").join("");
}

export function createLinkRenderer(resources: ChatResourcePolicyService) {
  return function LinkRenderer({ node, context, renderNodes }: ChatNodeRendererProps) {
    if (node.kind !== "link") return null;
    const decision = resources.resolve(node.href, context);
    const conversation = context.dialect === "user-message" && parseConversationRef(node.href) !== null;
    // Old native history retains the model-facing label. Project it at the
    // resource boundary without rewriting history or code examples.
    const mentionLabel = conversation ? "@" + linkLabelText(node.children).replace(/^(?:Referenced conversation: |@)/u, "") : null;
    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      if (!decision.allowed || decision.target === null || context.openResource !== undefined) {
        event.preventDefault();
      }
      if (decision.allowed && decision.target !== null) context.openResource?.(decision.target, decision);
    };
    const external = !conversation && (decision.kind === "external" || decision.kind === "mail");
    if (decision.kind === "external" && /^https?:/iu.test(decision.target ?? node.href)) {
      return (
        <ExternalUrlLink
          context={context}
          decision={decision}
          label={<ResourceLinkLabel.Provider value>{renderNodes(node.children)}</ResourceLinkLabel.Provider>}
          title={node.children.map((child) => child.kind === "text" ? child.text : "").join("") || null}
        />
      );
    }
    if (decision.allowed && decision.target !== null && (decision.kind === "file" || decision.kind === "workspace-file" || decision.kind === "resource")) {
      return <FileResourceLink target={decision.target} kind={decision.kind}
        label={linkLabelText(node.children)} onClick={handleClick} />;
    }
    if (decision.allowed && decision.target !== null && decision.kind === "app-route") {
      return <FileResourceLink target={decision.target} kind={decision.kind}
        label={mentionLabel ?? linkLabelText(node.children)} onClick={handleClick} />;
    }
    return (
      <a
        aria-disabled={!decision.allowed || undefined}
        className={conversation ? "chat-conversation-mention" : undefined}
        data-chat-resource-kind={decision.kind ?? "resource"}
        data-markdown-raw-link-label={node.children.map((child) => child.kind === "text" ? child.text : "").join("")}
        href={decision.target ?? undefined}
        onClick={handleClick}
        rel={external ? "noopener noreferrer" : undefined}
        target={external ? "_blank" : undefined}
        title={node.title ?? decision.reason ?? node.href}
      ><ResourceLinkLabel.Provider value>{mentionLabel ?? renderNodes(node.children)}</ResourceLinkLabel.Provider></a>
    );
  };
}

export function createReferenceRenderer(resources: ChatResourcePolicyService) {
  return function ReferenceRenderer({ node, context }: ChatNodeRendererProps) {
    if (node.kind !== "reference") return null;
    const referenceTarget = chatReferenceTarget(node);
    const decision = referenceTarget === null ? null : resources.resolve(referenceTarget, context);
    const contents = node.segments.map((segment, index) => (
      <span
        className={segment.entering && !context.fadeTimeline?.isSettled(segment.key, performance.now()) ? "chat-stream-fade-in" : undefined}
        key={segment.key}
        onAnimationEnd={(event) => {
          if (event.target !== event.currentTarget) return;
          context.fadeTimeline?.settle(segment.key);
          context.requestMeasurement?.({
            geometryChanged: false,
            reason: "stream-animation",
          });
        }}
        ref={segment.entering && context.fadeTimeline !== undefined ? (element) => {
          if (element === null) return;
          element.style.setProperty("--fade-delay", `${context.fadeTimeline?.delayFor(segment.key, performance.now()) ?? 0}ms`);
        } : undefined}
        style={segment.entering ? { "--fade-delay": `${context.fadeTimeline?.cachedDelayFor(segment.key, performance.now()) ?? Math.min(index * 16, 96)}ms` } as CSSProperties : undefined}
      >{segment.text}</span>
    ));
    if (decision === null || !decision.allowed || decision.target === null) {
      return <span className="chat-inline-code" data-markdown-copy="inline-code" dir="ltr">{contents}</span>;
    }
    if (decision.kind === "file" || decision.kind === "workspace-file") {
      return <FileResourceLink target={decision.target} kind={decision.kind} onClick={event => {
        if (context.openResource !== undefined) event.preventDefault();
        context.openResource?.(decision.target!, decision);
      }} />;
    }
    return (
      <a
        className="chat-inline-code"
        data-chat-resource-kind={decision.kind ?? "workspace-file"}
        data-markdown-copy="inline-code"
        dir="ltr"
        href={decision.target}
        onClick={(event) => {
          if (context.openResource !== undefined) event.preventDefault();
          context.openResource?.(decision.target!, decision);
        }}
      >{contents}</a>
    );
  };
}
