import type { ChatDocumentNode } from "@opencraft/chat-document";
import type { ChatNodeRendererProps } from "@opencraft/chat-render-react";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import { writeToClipboard } from "../../clipboard";
import "./table.scss";

type TableNode = Extract<ChatDocumentNode, { kind: "table" }>;

function CopyGlyph({ copied }: { readonly copied: boolean }) {
  if (copied) return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m3.5 8.3 2.7 2.7 6.3-6.3" /></svg>;
  return <svg aria-hidden="true" viewBox="0 0 16 16"><rect height="9" rx="1.5" width="9" x="5" y="2" /><path d="M11 11v1.5A1.5 1.5 0 0 1 9.5 14h-6A1.5 1.5 0 0 1 2 12.5v-6A1.5 1.5 0 0 1 3.5 5H5" /></svg>;
}

function ExpandGlyph() {
  return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M6.25 2.5H2.5v3.75M9.75 13.5h3.75V9.75M2.7 6.1l3.4-3.4M13.3 9.9l-3.4 3.4" /></svg>;
}

function CloseGlyph() {
  return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m3.5 3.5 9 9m0-9-9 9" /></svg>;
}

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

function TablePreview({ children, onClose, open }: {
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly open: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog aria-label="Table preview" className="chat-table-preview" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose} ref={ref}>
      <div className="chat-table-preview__toolbar"><span>Table preview</span><button aria-label="Close table preview" onClick={onClose} type="button"><CloseGlyph /></button></div>
      <div className="chat-table-preview__content">{children}</div>
    </dialog>
  );
}

export function TableRenderer({ context, node, renderNodes }: ChatNodeRendererProps) {
  const [copied, setCopied] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
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
    <div className="chat-table-container" data-markdown-table="true" data-wide-block={context.allowWideBlocks || undefined} tabIndex={-1}>
      <div className={`chat-table-scroller${context.allowWideBlocks ? " horizontal-scroll-fade-mask" : ""}`}>
        <div className="chat-table-wrapper"><TableContents node={node} renderNodes={renderNodes} /></div>
      </div>
      <div className="chat-table-actions" data-markdown-copy="exclude">
        <div className="chat-table-actions__bar">
          {context.allowWideBlocks ? <button aria-label="Expand table" aria-expanded={previewOpen} onClick={() => setPreviewOpen(true)} title="Expand table" type="button"><ExpandGlyph /></button> : null}
          <button aria-label={copied ? "Copied table" : "Copy table"} onClick={(event) => void copy(event)} title={copied ? "Copied" : "Copy table"} type="button"><CopyGlyph copied={copied} /></button>
        </div>
      </div>
      <TablePreview onClose={() => setPreviewOpen(false)} open={previewOpen}><TableContents node={node} renderNodes={renderNodes} /></TablePreview>
    </div>
  );
}
