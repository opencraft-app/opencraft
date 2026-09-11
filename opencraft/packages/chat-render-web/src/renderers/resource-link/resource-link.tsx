import type { ChatNodeRendererProps, ChatResourcePolicyService } from "@opencraft/chat-render-react";
import type { CSSProperties, MouseEvent } from "react";

import "./resource-link.scss";

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
