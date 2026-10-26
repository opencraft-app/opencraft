import { DocumentIcon } from "@opencraft/design-system-web/action-icons";
import { CopyIcon as Copy } from "@opencraft/design-system-web/action-icons";
import { chatFileCitationPresentation, chatReferenceTarget, useSettledResourceTarget, type ChatNodeRendererProps, type ChatResourcePolicyService } from "@opencraft/chat-render-react";
import type { ChatResourceDecision, ChatResourceOpenIntent } from "@opencraft/chat-render-react";
import { FormattedMessage } from "@opencraft/i18n/react";
import * as ContextMenu from "@opencraft/design-system-web/context-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import { ExternalLinkIcon as ExternalLink, GlobeIcon as Globe2 } from "@opencraft/design-system-web/action-icons";
import { createContext, useContext, useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from "react";

import { writeTextToClipboard } from "../../clipboard";
import { ProseRenderer } from "../prose/prose-renderer";
import {
  externalLinkMenuIntent,
  externalLinkPointerIntent,
  faviconSources,
} from "./external-link-model";
import "./resource-link.scss";

function ExternalLinkGlyph({ target }: { readonly target: string | null }) {
  const sources = useMemo(() => target === null ? [] : faviconSources(target), [target]);
  const [loaded, setLoaded] = useState<string | null>(null);
  useEffect(() => setLoaded(null), [target]);
  return (
    <span aria-hidden="true" className="chat-external-link__icon" data-markdown-copy="exclude">
      <span className="chat-external-link__icon-fallback"><Globe2 /></span>
      {sources.map((source) => (
        <img
          alt=""
          className={loaded === source ? "is-loaded" : undefined}
          decoding="async"
          key={source}
          onLoad={() => setLoaded((current) => current !== null && sources.includes(current) ? current : source)}
          referrerPolicy="no-referrer"
          src={source}
        />
      ))}
    </span>
  );
}

export function ExternalUrlLink({
  context,
  decision,
  label,
  title,
}: {
  readonly context: ChatNodeRendererProps["context"];
  readonly decision: ChatResourceDecision;
  readonly label: ReturnType<ChatNodeRendererProps["renderNodes"]>;
  readonly title: string | null;
}) {
  const target = useSettledResourceTarget(decision.allowed ? decision.target : null, context.streaming);
  const pending = decision.allowed && decision.target !== null && target === null;
  const invoke = (intent: ChatResourceOpenIntent) => {
    if (target === null) return;
    if (context.openResource !== undefined) context.openResource(target, decision, intent);
    else window.open(target, "_blank", "noopener,noreferrer");
  };
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (target === null || context.openResource !== undefined) event.preventDefault();
    if (target === null || context.openResource === undefined) return;
    const intent = externalLinkPointerIntent(event);
    if (intent !== null) invoke(intent);
  };
  const handleAuxClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 1) return;
    if (target === null || context.openResource !== undefined) event.preventDefault();
    const intent = externalLinkPointerIntent(event);
    if (target !== null && context.openResource !== undefined && intent !== null) invoke(intent);
  };
  const anchor = (
    <a
      aria-busy={pending || undefined}
      aria-disabled={target === null || undefined}
      className="chat-external-link"
      data-chat-resource-kind="external"
      data-markdown-raw-link-label={title ?? ""}
      href={target ?? undefined}
      onAuxClick={handleAuxClick}
      onClick={handleClick}
      rel="noopener noreferrer"
      target={context.openResource === undefined ? "_blank" : undefined}
    >
      <ExternalLinkGlyph target={target} />
      <span className="chat-external-link__label">{label}</span>
    </a>
  );
  return (
    <Tooltip.Provider delayDuration={450}>
      <ContextMenu.Root>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <ContextMenu.Trigger asChild>{anchor}</ContextMenu.Trigger>
          </Tooltip.Trigger>
          {target === null ? null : (
            <Tooltip.Portal>
              <Tooltip.Content className="chat-external-link-tooltip" sideOffset={5}>
                {target}<Tooltip.Arrow className="chat-external-link-tooltip__arrow" />
              </Tooltip.Content>
            </Tooltip.Portal>
          )}
        </Tooltip.Root>
        {target === null ? null : (
          <ContextMenu.Portal>
            <ContextMenu.Content className="chat-external-link-menu">
              <ContextMenu.Item onSelect={() => invoke(externalLinkMenuIntent("in-app-browser"))}>
                <Globe2 aria-hidden="true" /><FormattedMessage id="chat.link.openInBrowser" defaultMessage="Open in browser" />
              </ContextMenu.Item>
              <ContextMenu.Item onSelect={() => invoke(externalLinkMenuIntent("external-browser"))}>
                <ExternalLink aria-hidden="true" /><FormattedMessage id="chat.link.openExternal" defaultMessage="Open in external browser" />
              </ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item onSelect={() => void writeTextToClipboard(target)}>
                <Copy aria-hidden="true" /><FormattedMessage id="chat.link.copy" defaultMessage="Copy link" />
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        )}
      </ContextMenu.Root>
    </Tooltip.Provider>
  );
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
    return <a
      href={decision.target}
      title={path}
      data-chat-resource-kind={decision.kind}
      onClick={(event) => {
        event.preventDefault();
        context.openResource?.(decision.target!, decision);
      }}
    ><code className="chat-inline-code">{path}</code></a>;
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
    return <a
      href={decision.target}
      title={path}
      data-chat-resource-kind={decision.kind}
      onClick={(event) => {
        event.preventDefault();
        context.openResource?.(decision.target!, decision);
      }}
    >{code}</a>;
  };
}

function FileGlyph() {
  return <DocumentIcon size={16} className="chat-file-citation__icon" />;
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
      <a
        className="chat-file-citation"
        data-chat-resource-kind={decision.kind ?? "workspace-file"}
        href={decision.target}
        onClick={(event) => {
          if (context.openResource !== undefined) event.preventDefault();
          context.openResource?.(decision.target!, decision);
        }}
        title={node.attributes.path}
      ><FileGlyph />{label}</a>
    );
  };
}

export function createLinkRenderer(resources: ChatResourcePolicyService) {
  return function LinkRenderer({ node, context, renderNodes }: ChatNodeRendererProps) {
    if (node.kind !== "link") return null;
    const decision = resources.resolve(node.href, context);
    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      if (!decision.allowed || decision.target === null || context.openResource !== undefined) {
        event.preventDefault();
      }
      if (decision.allowed && decision.target !== null) context.openResource?.(decision.target, decision);
    };
    const external = decision.kind === "external" || decision.kind === "mail";
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
    return (
      <a
        aria-disabled={!decision.allowed || undefined}
        data-chat-resource-kind={decision.kind ?? "resource"}
        data-markdown-raw-link-label={node.children.map((child) => child.kind === "text" ? child.text : "").join("")}
        href={decision.target ?? undefined}
        onClick={handleClick}
        rel={external ? "noopener noreferrer" : undefined}
        target={external ? "_blank" : undefined}
        title={node.title ?? decision.reason ?? node.href}
      ><ResourceLinkLabel.Provider value>{renderNodes(node.children)}</ResourceLinkLabel.Provider></a>
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
