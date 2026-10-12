import type { ChatDocumentNode } from "@opencraft/chat-document";
import { containsHanText, type ChatNodeRendererProps } from "@opencraft/chat-render-react";
import { Fragment, type CSSProperties, type ReactNode } from "react";

import "./prose.scss";

type SegmentedTextNode = Extract<ChatDocumentNode, { kind: "text" | "color-swatch" }>;

function SegmentedText({ node, props }: { readonly node: SegmentedTextNode; readonly props: ChatNodeRendererProps }) {
  return <>{node.segments.map((segment, index) => (
    <span
      className={segment.entering && !props.context.fadeTimeline?.isSettled(segment.key, performance.now()) ? "chat-stream-fade-in" : undefined}
      data-chat-stream-enter={segment.entering || undefined}
      key={segment.key}
      ref={segment.entering && props.context.fadeTimeline !== undefined ? (element) => {
        if (element === null) return;
        const delayMs = props.context.fadeTimeline?.delayFor(segment.key, performance.now()) ?? 0;
        element.style.setProperty("--fade-delay", `${delayMs}ms`);
      } : undefined}
      style={segment.entering ? { "--fade-delay": `${props.context.fadeTimeline?.cachedDelayFor(segment.key, performance.now()) ?? Math.min(index * 16, 96)}ms` } as CSSProperties : undefined}
      onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget) return;
        props.context.fadeTimeline?.settle(segment.key);
        props.context.requestMeasurement?.({
          geometryChanged: false,
          reason: "stream-animation",
        });
      }}
    >{segment.text}</span>
  ))}</>;
}

function children(props: ChatNodeRendererProps): ReactNode {
  return "children" in props.node ? props.renderNodes(props.node.children) : null;
}

function paragraphMediaKind(nodes: readonly ChatDocumentNode[]): "grid" | "single" | null {
  const images = nodes.filter((node) => node.kind === "image");
  if (images.length === 0) return null;
  const mediaOnly = nodes.every((node) => (
    node.kind === "image"
    || node.kind === "line-break"
    || (node.kind === "text" && node.text.trim().length === 0)
  ));
  if (!mediaOnly) return null;
  return images.length > 1 ? "grid" : "single";
}

function TaskCheckbox({ checked }: { readonly checked: boolean }) {
  return (
    <span
      aria-checked={checked}
      aria-disabled="true"
      className="chat-task-checkbox"
      data-checked={checked || undefined}
      role="checkbox"
    >
      {checked ? (
        <svg aria-hidden="true" viewBox="0 0 12 12">
          <path d="m2.2 6.1 2.2 2.2 5.4-5.4" />
        </svg>
      ) : null}
    </span>
  );
}

export function ProseRenderer(props: ChatNodeRendererProps): ReactNode {
  const { node } = props;
  switch (node.kind) {
    case "paragraph": {
      const mediaKind = props.context.allowWideBlocks ? paragraphMediaKind(node.children) : null;
      return (
        <p
          className={mediaKind === null ? undefined : `chat-media-paragraph chat-media-paragraph--${mediaKind}`}
          data-markdown-han-text={containsHanText(node.children) || undefined}
          data-wide-markdown-block={mediaKind === "single" || undefined}
          dir="auto"
        >
          {children(props)}
        </p>
      );
    }
    case "heading": {
      const Heading = `h${node.depth}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      // Transcript headings are content, not document navigation anchors.
      // Codex therefore does not synthesize slug IDs (which also collide when
      // the model repeats a heading later in a long conversation).
      return <Heading dir="auto">{children(props)}</Heading>;
    }
    case "blockquote": return <blockquote dir="auto">{children(props)}</blockquote>;
    case "strong": return <strong>{children(props)}</strong>;
    case "emphasis": return <em>{children(props)}</em>;
    case "delete": return <del>{children(props)}</del>;
    case "root-fragment": return <Fragment>{children(props)}</Fragment>;
    case "line-break": return <br />;
    case "horizontal-rule": return <hr />;
    case "list": {
      const containsTasks = node.children.some((child) => child.kind === "list-item" && child.checked !== null);
      if (node.ordered) return <ol className={containsTasks ? "contains-task-list" : undefined} dir="auto" start={node.start ?? undefined}>{children(props)}</ol>;
      return <ul className={containsTasks ? "contains-task-list" : undefined} dir="auto">{children(props)}</ul>;
    }
    case "list-item": return (
      <li className={node.checked !== null ? "task-list-item" : undefined} data-task-item={node.checked !== null || undefined}>
        {node.checked !== null ? <TaskCheckbox checked={node.checked} /> : null}
        {children(props)}
      </li>
    );
    case "text": return <SegmentedText node={node} props={props} />;
    case "color-swatch": return <><SegmentedText node={node} props={props} /><span aria-hidden className="chat-color-swatch" data-hex-color-swatch={node.color} style={{ backgroundColor: node.color }} /></>;
    case "inline-code": return <code className="chat-inline-code">{node.code}</code>;
    case "unknown": return <span data-chat-unknown-token={node.tokenType}>{node.raw}</span>;
    default: return null;
  }
}

export const proseNodeKinds: readonly ChatDocumentNode["kind"][] = [
  "paragraph",
  "heading",
  "blockquote",
  "strong",
  "emphasis",
  "delete",
  "root-fragment",
  "line-break",
  "horizontal-rule",
  "list",
  "list-item",
  "text",
  "color-swatch",
  "inline-code",
  "unknown",
];
