import type { ChatDocumentNode } from "@opencraft/chat-document";

function plainText(nodes: readonly ChatDocumentNode[]): string {
  return nodes.map((node) => {
    if (node.kind === "text") return node.text;
    if (node.kind === "inline-code") return node.code;
    return "children" in node ? plainText(node.children) : "";
  }).join("");
}

/** Shared document-level test for the tighter rhythm between Han paragraphs. */
export function containsHanText(nodes: readonly ChatDocumentNode[]): boolean {
  return /\p{Script=Han}/u.test(plainText(nodes));
}
