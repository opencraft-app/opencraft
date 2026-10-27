import { CheckIcon } from "@opencraft/design-system-web/action-icons";
import type { ChatDocumentNode } from "@opencraft/chat-document";
import { containsHanText, type ChatNodeRendererProps } from "@opencraft/chat-render-react";
import { Component, Fragment, type CSSProperties, type ReactNode } from "react";

import { captureTextSelection, restoreTextSelection, type TextSelectionSnapshot } from "../text-selection";

import "./prose.scss";

type SegmentedTextNode = Extract<ChatDocumentNode, { kind: "text" | "color-swatch" }>;

interface SegmentedTextProps {
  readonly node: SegmentedTextNode;
  readonly props: ChatNodeRendererProps;
}

class SegmentedText extends Component<SegmentedTextProps, object, TextSelectionSnapshot | null> {
  private first: HTMLSpanElement | null = null;
  private last: HTMLSpanElement | null = null;

  getSnapshotBeforeUpdate(previous: Readonly<SegmentedTextProps>): TextSelectionSnapshot | null {
    const text = this.props.node.text;
    if (text === previous.node.text || !text.startsWith(previous.node.text)) return null;
    const { first, last } = this;
    if (!first || !last) return null;
    const selection = first.ownerDocument.getSelection();
    for (const node of [selection?.anchorNode, selection?.focusNode]) {
      const element = (node?.nodeType === 1 ? node as Element : node?.parentElement)?.closest<HTMLElement>("[data-chat-text-segment]");
      // This text node renders a contiguous run of existing sibling spans.
      if (element && element.parentNode === first.parentNode
        && (element === first || first.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
        && (element === last || last.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING)) {
        return captureTextSelection(element);
      }
    }
    return null;
  }

  componentDidUpdate(_previous: Readonly<SegmentedTextProps>, _state: object, snapshot: TextSelectionSnapshot | null) {
    restoreTextSelection(snapshot);
  }

  render() {
    const { node, props: { context } } = this.props;
    return <>{node.segments.map((segment, index) => (
      <span
        key={segment.key}
        className={segment.entering && !context.fadeTimeline?.isSettled(segment.key, performance.now()) ? "chat-stream-fade-in" : undefined}
        data-chat-stream-enter={segment.entering || undefined}
        data-chat-text-segment=""
        ref={index === 0 || index === node.segments.length - 1 || (segment.entering && context.fadeTimeline !== undefined) ? element => {
          if (index === 0) this.first = element;
          if (index === node.segments.length - 1) this.last = element;
          if (element === null || !segment.entering || context.fadeTimeline === undefined) return;
          const delayMs = context.fadeTimeline.delayFor(segment.key, performance.now()) ?? 0;
          element.style.setProperty("--fade-delay", `${delayMs}ms`);
        } : undefined}
        style={segment.entering ? { "--fade-delay": `${context.fadeTimeline?.cachedDelayFor(segment.key, performance.now()) ?? Math.min(index * 16, 96)}ms` } as CSSProperties : undefined}
        onAnimationEnd={event => {
          if (event.target !== event.currentTarget) return;
          context.fadeTimeline?.settle(segment.key);
          context.requestMeasurement?.({ geometryChanged: false, reason: "stream-animation" });
        }}
      >{segment.text}</span>
    ))}</>;
  }
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
        <CheckIcon size={10} />
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
