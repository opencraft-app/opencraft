import type { ChatDocumentNode } from "./model";

/** Visible document text for compact labels; never includes a link destination
 * or interprets HTML. Block boundaries survive so callers can select a line.
 * Literal punctuation in text/code is preserved rather than regex-stripped. */
export function chatDocumentPlainText(nodes: readonly ChatDocumentNode[]): string {
  return projectNodes(nodes, false);
}

function projectNodes(nodes: readonly ChatDocumentNode[], inline: boolean): string {
  const leaf = (value: string) => inline ? value : `${value}\n`;
  return nodes.map((node): string => {
    switch (node.kind) {
      case "text":
      case "reference":
      case "color-swatch": return leaf(node.text);
      case "inline-code": return leaf(node.code);
      case "code-fence": return `${node.code}\n`;
      case "math": return node.display ? `${node.source}\n` : node.source;
      case "image": return leaf(node.alt);
      case "line-break":
      case "horizontal-rule": return "\n";
      case "table": return [node.header, ...node.rows]
        .map(row => row.map(cell => projectNodes(cell, true)).join("\t")).join("\n") + "\n";
      case "directive":
      case "unknown": return leaf(node.raw);
      case "paragraph":
      case "heading": return `${projectNodes(node.children, true)}\n`;
      case "blockquote":
      case "list":
      case "list-item": return `${projectNodes(node.children, false)}\n`;
      case "strong":
      case "emphasis":
      case "delete":
      case "root-fragment":
      case "link": return projectNodes(node.children, true);
    }
  }).join("");
}
