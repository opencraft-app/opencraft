import {
  collapseUnifiedDiffContext,
  parseUnifiedDiff,
  type UnifiedDiffLine,
  type UnifiedDiffRenderRow,
  type UnifiedDiffSegment,
} from "@opencraft/chat-core";
import { MoreHorizontal } from "lucide-react";
import { useMemo, useState } from "react";

function DiffSegments({ segments, text }: { readonly segments: readonly UnifiedDiffSegment[] | null; readonly text: string }) {
  if (segments === null || segments.length === 0) return <>{text || " "}</>;
  return (
    <>
      {segments.map((segment, index) => (
        <span data-diff-changed={segment.changed || undefined} key={index + ":" + segment.text}>{segment.text || " "}</span>
      ))}
    </>
  );
}

function DiffLine({ line }: { readonly line: UnifiedDiffLine }) {
  const structural = line.kind === "hunk" || line.kind === "meta" || line.kind === "no-newline";
  const marker = line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " ";
  const segments = line.kind === "addition" ? line.newSegments : line.kind === "deletion" ? line.oldSegments : null;
  return (
    <div className="thread-unified-diff__row" data-diff-line={line.kind} role="row">
      {structural ? (
        <code className="thread-unified-diff__structural" role="cell">{line.text || " "}</code>
      ) : (
        <>
          <span className="thread-unified-diff__line-number" role="cell">{line.oldLine ?? ""}</span>
          <span className="thread-unified-diff__line-number" role="cell">{line.newLine ?? ""}</span>
          <span className="thread-unified-diff__marker" role="cell">{marker}</span>
          <code className="thread-unified-diff__code" role="cell"><DiffSegments segments={segments} text={line.content} /></code>
        </>
      )}
    </div>
  );
}

export function UnifiedDiffPreview({ diff }: { readonly diff: string }) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const collapsedRows = useMemo(() => collapseUnifiedDiffContext(lines), [lines]);
  const [expandedContexts, setExpandedContexts] = useState<ReadonlySet<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo<readonly UnifiedDiffRenderRow[]>(() => collapsedRows.flatMap((row): readonly UnifiedDiffRenderRow[] => (
    row.kind === "collapsed" && expandedContexts.has(row.key) ? row.lines : [row]
  )), [collapsedRows, expandedContexts]);
  const visibleRows = showAll ? rows : rows.slice(0, 420);
  const hiddenRowCount = rows.length - visibleRows.length;
  return (
    <div className="thread-unified-diff" role="table" aria-label="File changes">
      {visibleRows.map((row) => row.kind === "collapsed" ? (
        <button
          className="thread-unified-diff__collapsed"
          data-timeline-preserve-on-reflow="true"
          key={row.key}
          onClick={() => setExpandedContexts((current) => new Set([...current, row.key]))}
          type="button"
        >
          <MoreHorizontal size={13} />
          Show {row.lines.length} unchanged lines
        </button>
      ) : <DiffLine key={row.key} line={row} />)}
      {hiddenRowCount > 0 ? (
        <button className="thread-unified-diff__show-all" data-timeline-preserve-on-reflow="true" onClick={() => setShowAll(true)} type="button">
          Show {hiddenRowCount} more lines
        </button>
      ) : null}
    </div>
  );
}
