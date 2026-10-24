import { CheckboxIcon, ImageIcon } from "@opencraft/design-system-web/action-icons";
import { ChatDocumentCompiler, type ChatDocumentNode } from "@opencraft/chat-document";
import React, { Fragment, memo, useMemo, type ReactNode } from "react";
import type { RecentTurnPreview } from "./model";

/** A static thumbnail projection of the shared document grammar. No resource
 * policy, execution session, media loader, link action or Composer is mounted. */
function documentNodes(nodes: readonly ChatDocumentNode[]): ReactNode {
  return nodes.map((node, index) => {
    const children = "children" in node ? documentNodes(node.children) : null;
    let content: ReactNode;
    switch (node.kind) {
      case "paragraph": content = <p dir="auto">{children}</p>; break;
      case "heading": content = <p className="mini-chat__heading" dir="auto">{children}</p>; break;
      case "strong": content = <strong>{children}</strong>; break;
      case "emphasis": content = <em>{children}</em>; break;
      case "delete": content = <del>{children}</del>; break;
      case "blockquote": content = <blockquote>{children}</blockquote>; break;
      case "list": content = node.ordered ? <ol start={node.start ?? undefined}>{children}</ol> : <ul>{children}</ul>; break;
      case "list-item": content = <li>{node.checked === null ? null : <CheckboxIcon size={14} checked={node.checked} className="mini-chat__inline-glyph" aria-label={node.checked ? "Completed" : "Not completed"} />}{children}</li>; break;
      case "inline-code": content = <code className="ui-text--inline-code">{node.code}</code>; break;
      case "code-fence": content = <pre className="ui-text--prose-code"><code>{node.code}</code></pre>; break;
      // Destinations stay inert, including workspace files and javascript URLs.
      case "link": content = <span className="mini-chat__link">{children}</span>; break;
      case "image": content = <span className="mini-chat__attachment">{node.alt || <ImageIcon size={14} className="mini-chat__inline-glyph" aria-label="Image" />}</span>; break;
      case "table": content = <table><thead><tr>{node.header.map((cell, i) => <th key={i}>{documentNodes(cell)}</th>)}</tr></thead>
        <tbody>{node.rows.slice(0, 3).map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{documentNodes(cell)}</td>)}</tr>)}</tbody></table>; break;
      case "math": content = <code className="ui-text--inline-code">{node.source}</code>; break;
      case "text":
      case "reference":
      case "color-swatch": content = node.text; break;
      case "line-break": content = <br />; break;
      case "horizontal-rule": content = <hr />; break;
      case "directive": content = null; break;
      case "unknown": content = node.raw; break;
      case "root-fragment": content = children; break;
    }
    return <Fragment key={index}>{content}</Fragment>;
  });
}

const MiniChatMessage = memo(function MiniChatMessage({ text, user = false }: { readonly text: string; readonly user?: boolean }) {
  // Each message owns its bounded parser cache; closing/revoking the card drops it.
  const nodes = useMemo(() => new ChatDocumentCompiler().compile(text, { dialect: user ? "user-message" : "assistant" }).nodes, [text, user]);
  return <div className={`mini-chat__message mini-chat__message--${user ? "user" : "assistant"} conversation-overview__${user ? "user" : "assistant"}`}>
    <div className="mini-chat__prose">{documentNodes(nodes)}</div>
  </div>;
});

/** The canvas alone is miniaturized. Card identity, status and touch targets
 * keep normal UI typography and geometry outside the thumbnail. */
export function MiniChat({ turns, emptyLabel }: { readonly turns: readonly RecentTurnPreview[]; readonly emptyLabel: string }) {
  return <div className="mini-chat ui-text--chat" data-minichat="readonly">
    {turns.map(turn => <div className="mini-chat__exchange conversation-overview__turn" key={turn.id}>
      {turn.user ? <MiniChatMessage user text={turn.user} /> : null}
      {turn.assistant ? <MiniChatMessage text={turn.assistant} /> : null}
      {!turn.user && !turn.assistant ? <p className="mini-chat__empty">{emptyLabel}</p> : null}
    </div>)}
  </div>;
}
