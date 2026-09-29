import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BlobProgress } from "@opencraft/blob-resources";
import type { FuzzyFileSearchResult } from "@opencraft/appserver-protocol/generated";
import type { FsReadDirectoryEntry } from "@opencraft/appserver-protocol/generated/v2";
import type { PanelRendererProps } from "@opencraft/workbench-panels-react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  LoaderCircle,
  Pencil,
  RotateCcw,
  Save,
  Search,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  useAppServerRuntime,
  useAppServerSnapshot,
  useBlobResources,
} from "../runtime/appserver-runtime-context";
import { acquireFileBlob, fileBlobResource, fileBlobUrls } from "../runtime/blob-files";
import {
  MAX_EDITABLE_FILE_BYTES,
  decodeWorkspaceText,
  encodeBase64Text,
  joinWorkspacePath,
  parseWorkspaceResource,
  reconcileWorkspaceSave,
  updateWorkspaceDraft,
  workspaceDraftConflicted,
  workspaceDraftKey,
  type WorkspaceDraft,
  workspaceFileLanguage,
  workspaceImageMime,
  workspacePathParent,
  workspaceResourceBasename,
  workspaceRootsForResource,
} from "./workspace-resource-model";
import { WorkspaceFileIcon } from "./workspace-file-icon";

const WorkspaceCodeEditor = lazy(() => import("./workspace-code-editor").then((module) => ({ default: module.WorkspaceCodeEditor })));

interface LoadedWorkspaceResource {
  readonly blob: Blob | null;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly modifiedAtMs: number;
  readonly size: number;
  readonly text: string | null;
}

function sortedDirectoryEntries(entries: readonly FsReadDirectoryEntry[]) {
  return [...entries].sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    return left.fileName.localeCompare(right.fileName, undefined, { numeric: true });
  });
}

function DirectoryNode({
  depth,
  initialExpanded,
  onSelect,
  path,
  selectedPath,
  title,
}: {
  readonly depth: number;
  readonly initialExpanded: boolean;
  readonly onSelect: (path: string) => void;
  readonly path: string;
  readonly selectedPath: string;
  readonly title: string;
}) {
  const runtime = useAppServerRuntime();
  const snapshot = useAppServerSnapshot();
  const [expanded, setExpanded] = useState(initialExpanded);
  const directory = useQuery({
    queryKey: ["appserver-fs", snapshot.hostId, "directory", path],
    queryFn: () => runtime.resources.fileSystem.readDirectory(path),
    enabled: expanded,
    staleTime: 15_000,
  });

  return (
    <div className="workspace-file-tree__node">
      <button
        className="workspace-file-tree__row"
        data-selected={selectedPath === path || undefined}
        onClick={() => setExpanded((value) => !value)}
        style={{ paddingInlineStart: 8 + depth * 14 }}
        title={path}
        type="button"
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
        <span>{title}</span>
      </button>
      {expanded ? (
        <div role="group">
          {directory.isPending ? (
            <div className="workspace-file-tree__status" style={{ paddingInlineStart: 28 + depth * 14 }}>
              <LoaderCircle className="is-spinning" size={12} /> Loading…
            </div>
          ) : directory.isError ? (
            <div className="workspace-file-tree__status is-error" style={{ paddingInlineStart: 28 + depth * 14 }}>
              Directory unavailable
            </div>
          ) : sortedDirectoryEntries(directory.data?.entries ?? []).map((entry) => {
            const childPath = joinWorkspacePath(path, entry.fileName);
            if (entry.isDirectory) {
              return (
                <DirectoryNode
                  depth={depth + 1}
                  initialExpanded={selectedPath.startsWith(`${childPath}/`)}
                  key={childPath}
                  onSelect={onSelect}
                  path={childPath}
                  selectedPath={selectedPath}
                  title={entry.fileName}
                />
              );
            }
            return (
              <button
                className="workspace-file-tree__row is-file"
                data-selected={selectedPath === childPath || undefined}
                key={childPath}
                onClick={() => onSelect(childPath)}
                style={{ paddingInlineStart: 24 + (depth + 1) * 14 }}
                title={childPath}
                type="button"
              >
                <WorkspaceFileIcon path={childPath} size={13} />
                <span>{entry.fileName}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function useWorkspaceFileWatches(paths: readonly string[]) {
  const blobs = useBlobResources();
  const runtime = useAppServerRuntime();
  const snapshot = useAppServerSnapshot();
  const queryClient = useQueryClient();
  const key = paths.join("\u0000");

  useEffect(() => {
    let active = true;
    const leases: Array<{ dispose(): Promise<void> }> = [];
    const uniquePaths = [...new Set(paths.filter(Boolean))];
    void Promise.all(uniquePaths.map(async (path) => {
      const lease = await runtime.resources.fileSystem.watch(path, (changedPaths) => {
        void Promise.all(changedPaths.map(changed => blobs.invalidate(fileBlobResource(runtime, snapshot.hostId, changed)))).then(() => queryClient.invalidateQueries({
          queryKey: ["appserver-fs", snapshot.hostId],
        }));
      });
      if (!active) {
        await lease.dispose().catch(() => undefined);
        return;
      }
      leases.push(lease);
    })).catch(() => undefined);
    return () => {
      active = false;
      for (const lease of leases) void lease.dispose().catch(() => undefined);
    };
  }, [blobs, key, queryClient, runtime, snapshot.hostId]);
}

function useFuzzyWorkspaceFiles(roots: readonly string[], query: string) {
  const runtime = useAppServerRuntime();
  const [results, setResults] = useState<readonly FuzzyFileSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const sessionRef = useRef<Awaited<ReturnType<
    typeof runtime.resources.fileSystem.createFuzzyFileSearchSession
  >> | null>(null);
  const rootsKey = roots.join("\u0000");

  useEffect(() => {
    let active = true;
    setResults([]);
    void runtime.resources.fileSystem.createFuzzyFileSearchSession({
      roots,
      onUpdated(update) {
        if (active) setResults(update.files);
      },
      onCompleted() {
        if (active) setSearching(false);
      },
    }).then((session) => {
      if (!active) return session.stop();
      sessionRef.current = session;
      if (query.trim().length > 0) {
        setSearching(true);
        return session.update(query.trim());
      }
    }).catch(() => {
      if (active) setSearching(false);
    });
    return () => {
      active = false;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session !== null) void session.stop();
    };
  }, [rootsKey, runtime]);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length === 0) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      void sessionRef.current?.update(normalized).catch(() => setSearching(false));
    }, 100);
    return () => window.clearTimeout(timer);
  }, [query]);

  return { results, searching };
}

export function WorkspaceResourcePanel({ tab }: PanelRendererProps) {
  const blobs = useBlobResources();
  const initialLocation = useMemo(
    () => parseWorkspaceResource(tab.resource ?? ""),
    [tab.resource],
  );
  const runtime = useAppServerRuntime();
  const snapshot = useAppServerSnapshot();
  const queryClient = useQueryClient();
  const [selectedPath, setSelectedPath] = useState(initialLocation.path);
  const [searchQuery, setSearchQuery] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, WorkspaceDraft>>({});
  const [readProgress, setReadProgress] = useState<{ path: string; progress: BlobProgress } | null>(null);

  useEffect(() => {
    setSelectedPath(initialLocation.path);
    setEditingKey(null);
  }, [initialLocation.path]);

  const execution = snapshot.conversation?.execution;
  const roots = useMemo(() => workspaceRootsForResource(
    execution?.runtimeWorkspaceRoots ?? [],
    execution?.cwd ?? null,
    selectedPath,
  ), [execution?.cwd, execution?.runtimeWorkspaceRoots, selectedPath]);
  const watchPaths = useMemo(
    () => [...roots, workspacePathParent(selectedPath)],
    [roots, selectedPath],
  );
  useWorkspaceFileWatches(watchPaths);
  const search = useFuzzyWorkspaceFiles(roots, searchQuery);

  const resource = useQuery<LoadedWorkspaceResource>({
    queryKey: ["appserver-fs", snapshot.hostId, "resource", selectedPath, fileBlobResource(runtime, snapshot.hostId, selectedPath).scope],
    queryFn: async ({ signal }) => {
      const metadata = await runtime.resources.fileSystem.getMetadata(selectedPath, signal);
      if (!metadata.isFile) {
        return {
          blob: null,
          isDirectory: metadata.isDirectory,
          isFile: false,
          modifiedAtMs: metadata.modifiedAtMs,
          size: 0,
          text: null,
        };
      }
      const lease = acquireFileBlob(blobs, runtime, snapshot.hostId, selectedPath, { signal, priority: 2 });
      const report = () => setReadProgress({ path: selectedPath, progress: lease.getProgress() });
      report();
      const unsubscribe = lease.subscribe(report);
      let blob: Blob;
      try { blob = await lease.promise; } finally { unsubscribe(); lease.release(); }
      const bytes = blob.size > MAX_EDITABLE_FILE_BYTES || workspaceImageMime(selectedPath)
        ? null : new Uint8Array(await blob.arrayBuffer());
      return {
        blob,
        isDirectory: false,
        isFile: true,
        modifiedAtMs: metadata.modifiedAtMs,
        size: blob.size,
        text: bytes === null ? null : decodeWorkspaceText(bytes),
      };
    },
    enabled: selectedPath.length > 0,
    staleTime: 10_000,
    gcTime: 15_000,
    retry: false,
  });

  const [imageSource, setImageSource] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    const blob = resource.data?.blob;
    const mime = workspaceImageMime(selectedPath);
    if (!blob || !mime) { setImageSource(null); return; }
    const handle = fileBlobUrls.acquire(blob.slice(0, blob.size, mime));
    setImageSource({ blob, url: handle.source });
    return handle.release;
  }, [resource.data?.blob, selectedPath]);

  const fileKey = workspaceDraftKey(snapshot.hostId, selectedPath);
  const fileDraft = drafts[fileKey];
  const serverText = resource.data?.text ?? null;
  const text = fileDraft?.text ?? serverText ?? "";
  const dirty = fileDraft !== undefined && fileDraft.text !== fileDraft.baseText;
  const conflicted = dirty && workspaceDraftConflicted(fileDraft, serverText);
  const editing = editingKey === fileKey || dirty;
  const updateDraft = (nextText: string) => {
    if (serverText === null) return;
    setDrafts((current) => updateWorkspaceDraft(current, fileKey, serverText, nextText));
  };
  const revertDraft = () => {
    setDrafts((current) => {
      const next = { ...current };
      delete next[fileKey];
      return next;
    });
    setEditingKey(null);
  };

  const save = useMutation({
    mutationFn: async (target: { hostId: string; path: string; key: string; text: string }) => {
      await runtime.resources.fileSystem.writeFile(target.path, encodeBase64Text(target.text));
      await blobs.invalidate(fileBlobResource(runtime, target.hostId, target.path));
    },
    onSuccess: async (_result, target) => {
      await queryClient.invalidateQueries({
        queryKey: ["appserver-fs", target.hostId, "resource", target.path],
      });
      setDrafts((current) => reconcileWorkspaceSave(current, target.key, target.text));
      setEditingKey((current) => current === target.key ? null : current);
    },
  });
  const imageMime = workspaceImageMime(selectedPath);
  const language = workspaceFileLanguage(selectedPath);

  return (
    <div className="workspace-resource-panel">
      <aside className="workspace-file-browser">
        <label className="workspace-file-search">
          <Search size={13} />
          <input
            aria-label="Search workspace files"
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
            placeholder="Search files"
            value={searchQuery}
          />
          {search.searching ? <LoaderCircle className="is-spinning" size={12} /> : null}
        </label>
        <div className="workspace-file-tree">
          {searchQuery.trim().length > 0 ? (
            search.results.length === 0 && !search.searching ? (
              <div className="workspace-file-tree__empty">No matching files</div>
            ) : search.results.map((result) => {
              const path = joinWorkspacePath(result.root, result.path);
              return (
                <button
                  className="workspace-file-search-result"
                  key={`${result.root}:${result.path}`}
                  onClick={() => {
                    setSelectedPath(path);
                    setEditingKey(null);
                    setSearchQuery("");
                  }}
                  type="button"
                >
                  {result.match_type === "directory" ? <Folder size={14} /> : <WorkspaceFileIcon path={path} size={14} />}
                  <span><strong>{result.file_name}</strong><small>{result.path}</small></span>
                </button>
              );
            })
          ) : roots.map((root) => (
            <DirectoryNode
              depth={0}
              initialExpanded
              key={root}
              onSelect={(path) => { setSelectedPath(path); setEditingKey(null); }}
              path={root}
              selectedPath={selectedPath}
              title={workspaceResourceBasename(root)}
            />
          ))}
        </div>
      </aside>
      <section className="workspace-file-viewer">
        <header className="workspace-file-viewer__header">
          <WorkspaceFileIcon path={selectedPath} size={15} />
          <span>
            <strong>{workspaceResourceBasename(selectedPath)}</strong>
            <small>{selectedPath}</small>
          </span>
          {resource.data?.text !== null && resource.data?.text !== undefined ? (
            <div className="workspace-file-viewer__actions">
              {editing ? (
                <>
                  <button
                    disabled={!dirty || conflicted || save.isPending}
                    onClick={() => void save.mutateAsync({ hostId: snapshot.hostId, path: selectedPath, key: fileKey, text })}
                    title="Save file"
                    type="button"
                  ><Save size={14} /> Save</button>
                  <button
                    disabled={!dirty || save.isPending}
                    onClick={revertDraft}
                    title="Revert unsaved changes"
                    type="button"
                  ><RotateCcw size={14} /></button>
                </>
              ) : (
                <button onClick={() => setEditingKey(fileKey)} title="Edit file" type="button">
                  <Pencil size={14} /> Edit
                </button>
              )}
            </div>
          ) : null}
        </header>
        {resource.isPending ? (
          <div className="workspace-file-viewer__state"><LoaderCircle className="is-spinning" size={18} />
            {readProgress?.path !== selectedPath ? "Checking file…"
              : readProgress.progress.phase === "queued" ? "Queued for download…"
              : readProgress.progress.phase === "cache" ? "Checking cache…" : "Reading file…"}
          </div>
        ) : resource.isError ? (
          <div className="workspace-file-viewer__state is-error"><AlertTriangle size={18} />{resource.error.message}</div>
        ) : resource.data?.isDirectory ? (
          <div className="workspace-file-viewer__state"><FolderOpen size={20} />Select a file from this directory.</div>
        ) : imageMime !== null && resource.data?.blob && imageSource?.blob === resource.data.blob ? (
          <div className="workspace-file-viewer__image">
            <img alt={workspaceResourceBasename(selectedPath)} src={imageSource.url} />
            <small><ImageIcon size={12} /> {resource.data.size.toLocaleString()} bytes</small>
          </div>
        ) : resource.data?.text !== null && resource.data?.text !== undefined ? (
          <Suspense fallback={<div className="workspace-file-viewer__state"><LoaderCircle className="is-spinning" size={18} />Loading editor…</div>}>
            <WorkspaceCodeEditor
              editable={editing}
              hasDraft={dirty}
              key={fileKey}
              label={`${editing ? "Edit" : "View"} ${workspaceResourceBasename(selectedPath)}`}
              language={language}
              onChange={updateDraft}
              value={text}
            />
          </Suspense>
        ) : (
          <div className="workspace-file-viewer__state"><AlertTriangle size={18} />Binary or oversized file ({resource.data?.size.toLocaleString() ?? 0} bytes)</div>
        )}
        {conflicted ? <div className="workspace-file-save-error">File changed on disk. Revert your draft before saving.</div> : null}
        {save.isError ? <div className="workspace-file-save-error">{save.error.message}</div> : null}
      </section>
    </div>
  );
}
