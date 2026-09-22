import type { ChatNodeRendererProps, ChatResourcePolicyService } from "@opencraft/chat-render-react";
import type { ChatResourceDecision, ChatResourceOpenIntent } from "@opencraft/chat-render-react";
import { FormattedMessage } from "@opencraft/i18n/react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Copy, ExternalLink, Globe2 } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from "react";

import { writeTextToClipboard } from "../../clipboard";
import {
  externalLinkMenuIntent,
  externalLinkPointerIntent,
  faviconSources,
  SAFE_URL_SETTLE_MS,
} from "./external-link-model";
import "./resource-link.scss";

function useSettledUrl(target: string | null, streaming: boolean): string | null {
  const [settled, setSettled] = useState<string | null>(() => streaming ? null : target);
  useEffect(() => {
    if (!streaming) {
      setSettled(target);
      return;
    }
    const timer = window.setTimeout(() => setSettled(target), SAFE_URL_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [streaming, target]);
  return streaming ? settled === target ? target : null : target;
}

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
  const target = useSettledUrl(decision.allowed ? decision.target : null, context.streaming);
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

function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path;
}

function FileGlyph() {
  return <svg aria-hidden="true" className="chat-file-citation__icon" viewBox="0 0 16 16"><path d="M3.5 1.75h5l4 4v8.5h-9z" /><path d="M8.5 1.75v4h4" /></svg>;
}

export function createFileCitationRenderer(resources: ChatResourcePolicyService) {
  return function FileCitationRenderer({ node, context }: ChatNodeRendererProps) {
    if (node.kind !== "directive" || node.name !== "codex-file-citation") return null;
    const path = node.attributes.path?.trim() ?? "";
    if (path.length === 0) return <>{node.raw}</>;
    const start = node.attributes.line_range_start ?? node.attributes.lineRangeStart;
    const end = node.attributes.line_range_end ?? node.attributes.lineRangeEnd;
    const location = start === undefined ? "" : end === undefined ? `L${start}` : `L${start}–${end}`;
    const target = `${path}${start === undefined ? "" : `:${start}${end === undefined ? "" : `-${end}`}`}`;
    const decision = resources.resolve(target, context);
    const label = `${basename(path)}${location.length === 0 ? "" : ` (${location})`}`;
    if (!decision.allowed || decision.target === null) {
      return <span className="chat-file-citation" title={path}><FileGlyph />{label}</span>;
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
        title={path}
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
          label={renderNodes(node.children)}
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
      >{renderNodes(node.children)}</a>
    );
  };
}

export function createReferenceRenderer(resources: ChatResourcePolicyService) {
  return function ReferenceRenderer({ node, context }: ChatNodeRendererProps) {
    if (node.kind !== "reference") return null;
    const isFile = node.referenceKind === "workspace-file";
    const decision = isFile ? resources.resolve(node.text.slice(1), context) : null;
    const contents = node.segments.map((segment, index) => (
      <span
        className={segment.entering && !context.fadeTimeline?.isSettled(segment.key) ? "chat-stream-fade-in" : undefined}
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
        style={segment.entering ? { "--fade-delay": `${context.fadeTimeline?.cachedDelayFor(segment.key) ?? index * 16}ms` } as CSSProperties : undefined}
      >{segment.text}</span>
    ));
    if (!isFile || decision === null || !decision.allowed || decision.target === null) {
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
