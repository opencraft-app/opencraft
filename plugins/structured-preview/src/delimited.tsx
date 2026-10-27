import { ArrowUpIcon, ArrowDownIcon } from "@opencraft/design-system-web/action-icons";
import { createRoot } from "react-dom/client";
import { useLayoutEffect, useRef, useState, useMemo, type PointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FilePreviewIntl, WebPreviewDocument } from "@opencraft/file-preview-web";
import { columnLabel, decodeDelimitedBytes, parseDelimited } from "./delimited-model";
import "./preview.web.scss";

const tableMessage = { id: "chat.table.table", defaultMessage: "Table" };
const sourceMessage = { id: "panel.markdownSource", defaultMessage: "Source" };

function DelimitedTable({ rows, source, name, intl }: { rows: string[][]; source: string; name: string; intl?: FilePreviewIntl }) {
  const scroll = useRef<HTMLDivElement>(null);
  const [showSource, setShowSource] = useState(false);
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);
  const [query, setQuery] = useState("");
  const [notFound, setNotFound] = useState(false);
  const columns = useMemo(() => rows.reduce((max, row) => Math.max(max, row.length), 0), [rows]);
  const vertical = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: () => 32, overscan: 8 });
  const horizontal = useVirtualizer({ count: columns, horizontal: true, getScrollElement: () => scroll.current, estimateSize: index => widths[index] ?? 180, overscan: 2, paddingStart: 48, scrollPaddingStart: 48 });
  useLayoutEffect(() => { if (!showSource) { vertical.measure(); horizontal.measure(); } }, [showSource, widths]);
  const visibleColumns = horizontal.getVirtualItems();
  const message = (id: string, defaultMessage: string) => intl?.formatMessage({ id, defaultMessage }) ?? defaultMessage;
  const choose = (row: number, col: number, focus = false) => {
    if (row < 0 || row >= rows.length || col < 0 || col >= columns) return;
    setSelected({ row, col });
    vertical.scrollToIndex(row, { align: "auto" }); horizontal.scrollToIndex(col, { align: "auto" });
    if (focus) requestAnimationFrame(() => scroll.current?.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`)?.focus({ preventScroll: true }));
  };
  const find = (direction: number) => {
    if (!query || !columns || !rows.length) return;
    const needle = query.toLocaleLowerCase();
    // Walk actual cells, including ragged rows; never expand the rectangular grid.
    let row = selected?.row ?? (direction > 0 ? 0 : rows.length - 1);
    let col = selected ? Math.min(selected.col, rows[row]!.length) : (direction > 0 ? -1 : rows[row]!.length);
    const count = rows.reduce((sum, row) => sum + row.length, 0);
    for (let checked = 0; checked < count; checked++) {
      col += direction;
      if (col >= rows[row]!.length) { row = (row + 1) % rows.length; col = 0; }
      if (col < 0) { row = (row + rows.length - 1) % rows.length; col = rows[row]!.length - 1; }
      if (rows[row]![col]?.toLocaleLowerCase().includes(needle)) { setNotFound(false); choose(row, col); return; }
    }
    setNotFound(true);
  };
  const drag = useRef<{ col: number; pointerId: number; x: number; width: number } | null>(null);
  const resize = (col: number, width: number) => setWidths(previous => ({ ...previous, [col]: Math.max(80, Math.min(720, width)) }));
  const startResize = (event: PointerEvent<HTMLDivElement>, col: number, width: number) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { col, pointerId: event.pointerId, x: event.clientX, width };
  };
  return <div className="structured-preview structured-preview--table">
    <div className="structured-preview__toolbar">
      <button type="button" aria-pressed={!showSource} onClick={() => setShowSource(false)}>{intl ? intl.formatMessage(tableMessage) : tableMessage.defaultMessage}</button>
      <button type="button" aria-pressed={showSource} onClick={() => setShowSource(true)}>{intl ? intl.formatMessage(sourceMessage) : sourceMessage.defaultMessage}</button>
      <span>{intl?.formatNumber(rows.length) ?? rows.length.toLocaleString()} × {intl?.formatNumber(columns) ?? columns.toLocaleString()}</span>
    </div>
    <form className="structured-preview__search" hidden={showSource} onSubmit={event => { event.preventDefault(); find(1); }}>
      <input type="search" value={query} onChange={event => { setQuery(event.target.value); setNotFound(false); }} aria-label={message("preview.find", "Find in table")} placeholder={message("preview.find", "Find in table")} />
      <button type="button" disabled={!query} onClick={() => find(-1)} aria-label={message("preview.previousMatch", "Previous match")}><ArrowUpIcon size={16} /></button>
      <button type="submit" disabled={!query} aria-label={message("preview.nextMatch", "Next match")}><ArrowDownIcon size={16} /></button>
      <span role="status">{notFound ? message("preview.noMatch", "No matches") : ""}</span>
    </form>
    <pre className="structured-preview__source" hidden={!showSource}>{source}</pre>
    <div ref={scroll} className="structured-preview__table-scroll" hidden={showSource} tabIndex={0} role="region" aria-label={name}>
      <div role="table" aria-label={name} aria-rowcount={rows.length + 1} aria-colcount={columns + 1} style={{ width: Math.max(48, horizontal.getTotalSize()), minWidth: "100%" }}>
        <div className="structured-preview__table-header" role="row" aria-rowindex={1}>
          <div className="structured-preview__row-number" role="columnheader">#</div>
          {visibleColumns.map(col => <div key={col.key} role="columnheader" aria-colindex={col.index + 2} style={{ left: col.start, width: col.size }}>{columnLabel(col.index)}
            <div className="structured-preview__column-resize" role="separator" aria-orientation="vertical" tabIndex={0} aria-valuemin={80} aria-valuemax={720} aria-valuenow={col.size}
              aria-label={`${message("preview.columnWidth", "Column width")} ${columnLabel(col.index)}`}
              onPointerDown={event => startResize(event, col.index, col.size)}
              onPointerMove={event => { const active = drag.current; if (!active || active.pointerId !== event.pointerId) return; resize(active.col, active.width + event.clientX - active.x); }}
              onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) drag.current = null; }} onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) drag.current = null; }}
              onPointerCancel={event => { const active = drag.current; if (!active || active.pointerId !== event.pointerId) return; resize(active.col, active.width); drag.current = null; }}
              onDoubleClick={() => resize(col.index, 180)}
              onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resize(col.index, col.size + (event.key === "ArrowLeft" ? -20 : 20)); } }} />
          </div>)}
        </div>
        <div style={{ height: vertical.getTotalSize(), position: "relative" }}>
          {vertical.getVirtualItems().map(row => <div key={row.key} className="structured-preview__table-row" role="row" aria-rowindex={row.index + 2} style={{ top: row.start, height: row.size }}>
            <div className="structured-preview__row-number" role="rowheader">{row.index + 1}</div>
            {visibleColumns.map(col => <div key={col.key} role="cell" aria-colindex={col.index + 2} data-cell={`${row.index}:${col.index}`}
              tabIndex={selected ? selected.row === row.index && selected.col === col.index ? 0 : -1 : row.index === 0 && col.index === 0 ? 0 : -1}
              data-selected={selected?.row === row.index && selected?.col === col.index || undefined}
              onClick={() => choose(row.index, col.index)}
              onKeyDown={event => { const delta = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[event.key]; if (delta) { event.preventDefault(); choose(row.index + delta[0]!, col.index + delta[1]!, true); } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(row.index, col.index); } }}
              style={{ left: col.start, width: col.size }} title={rows[row.index]?.[col.index] ?? ""}>{rows[row.index]?.[col.index] ?? ""}</div>)}
          </div>)}
        </div>
      </div>
    </div>
    <label className="structured-preview__cell-detail" hidden={showSource}>
      <span>{selected ? `${columnLabel(selected.col)}${selected.row + 1}` : message("preview.selectCell", "Select a cell to read its full contents")}</span>
      <textarea readOnly value={selected ? rows[selected.row]?.[selected.col] ?? "" : ""} aria-label={message("preview.cellContents", "Cell contents")} />
    </label>
  </div>;
}

export async function openDelimited(input: { blob: Blob; name: string; signal: AbortSignal }): Promise<WebPreviewDocument> {
  const bytes = new Uint8Array(await input.blob.arrayBuffer());
  input.signal.throwIfAborted();
  const source = decodeDelimitedBytes(bytes);
  const rows = parseDelimited(source, /\.tsv$/iu.test(input.name) ? "\t" : ",");
  input.signal.throwIfAborted();
  const element = document.createElement("div");
  element.className = "structured-preview-host";
  const root = createRoot(element);
  const render = (intl?: FilePreviewIntl) => root.render(<DelimitedTable rows={rows} source={source} name={input.name} intl={intl} />);
  render();
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; input.signal.removeEventListener("abort", dispose); root.unmount(); element.remove(); } };
  input.signal.addEventListener("abort", dispose, { once: true });
  return { element, dispose, setIntl: intl => { if (!disposed) render(intl); }, setActive: active => { element.inert = !active; } };
}
