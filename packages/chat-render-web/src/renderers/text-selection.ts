type Endpoint = {
  readonly root: HTMLElement;
  readonly source: string;
  readonly offset: number;
} | {
  readonly node: Node;
  readonly offset: number;
};

export interface TextSelectionSnapshot {
  readonly selection: Selection;
  readonly anchor: Endpoint;
  readonly focus: Endpoint;
}

function endpoint(owner: HTMLElement, node: Node, offset: number): Endpoint {
  // Several owned text surfaces can update in one commit. Keep their stable
  // roots rather than text nodes replaced by React or syntax highlighting.
  const root = owner.contains(node) ? owner
    : (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest<HTMLElement>("code, [data-chat-text-segment]");
  if (!root) return { node, offset };
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return { root, source: root.textContent ?? "", offset: range.toString().length };
}

function resolveEndpoint(point: Endpoint): { node: Node; offset: number } | null {
  if ("node" in point) return point.node.isConnected ? point : null;
  const root = point.root;
  if (!root.isConnected || !(root.textContent ?? "").startsWith(point.source)) return null;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = point.offset;
  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
  }
  return point.offset === 0 ? { node: root, offset: 0 } : null;
}

export function captureTextSelection(root: HTMLElement | null): TextSelectionSnapshot | null {
  const selection = root?.ownerDocument.getSelection();
  if (!root || !selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return null;
  if (!root.contains(selection.anchorNode) && !root.contains(selection.focusNode)) return null;
  return { selection,
    anchor: endpoint(root, selection.anchorNode, selection.anchorOffset),
    focus: endpoint(root, selection.focusNode, selection.focusOffset) };
}

export function restoreTextSelection(snapshot: TextSelectionSnapshot | null): void {
  if (!snapshot) return;
  const anchor = resolveEndpoint(snapshot.anchor);
  const focus = resolveEndpoint(snapshot.focus);
  if (anchor && focus) snapshot.selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}
