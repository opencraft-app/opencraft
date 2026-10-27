import { MoreIcon as MoreHorizontal } from "@opencraft/design-system-web/action-icons";
import {
  collapseUnifiedDiffContext,
  parseUnifiedDiff,
  type UnifiedDiffLine,
  type UnifiedDiffRenderRow,
  type UnifiedDiffSegment,
} from "@opencraft/chat-core";

import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityDisclosureStateContext, useActivityOpen } from "./activity/activity-disclosure";
import { useWorkbenchPresentationActive } from "../workbench-presentation-activity";

export interface DiffReadingPosition {
  readonly scrollTop: number;
  readonly scrollLeft: number;
}

export const DiffReadingPositionContext = createContext<Map<string, DiffReadingPosition> | null>(null);

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

export function UnifiedDiffPreview({ diff, restoreKey }: { readonly diff: string; readonly restoreKey?: string }) {
  const positions = useContext(DiffReadingPositionContext);
  const presentationActive = useWorkbenchPresentationActive();
  const viewport = useRef<HTMLDivElement>(null);
  const rememberPosition = (element: HTMLElement) => {
    if (restoreKey !== undefined) positions?.set(restoreKey, { scrollTop: element.scrollTop, scrollLeft: element.scrollLeft });
  };
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!presentationActive || !element?.clientHeight || restoreKey === undefined || positions === null) return;
    const saved = positions.get(restoreKey);
    if (saved) { element.scrollTop = saved.scrollTop; element.scrollLeft = saved.scrollLeft; }
    // A queued native scroll event may not run before navigation unmounts this View.
    // Hidden routes report zero coordinates; preserve the saved View reading.
    return () => { if (element.clientHeight) rememberPosition(element); };
  }, [presentationActive, positions, restoreKey]);
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const collapsedRows = useMemo(() => collapseUnifiedDiffContext(lines), [lines]);
  const choices = useContext(ActivityDisclosureStateContext);
  const contextKey = (key: string) => `diff:${JSON.stringify([restoreKey, key])}`;
  const [expandedContexts, setExpandedContexts] = useState<ReadonlySet<string>>(() => new Set(
    collapsedRows.filter(row => row.kind === "collapsed" && restoreKey !== undefined
      && choices?.get(contextKey(row.key))?.settledExpanded).map(row => row.key),
  ));
  const [showAll, setShowAll] = useActivityOpen(false, false, restoreKey === undefined ? undefined : contextKey("all"));
  const rows = useMemo<readonly UnifiedDiffRenderRow[]>(() => collapsedRows.flatMap((row): readonly UnifiedDiffRenderRow[] => (
    row.kind === "collapsed" && expandedContexts.has(row.key) ? row.lines : [row]
  )), [collapsedRows, expandedContexts]);
  const visibleRows = showAll ? rows : rows.slice(0, 420);
  const hiddenRowCount = rows.length - visibleRows.length;
  return (
    <div className="thread-unified-diff" ref={viewport} onScroll={event => {
      if (presentationActive && event.currentTarget.clientHeight) rememberPosition(event.currentTarget);
    }} role="table" aria-label="File changes">
      {visibleRows.map((row) => row.kind === "collapsed" ? (
        <button
          className="thread-unified-diff__collapsed"
          data-timeline-preserve-on-reflow="true"
          key={row.key}
          onClick={() => {
            if (restoreKey !== undefined) choices?.set(contextKey(row.key), { runningCollapsed: false, settledExpanded: true });
            setExpandedContexts((current) => new Set([...current, row.key]));
          }}
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
