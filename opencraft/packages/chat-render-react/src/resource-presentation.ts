import type { ChatDocumentDirectiveNode, ChatDocumentReferenceNode } from "@opencraft/chat-document";

function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path;
}

/** The displayed file label and target must agree across Web and Native. */
export function chatFileCitationPresentation(node: ChatDocumentDirectiveNode): {
  readonly label: string;
  readonly target: string;
} | null {
  if (node.name !== "codex-file-citation") return null;
  const path = node.attributes.path?.trim() ?? "";
  if (path.length === 0) return null;
  const start = node.attributes.line_range_start ?? node.attributes.lineRangeStart;
  const end = node.attributes.line_range_end ?? node.attributes.lineRangeEnd;
  const location = start === undefined ? "" : end === undefined ? `L${start}` : `L${start}–${end}`;
  return {
    label: `${basename(path)}${location.length === 0 ? "" : ` (${location})`}`,
    target: `${path}${start === undefined ? "" : `:${start}${end === undefined ? "" : `-${end}`}`}`,
  };
}

/** Variable references stay text; file mentions resolve through the host. */
export function chatReferenceTarget(node: ChatDocumentReferenceNode): string | null {
  return node.referenceKind === "workspace-file" ? node.text.slice(1) : null;
}
