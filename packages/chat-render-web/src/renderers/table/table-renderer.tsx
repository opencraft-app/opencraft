import { useIntl } from "@opencraft/i18n/react";
import { CopyIcon, CheckIcon } from "@opencraft/design-system-web/action-icons";
import { ExpandIcon as SharedExpandIcon, CloseIcon as SharedCloseIcon } from "@opencraft/design-system-web/action-icons";
import type { ChatDocumentNode } from "@opencraft/chat-document";
import type { ChatNodeRendererProps } from "@opencraft/chat-render-react";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import { writeToClipboard } from "../../clipboard";
import { usePreviewFocusOrigin } from "../../preview-focus-origin";
import { useChatReadingPosition } from "../../reading-position";
import "./table.scss";

type TableNode = Extract<ChatDocumentNode, { kind: "table" }>;

function CopyGlyph({ copied }: { readonly copied: boolean }) {
  return copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />;
}

function ExpandGlyph() { return <SharedExpandIcon size={16} />; }

function CloseGlyph() { return <SharedCloseIcon size={16} />; }

function TableContents({ node, renderNodes }: {
  readonly node: TableNode;
  readonly renderNodes: ChatNodeRendererProps["renderNodes"];
}) {
  return (
    <table dir="auto">
      <thead><tr>{node.header.map((cell, index) => (
        <th align={node.align[index] ?? undefined} dir="auto" key={`h-${index}`}>{renderNodes(cell)}</th>
      ))}</tr></thead>
      <tbody>{node.rows.map((row, rowIndex) => (
        <tr key={`r-${rowIndex}`}>{row.map((cell, cellIndex) => {
          const plain = cell.length === 1 && cell[0]?.kind === "text" ? cell[0].text : null;
          return <td align={node.align[cellIndex] ?? undefined} className={plain !== null && /^\d+$/u.test(plain) ? "chat-table-numeric" : undefined} dir="auto" key={`c-${cellIndex}`}>{renderNodes(cell)}</td>;
        })}</tr>
      ))}</tbody>
    </table>
  );
}

function TablePreview({ children, onClose, onKeyboardNavigation, open, openedByPointer }: {
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly onKeyboardNavigation: ReturnType<typeof usePreviewFocusOrigin>["onPreviewKeyDown"];
  readonly open: boolean;
  readonly openedByPointer: boolean;
}) {
  const intl = useIntl();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog aria-label={intl.formatMessage({ id: "chat.table.preview", defaultMessage: "Table preview" })} className="chat-table-preview" data-opened-by-pointer={openedByPointer || undefined} onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose} onKeyDown={onKeyboardNavigation} ref={ref}>
      <div className="chat-table-preview__toolbar"><span>{intl.formatMessage({ id: "chat.table.preview", defaultMessage: "Table preview" })}</span><button aria-label={intl.formatMessage({ id: "chat.table.close", defaultMessage: "Close table preview" })} onClick={onClose} type="button"><CloseGlyph /></button></div>
      <div className="chat-table-preview__content">{children}</div>
    </dialog>
  );
}

export function TableRenderer({ context, node, renderNodes }: ChatNodeRendererProps) {
  const intl = useIntl();
  const [copied, setCopied] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewFocus = usePreviewFocusOrigin();
  const readingPosition = useChatReadingPosition(
    node.kind === "table" ? JSON.stringify([context.documentId, node.stableKey, "table"]) : undefined,
    node.kind === "table" ? node.markdownSource : "",
  );
  if (node.kind !== "table") return null;

  const copy = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    const table = event.currentTarget.closest("[data-markdown-table]")?.querySelector("table");
    if (table === null || table === undefined) return;
    await writeToClipboard({
      "text/plain": node.markdownSource,
      "text/html": table.outerHTML,
    }, event.currentTarget);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  };

  return (
    <div className="chat-table-container" data-markdown-table="true" data-wide-block={context.allowWideBlocks || undefined}>
      <div aria-label={intl.formatMessage({ id: "chat.table.table", defaultMessage: "Table" })} className={`chat-table-scroller${context.allowWideBlocks ? " horizontal-scroll-fade-mask" : ""}`} role="region" tabIndex={0} {...readingPosition}>
        <div className="chat-table-wrapper"><TableContents node={node} renderNodes={renderNodes} /></div>
      </div>
      <div className="chat-table-actions" data-markdown-copy="exclude">
        <div className="chat-table-actions__bar">
          {context.allowWideBlocks ? <button aria-label={intl.formatMessage({ id: "chat.table.expand", defaultMessage: "Expand table" })} aria-expanded={previewOpen} onClick={(event) => { previewFocus.recordOpen(event); setPreviewOpen(true); }} onKeyDown={previewFocus.onTriggerKeyDown} onPointerCancel={previewFocus.onTriggerPointerCancel} onPointerDown={previewFocus.onTriggerPointerDown} title={intl.formatMessage({ id: "chat.table.expand", defaultMessage: "Expand table" })} type="button"><ExpandGlyph /></button> : null}
          <button aria-label={copied ? intl.formatMessage({ id: "chat.table.copied", defaultMessage: "Copied table" }) : intl.formatMessage({ id: "chat.table.copy", defaultMessage: "Copy table" })} onClick={(event) => void copy(event)} title={copied ? intl.formatMessage({ id: "chat.table.copiedShort", defaultMessage: "Copied" }) : intl.formatMessage({ id: "chat.table.copy", defaultMessage: "Copy table" })} type="button"><CopyGlyph copied={copied} /></button>
        </div>
      </div>
      <TablePreview onClose={() => setPreviewOpen(false)} onKeyboardNavigation={previewFocus.onPreviewKeyDown} open={previewOpen} openedByPointer={previewFocus.openedByPointer}><TableContents node={node} renderNodes={renderNodes} /></TablePreview>
    </div>
  );
}
