import { extractMarkdownElement } from "@opencraft/chat-render-web";
import * as Popover from "@radix-ui/react-popover";
import { NewMessageIcon as MessageSquarePlus } from "@opencraft/design-system-web/action-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { FormattedMessage } from "@opencraft/i18n/react";
import "./selection-menu.scss";

interface TextSelection {
  readonly text: string;
  readonly range: Range;
  readonly rect: DOMRect;
}

/** One selection owner per timeline; editor, sender labels and controls are excluded. */
export function readConversationSelection(root: HTMLElement): TextSelection | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const elementFor = (node: Node) => node.nodeType === 1 ? node as Element : node.parentElement;
  const excluded = 'button, input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [data-markdown-copy="exclude"], [aria-hidden="true"]';
  const start = elementFor(range.startContainer)?.closest(".opencraft-chat-document");
  const end = elementFor(range.endContainer)?.closest(".opencraft-chat-document");
  if (!start || start !== end || !root.contains(start)
    || start.closest('[hidden], [inert], [aria-hidden="true"]')
    || elementFor(range.startContainer)?.closest(excluded)
    || elementFor(range.endContainer)?.closest(excluded)) return null;
  const fragment = root.ownerDocument.createElement("div");
  fragment.append(range.cloneContents());
  // Cloned code metadata describes the full block; a quote must keep only the selection.
  fragment.querySelectorAll("[data-markdown-copy-text]").forEach(element => element.removeAttribute("data-markdown-copy-text"));
  const text = extractMarkdownElement(fragment).plainText;
  if (!text) return null;
  // A drag may scroll the beginning out of view. Anchor to selected text that
  // is still visible in both the timeline and browser, never an offscreen line.
  const win = root.ownerDocument.defaultView!;
  const bounds = root.getBoundingClientRect();
  const left = Math.max(0, bounds.left), right = Math.min(win.innerWidth, bounds.right);
  const top = Math.max(0, bounds.top), bottom = Math.min(win.innerHeight, bounds.bottom);
  const visible = Array.from(range.getClientRects()).find(rect => rect.width > 0 && rect.height > 0
    && rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom);
  if (!visible || right <= left || bottom <= top) return null;
  const x = Math.max(left, visible.left), y = Math.max(top, visible.top);
  const rect = new DOMRect(x, y, Math.min(right, visible.right) - x, Math.min(bottom, visible.bottom) - y);
  return { text, range: range.cloneRange(), rect };
}

export function ConversationSelectionMenu({ root, onAddToChat }: {
  readonly root: HTMLElement | null;
  readonly onAddToChat?: (text: string) => boolean;
}) {
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const dismiss = useCallback(() => setSelection(null), []);
  const dragging = useRef(false);
  const [touchLayout, setTouchLayout] = useState(() => document.documentElement.dataset.uiDensity === "touch");
  useEffect(() => {
    if (!root) return;
    const element = root.ownerDocument.documentElement;
    const update = () => setTouchLayout(element.dataset.uiDensity === "touch");
    const observer = new MutationObserver(update);
    observer.observe(element, { attributes: true, attributeFilter: ["data-ui-density"] });
    update();
    return () => observer.disconnect();
  }, [root]);
  const enabled = onAddToChat !== undefined && !touchLayout;
  useEffect(() => {
    dismiss();
    if (!root || !enabled) return;
    const doc = root.ownerDocument;
    const win = doc.defaultView!;
    const update = () => { if (!dragging.current) setSelection(readConversationSelection(root)); };
    const down = () => { dragging.current = true; dismiss(); };
    const up = () => { dragging.current = false; update(); };
    const cancel = () => { dragging.current = false; dismiss(); };
    root.addEventListener("pointerdown", down);
    doc.addEventListener("pointerup", up);
    doc.addEventListener("pointercancel", cancel);
    doc.addEventListener("selectionchange", update);
    win.addEventListener("scroll", dismiss, true);
    win.addEventListener("resize", dismiss);
    win.addEventListener("blur", dismiss);
    return () => {
      dragging.current = false;
      root.removeEventListener("pointerdown", down);
      doc.removeEventListener("pointerup", up);
      doc.removeEventListener("pointercancel", cancel);
      doc.removeEventListener("selectionchange", update);
      win.removeEventListener("scroll", dismiss, true);
      win.removeEventListener("resize", dismiss);
      win.removeEventListener("blur", dismiss);
    };
  // Callback identity changes with live snapshots, but does not change selection ownership.
  }, [root, enabled, dismiss]);

  const virtualAnchor = useRef({ getBoundingClientRect: () => selection?.rect ?? new DOMRect() });
  virtualAnchor.current = { getBoundingClientRect: () => selection?.rect ?? new DOMRect() };
  if (!enabled || !selection || !root || !onAddToChat) return null;
  const activate = () => {
    if (root.ownerDocument.documentElement.dataset.uiDensity === "touch") return;
    const current = readConversationSelection(root);
    if (current && current.text === selection.text
      && current.range.compareBoundaryPoints(Range.START_TO_START, selection.range) === 0
      && current.range.compareBoundaryPoints(Range.END_TO_END, selection.range) === 0) {
      // Clear first: focusing the editor must retain its newly placed caret.
      root.ownerDocument.getSelection()?.removeAllRanges();
      onAddToChat(selection.text);
    }
    dismiss();
  };
  return <Popover.Root open onOpenChange={open => { if (!open) dismiss(); }}>
    <Popover.Anchor virtualRef={virtualAnchor} />
    <Popover.Portal>
      <Popover.Content className="conversation-selection-menu" side="top" sideOffset={6}
        collisionPadding={8} onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}>
        <button type="button" onMouseDown={event => event.preventDefault()}
          onPointerDown={event => { if (event.pointerType !== "mouse") event.preventDefault(); }}
          onClick={activate}>
          <MessageSquarePlus aria-hidden="true" />
          <FormattedMessage id="chat.addSelectionToChat" defaultMessage="Add to chat" />
        </button>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
