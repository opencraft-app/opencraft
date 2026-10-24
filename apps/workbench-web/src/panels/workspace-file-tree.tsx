import { ChevronDownIcon as ChevronDown, ChevronRightIcon as ChevronRight, FolderIcon as Folder, FolderOpenIcon as FolderOpen, LoadingRingIcon as LoaderCircle } from "@opencraft/design-system-web/action-icons";
import type { FsReadDirectoryEntry } from "@opencraft/appserver-protocol/generated/v2";
import type { AppServerFileSystemResourcePort } from "@opencraft/workbench-runtime";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";

import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { WorkspaceFileIcon } from "./workspace-file-icon";
import {
  WORKSPACE_TREE_ROW_HEIGHT,
  projectWorkspaceTree,
  selectWorkspaceDirectoryEntries,
  workspaceTreeAncestors,
  workspaceTreeQueryPaths,
  workspaceTreeWindow,
  type WorkspaceTreeRow,
} from "./workspace-file-tree-model";

/** One query projection and one viewport for the whole tree, independent of Chat. */
export const WorkspaceFileTree = memo(function WorkspaceFileTree({
  fileSystem, hidden, hostId, onSelect, roots, selectedPath,
}: {
  readonly fileSystem: AppServerFileSystemResourcePort;
  readonly hidden: boolean;
  readonly hostId: string;
  readonly onSelect: (path: string) => void;
  readonly roots: readonly string[];
  readonly selectedPath: string;
}) {
  const rootsKey = roots.join("\u0000");
  const rootPaths = useMemo(() => rootsKey.length === 0 ? [] : rootsKey.split("\u0000"), [rootsKey]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(workspaceTreeAncestors(rootPaths, selectedPath)));
  const [activePath, setActivePath] = useState(selectedPath);
  const reveal = useRef<string | null>(selectedPath);
  const viewport = useRef<HTMLDivElement>(null);
  const rowId = useId();
  const [viewportState, setViewportState] = useState({ top: 0, height: 400 });

  useLayoutEffect(() => {
    const ancestors = workspaceTreeAncestors(rootPaths, selectedPath);
    setExpanded(current => {
      if (ancestors.every(path => current.has(path))) return current;
      return new Set([...current, ...ancestors]);
    });
    setActivePath(selectedPath);
    reveal.current = selectedPath;
  }, [rootPaths, selectedPath]);

  const paths = useMemo(() => workspaceTreeQueryPaths(rootPaths, expanded), [rootPaths, expanded]);
  const combine = useCallback((results: readonly UseQueryResult<readonly FsReadDirectoryEntry[]>[]) => results.map((result, index) => ({
    path: paths[index]!, entries: result.data, failed: result.isError,
  })), [paths]);
  const directories = useQueries({
    queries: paths.map(path => ({
      queryKey: ["appserver-fs", hostId, "directory", path],
      queryFn: () => fileSystem.readDirectory(path),
      select: selectWorkspaceDirectoryEntries,
      staleTime: 15_000,
    })),
    combine,
  });
  const rows = useMemo(() => projectWorkspaceTree(rootPaths, expanded, directories), [rootPaths, expanded, directories]);
  const indexes = useMemo(() => new Map(rows.map((row, index) => [row.path, index])), [rows]);
  const range = workspaceTreeWindow(rows.length, viewportState.top, viewportState.height);
  const activeIndex = indexes.get(activePath) ?? rows.findIndex(row => row.kind === "directory" || row.kind === "file");

  const measure = useCallback(() => {
    const element = viewport.current;
    // A hidden pane must not replace its last visible dimensions/scroll receipt.
    if (!element || element.clientHeight === 0) return;
    const top = element.scrollTop, height = element.clientHeight;
    setViewportState(current => current.top === top && current.height === height ? current : { top, height });
  }, []);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);
  const showRow = useCallback((index: number) => {
    const element = viewport.current;
    if (!element || element.clientHeight === 0) return;
    const top = index * WORKSPACE_TREE_ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + WORKSPACE_TREE_ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + WORKSPACE_TREE_ROW_HEIGHT - element.clientHeight;
    }
    measure();
  }, [measure]);
  useLayoutEffect(() => {
    if (hidden) return;
    measure();
    const index = reveal.current === null ? undefined : indexes.get(reveal.current);
    if (index !== undefined) {
      showRow(index);
      reveal.current = null;
    }
  }, [hidden, indexes, measure, showRow, selectedPath]);

  const toggle = useCallback((path: string) => {
    setExpanded(current => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);
  const activate = (row: WorkspaceTreeRow) => {
    if (row.kind !== "directory" && row.kind !== "file") return;
    setActivePath(row.path);
    viewport.current?.focus({ preventScroll: true });
    if (row.kind === "directory") toggle(row.path);
    else onSelect(row.path);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const row = rows[activeIndex];
    if (!row) return;
    let next = activeIndex;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        const delta = event.key === "ArrowDown" ? 1 : -1;
        for (let index = activeIndex + delta; index >= 0 && index < rows.length; index += delta) {
          if (rows[index]!.kind === "directory" || rows[index]!.kind === "file") { next = index; break; }
        }
        break;
      }
      case "Home": next = 0; break;
      case "End":
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (rows[index]!.kind === "directory" || rows[index]!.kind === "file") { next = index; break; }
        }
        break;
      case "ArrowRight":
        if (row.kind === "directory") {
          if (!expanded.has(row.path)) toggle(row.path);
          else if (rows[activeIndex + 1]?.parent === row.path && rows[activeIndex + 1]?.kind !== "loading" && rows[activeIndex + 1]?.kind !== "error") next += 1;
        }
        break;
      case "ArrowLeft":
        if (row.kind === "directory" && expanded.has(row.path)) toggle(row.path);
        else if (row.parent !== null) next = indexes.get(row.parent) ?? next;
        break;
      case "Enter":
      case " ": activate(row); break;
      default: return;
    }
    event.preventDefault();
    setActivePath(rows[next]!.path);
    showRow(next);
  };
  const mountedIndexes = Array.from({ length: range.end - range.start }, (_, index) => range.start + index);
  // Keep the active descendant accessible even when the user scrolls it offscreen.
  if (activeIndex >= 0 && (activeIndex < range.start || activeIndex >= range.end)) mountedIndexes.push(activeIndex);
  return (
    <div className="workspace-file-tree" hidden={hidden} ref={viewport} role="tree" aria-label="Workspace files"
      tabIndex={0} aria-activedescendant={activeIndex >= 0 ? `${rowId}-${activeIndex}` : undefined}
      onScroll={measure} onKeyDown={handleKeyDown} data-row-count={rows.length}>
      <div className="workspace-file-tree__canvas" style={{ height: range.height }}>
        {mountedIndexes.map(index => {
          const row = rows[index]!;
          const position = { top: index * WORKSPACE_TREE_ROW_HEIGHT, height: WORKSPACE_TREE_ROW_HEIGHT };
          if (!("title" in row)) return (
            <div className={`workspace-file-tree__virtual-row workspace-file-tree__status${row.kind === "error" ? " is-error" : ""}`}
              key={row.path} role="status" style={{ ...position, paddingInlineStart: 28 + (row.depth - 1) * 14 }}>
              {row.kind === "loading" ? <><LoaderCircle className="is-spinning" size={12} /> Loading…</> : "Directory unavailable"}
            </div>
          );
          const open = row.kind === "directory" && expanded.has(row.path);
          return (
            <button className={`workspace-file-tree__virtual-row workspace-file-tree__row${row.kind === "file" ? " is-file" : ""}`}
              key={row.path} id={`${rowId}-${index}`} role="treeitem" type="button" tabIndex={-1}
              aria-level={row.depth + 1} aria-selected={selectedPath === row.path}
              aria-expanded={row.kind === "directory" ? open : undefined}
              data-selected={selectedPath === row.path || undefined} data-active={index === activeIndex || undefined}
              onClick={() => activate(row)} title={row.path}
              style={{ ...position, paddingInlineStart: (row.kind === "directory" ? 8 : 24) + row.depth * 14 }}>
              {row.kind === "directory" ? <>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{open ? <FolderOpen size={14} /> : <Folder size={14} />}</> : <WorkspaceFileIcon path={row.path} size={13} />}
              <span>{row.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
});
