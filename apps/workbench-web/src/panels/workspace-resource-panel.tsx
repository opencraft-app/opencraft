import { ExternalLinkIcon } from "@opencraft/design-system-web/action-icons";
import { createHtmlFilePreview, htmlFilePreviewAvailable } from "../runtime/html-file-preview";
import { Button, IconButton } from "@opencraft/design-system-web/button";
import { ZoomableImage } from "@opencraft/chat-render-web";
import { FolderIcon as Folder, FolderOpenIcon as FolderOpen, LoadingRingIcon as LoaderCircle, EditIcon as Pencil, ResetIcon as RotateCcw, SearchIcon as Search } from "@opencraft/design-system-web/action-icons";
import { FilePreviewView, MAX_FILE_PREVIEW_BYTES, useFilePreviewAvailable } from "@opencraft/file-preview-web";
import { preparePreviewResources } from "./prepare-preview-resources";
import { WebChatDocument } from "@opencraft/chat-render-web";
import { useAppearanceTheme } from "../appearance-theme";
import { createAppServerMediaSourceLoader } from "../runtime/appserver-media-loader";
import { useIntl } from "@opencraft/i18n/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parse, serialize, type DefaultTreeAdapterTypes } from "parse5";
import type { BlobProgress } from "@opencraft/blob-resources";
import type { FuzzyFileSearchResult } from "@opencraft/appserver-protocol/generated";
import type { PanelRendererProps } from "@opencraft/workbench-panels-react";
import { WarningIcon as AlertTriangle, DownloadIcon as Download, ImageIcon, SaveIcon as Save } from "@opencraft/design-system-web/action-icons";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  useAppServerRuntime,
  useAppServerSnapshot,
  useBlobResources,
} from "../runtime/appserver-runtime-context";
import { acquireFileBlob, fileBlobResource, fileBlobUrls, fileDownloadSize, fileDownloadUrl } from "../runtime/blob-files";
import {
  MAX_EDITABLE_FILE_BYTES,
  decodeWorkspaceText,
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
  writeWorkspaceResource,
  type WorkspaceSaveTarget,
} from "./workspace-resource-model";
import { WorkspaceFileIcon } from "./workspace-file-icon";
import { WorkspaceFileTree } from "./workspace-file-tree";
import { chatMediaKind } from "@opencraft/chat-render-react";
import { WorkspaceMediaPreview } from "./workspace-media-preview";

const WorkspaceCodeEditor = lazy(() => import("./workspace-code-editor").then((module) => ({ default: module.WorkspaceCodeEditor })));
import { WorkspacePdfPreviewLoader as WorkspacePdfPreview } from "./workspace-pdf-preview-loader";

interface LoadedWorkspaceResource {
  readonly previewTooLarge?: boolean;
  readonly blob: Blob | null;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly modifiedAtMs: number;
  readonly size: number;
  readonly text: string | null;
}

function useWorkspaceFileWatches(paths: readonly string[], hostId: string) {
  const blobs = useBlobResources();
  const runtime = useAppServerRuntime();
  const queryClient = useQueryClient();
  const key = paths.join("\u0000");

  useEffect(() => {
    let active = true;
    const leases: Array<{ dispose(): Promise<void> }> = [];
    const uniquePaths = [...new Set(paths.filter(Boolean))];
    if (runtime.resources.host.canRequest?.("fs/watch") === false) return;
    void Promise.all(uniquePaths.map(async (path) => {
      const lease = await runtime.resources.fileSystem.watch(path, (changedPaths) => {
        void Promise.all(changedPaths.map(changed => blobs.invalidate(fileBlobResource(runtime, hostId, changed)))).then(() => queryClient.invalidateQueries({
          queryKey: ["appserver-fs", hostId],
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
  }, [blobs, key, queryClient, runtime, hostId]);
}

function useFuzzyWorkspaceFiles(roots: readonly string[], query: string, enabled = true) {
  const runtime = useAppServerRuntime();
  const [results, setResults] = useState<readonly FuzzyFileSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [session, setSession] = useState<Awaited<ReturnType<
    typeof runtime.resources.fileSystem.createFuzzyFileSearchSession
  >> | null>(null);
  const rootsKey = roots.join("\u0000");
  const supported = runtime.resources.host.canRequest?.("fuzzyFileSearch/sessionStart") !== false;

  useEffect(() => {
    let active = true;
    let ownedSession: typeof session = null;
    setSession(null);
    setResults([]);
    if (!enabled || !supported) { setSearching(false); return; }
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
      ownedSession = session;
      setSession(session);
    }).catch(() => {
      if (active) setSearching(false);
    });
    return () => {
      active = false;
      if (ownedSession !== null) void ownedSession.stop();
    };
  }, [rootsKey, runtime, enabled, supported]);

  useEffect(() => {
    const normalized = query.trim();
    if (!enabled || !supported) { setSearching(false); return; }
    if (normalized.length === 0) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    if (session === null) return;
    const timer = window.setTimeout(() => {
      void session.update(normalized).catch(() => setSearching(false));
    }, 100);
    return () => window.clearTimeout(timer);
  }, [query, enabled, supported, session]);

  return { results, searching, supported };
}

export function WorkspaceResourcePreviewPanel(props: PanelRendererProps) {
  return <WorkspaceResourcePanel {...props} previewOnly />;
}

const htmlPreviewPolicy = "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
const htmlPreviewAnimationTags = new Set(["animate", "animateMotion", "animateTransform", "set", "discard"]);

function removeHtmlPreviewNavigation(document: DefaultTreeAdapterTypes.Document): void {
  const pending: DefaultTreeAdapterTypes.ParentNode[] = [document];
  while (pending.length > 0) {
    const parent = pending.pop()!;
    parent.childNodes = parent.childNodes.filter((child) => {
      if (!("tagName" in child)) return true;
      if (child.tagName === "meta" && child.attrs.some((attr) => attr.name === "http-equiv" && attr.value.trim().toLowerCase() === "refresh")) return false;
      // SVG animation can restore a stripped link destination without running script.
      if (htmlPreviewAnimationTags.has(child.tagName)) return false;
      if (child.tagName === "a" || child.tagName === "area") {
        child.attrs = child.attrs.filter((attr) => attr.name !== "href" && attr.name !== "ping" && attr.name !== "target");
      }
      pending.push(child);
      if ("content" in child) pending.push(child.content);
      return true;
    });
  }
}

function htmlPreviewDocument(source: string): string {
  const document = parse(source);
  removeHtmlPreviewNavigation(document);
  const sanitized = serialize(document);
  const doctype = /^<!doctype[^>]*>/iu.exec(sanitized)?.[0] ?? "";
  const policy = `<meta http-equiv="Content-Security-Policy" content="${htmlPreviewPolicy}">`;
  return `${doctype}${policy}${sanitized.slice(doctype.length)}`;
}

export function WorkspaceResourcePanel({ tab, ownerId, active, previewOnly = false }: PanelRendererProps & { readonly previewOnly?: boolean }) {
  const intl = useIntl();
  const blobs = useBlobResources();
  const theme = useAppearanceTheme();
  const initialLocation = useMemo(
    () => parseWorkspaceResource(tab.resource ?? ""),
    [tab.resource],
  );
  const runtime = useAppServerRuntime();
  const snapshot = useAppServerSnapshot();
  const queryClient = useQueryClient();
  const [selectedPath, setSelectedPath] = useState(initialLocation.path);
  const hasFilePreview = useFilePreviewAvailable(selectedPath);
  const downloadUrl = fileDownloadUrl(snapshot.hostId, selectedPath);
  const [sourceView, setSourceView] = useState<string | null>(null);
  const documentId = JSON.stringify(["file-preview", snapshot.hostId, selectedPath, fileBlobResource(runtime, snapshot.hostId, selectedPath).scope]);
  const showSource = sourceView === documentId;
  const [previewOpening, setPreviewOpening] = useState(false);
  const [externalPreviewError, setExternalPreviewError] = useState(false);
  const previewAttempt = useRef<{ controller: AbortController; window: Window } | null>(null);
  useEffect(() => {
    setPreviewOpening(false); setExternalPreviewError(false);
    return () => {
      const attempt = previewAttempt.current;
      previewAttempt.current = null;
      attempt?.controller.abort(); attempt?.window.close();
    };
  }, [documentId]);
  const openBrowserPreview = () => {
    if (previewAttempt.current) return;
    const target = window.open("about:blank", "_blank");
    if (!target) { setExternalPreviewError(true); return; }
    target.opener = null;
    const attempt = { controller: new AbortController(), window: target };
    previewAttempt.current = attempt;
    setPreviewOpening(true); setExternalPreviewError(false);
    void createHtmlFilePreview(snapshot.hostId, selectedPath, attempt.controller.signal).then(entry => {
      if (previewAttempt.current !== attempt) return;
      if (!target.closed) target.location.replace(new URL(entry, window.location.href).href);
    }).catch(() => {
      target.close();
      if (previewAttempt.current === attempt) setExternalPreviewError(true);
    }).finally(() => {
      if (previewAttempt.current === attempt) { previewAttempt.current = null; setPreviewOpening(false); }
    });
  };
  const loadMediaSource = useMemo(
    () => createAppServerMediaSourceLoader(runtime, blobs, snapshot.hostId),
    [runtime, blobs, snapshot.hostId],
  );
  // Start focused on the preview. Visibility belongs to this panel and stays
  // unchanged while browsing files; toggling never remounts the viewer.
  const [fileTreeOpen, setFileTreeOpen] = useState(false);
  const fileTreeId = useId();
  const treeToggleLabel = intl.formatMessage(fileTreeOpen
    ? { id: "panel.hideFileTree", defaultMessage: "Hide file tree" }
    : { id: "panel.showFileTree", defaultMessage: "Show file tree" });
  const [searchQuery, setSearchQuery] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, WorkspaceDraft>>({});
  const [readProgress, setReadProgress] = useState<{ path: string; progress: BlobProgress } | null>(null);

  useEffect(() => {
    setSelectedPath(initialLocation.path);
    setEditingKey(null);
  }, [initialLocation.path]);

  const execution = snapshot.conversation?.execution;
  const rootsKey = (previewOnly ? [] : workspaceRootsForResource(
    execution?.runtimeWorkspaceRoots ?? [],
    execution?.cwd ?? null,
    selectedPath,
  )).join("\u0000");
  const roots = useMemo(() => rootsKey.length === 0 ? [] : rootsKey.split("\u0000"), [rootsKey]);
  const watchPaths = useMemo(
    () => previewOnly ? [] : [...roots, workspacePathParent(selectedPath)],
    [roots, selectedPath, previewOnly],
  );
  useWorkspaceFileWatches(watchPaths, snapshot.hostId);
  const search = useFuzzyWorkspaceFiles(roots, searchQuery, !previewOnly);
  const selectFile = useCallback((path: string) => {
    setSelectedPath(path);
    setEditingKey(null);
    setSearchQuery("");
  }, []);

  const resource = useQuery<LoadedWorkspaceResource>({
    queryKey: ["appserver-fs", snapshot.hostId, "resource", selectedPath, fileBlobResource(runtime, snapshot.hostId, selectedPath).scope, hasFilePreview, downloadUrl],
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
      if (hasFilePreview && downloadUrl) {
        const size = await fileDownloadSize(downloadUrl, signal);
        if (size > MAX_FILE_PREVIEW_BYTES) return {
          blob: null, isDirectory: false, isFile: true, modifiedAtMs: metadata.modifiedAtMs,
          size, text: null, previewTooLarge: true,
        };
      }
      const lease = acquireFileBlob(blobs, runtime, snapshot.hostId, selectedPath, { signal, priority: 2 });
      const report = () => setReadProgress({ path: selectedPath, progress: lease.getProgress() });
      report();
      const unsubscribe = lease.subscribe(report);
      let blob: Blob;
      try { blob = await lease.promise; } finally { unsubscribe(); lease.release(); }
      const bytes = blob.size > MAX_EDITABLE_FILE_BYTES || hasFilePreview || chatMediaKind(selectedPath) !== "file"
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

  const [fileSource, setFileSource] = useState<{
    blob: Blob;
    url: string;
    documentId: string;
  } | null>(null);
  useEffect(() => {
    const blob = resource.data?.blob;
    const mime = workspaceImageMime(selectedPath);
    if (!blob) {
      setFileSource(null);
      return;
    }
    const handle = fileBlobUrls.acquire(mime ? blob.slice(0, blob.size, mime) : blob);
    setFileSource({ blob, url: handle.source, documentId });
    return handle.release;
  }, [resource.data?.blob, selectedPath, documentId]);
  const canDownload = (downloadUrl !== null && resource.data?.isDirectory !== true) || (
    !resource.isError &&
    resource.data?.isFile === true &&
    fileSource?.documentId === documentId &&
    fileSource.blob === resource.data.blob);

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
    mutationFn: (target: WorkspaceSaveTarget) => writeWorkspaceResource(
      previewOnly,
      target,
      (path, content) => runtime.resources.fileSystem.writeFile(path, content),
      (hostId, path) => blobs.invalidate(fileBlobResource(runtime, hostId, path)),
    ),
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
  const htmlPreview = useMemo(() => language === "html" ? htmlPreviewDocument(text) : null, [language, text]);

  return (
    <div className="workspace-resource-panel" data-preview-only={previewOnly || undefined} data-tree-collapsed={!fileTreeOpen || undefined}>
      {!previewOnly ? <aside className="workspace-file-browser" id={fileTreeId} hidden={!fileTreeOpen}>
        <label className="workspace-file-search">
          <Search size={13} />
          <input
            aria-label="Search workspace files"
            disabled={!search.supported}
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
            placeholder="Search files"
            value={searchQuery}
          />
          {search.searching ? <LoaderCircle className="is-spinning" size={12} /> : null}
        </label>
        <div className="workspace-file-tree" hidden={!search.supported || searchQuery.trim().length === 0}>
          {search.supported && searchQuery.trim().length > 0 ? (
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
          ) : null}
        </div>
        <WorkspaceFileTree
          key={snapshot.hostId}
          fileSystem={runtime.resources.fileSystem}
          hidden={search.supported && searchQuery.trim().length > 0}
          hostId={snapshot.hostId}
          roots={roots}
          selectedPath={selectedPath}
          onSelect={selectFile}
        />
      </aside> : null}
      <section className="workspace-file-viewer">
        <header className="workspace-file-viewer__header">
          {!previewOnly ? <IconButton
            className="chrome-button workspace-file-tree-toggle"
            type="button"
            aria-label={treeToggleLabel}
            title={treeToggleLabel}
            aria-expanded={fileTreeOpen}
            aria-controls={fileTreeId}
            onClick={() => setFileTreeOpen(!fileTreeOpen)}
          >
            {fileTreeOpen ? <FolderOpen size={16} /> : <Folder size={16} />}
          </IconButton> : null}
          <WorkspaceFileIcon path={selectedPath} size={15} />
          <span>
            <strong>{workspaceResourceBasename(selectedPath)}</strong>
            <small>{selectedPath}</small>
          </span>
          {(language === "markdown" || language === "html") && resource.data?.text != null && !editing ? (
            <div className="workspace-file-viewer__actions">
              <button aria-pressed={!showSource} onClick={() => setSourceView(null)} type="button">
                {intl.formatMessage({ id: "panel.markdownPreview", defaultMessage: "Preview" })}
              </button>
              <button aria-pressed={showSource} onClick={() => setSourceView(documentId)} type="button">
                {intl.formatMessage({ id: "panel.markdownSource", defaultMessage: "Source" })}
              </button>
            </div>
          ) : null}
          {!previewOnly && resource.data?.text !== null && resource.data?.text !== undefined ? (
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
          {!resource.data?.isDirectory ? <div className="workspace-file-viewer__actions">
            {htmlFilePreviewAvailable(snapshot.hostId, selectedPath) ? <IconButton
              type="button"
              aria-label={intl.formatMessage({ id: "chat.link.openInBrowser", defaultMessage: "Open in browser" })}
              title={intl.formatMessage({ id: "chat.link.openInBrowser", defaultMessage: "Open in browser" })}
              disabled={previewOpening}
              onClick={openBrowserPreview}
            >{previewOpening ? <LoaderCircle className="is-spinning" size={14} /> : <ExternalLinkIcon size={14} />}</IconButton> : null}
            <a
              role="link"
              aria-label={intl.formatMessage({ id: "panel.downloadFile", defaultMessage: "Download file" })}
              title={intl.formatMessage({ id: "panel.downloadFile", defaultMessage: "Download file" })}
              aria-disabled={!canDownload || undefined}
              tabIndex={canDownload ? undefined : -1}
              href={canDownload ? downloadUrl ?? fileSource?.url : undefined}
              download={workspaceResourceBasename(selectedPath)}
            ><Download size={14} aria-hidden="true" /></a>
          </div> : null}
        </header>
        {externalPreviewError ? <p className="workspace-file-viewer__external-error" role="alert">
          {intl.formatMessage({ id: "preview.externalUnavailable", defaultMessage: "Could not open the preview. Try again or download the original file." })}
        </p> : null}
        {resource.isPending ? (
          <div className="workspace-file-viewer__state"><LoaderCircle className="is-spinning" size={18} />
            {previewOnly ? intl.formatMessage({ id: "panel.readingFile", defaultMessage: "Loading file…" })
              : readProgress?.path !== selectedPath ? "Checking file…"
              : readProgress.progress.phase === "queued" ? "Queued for download…"
              : readProgress.progress.phase === "cache" ? "Checking cache…" : "Reading file…"}
          </div>
        ) : resource.isError ? (
          <div className="workspace-file-viewer__state is-error"><AlertTriangle size={18} />{resource.error.message}</div>
        ) : resource.data?.isDirectory ? (
          <div className="workspace-file-viewer__state"><FolderOpen size={20} />{intl.formatMessage(previewOnly ? { id: "panel.directoryHint", defaultMessage: "Choose a file link in the conversation to preview its contents." } : { id: "panel.selectFile", defaultMessage: "Select a file from this directory." })}</div>
        ) : resource.data?.previewTooLarge ? (
          <div className="workspace-file-viewer__state" role="status">
            {intl.formatMessage({ id: "preview.tooLarge", defaultMessage: "This file is too large to preview (25 MB limit). Download it to view." })}
          </div>
        ) : imageMime !== null && resource.data?.blob && fileSource?.blob === resource.data.blob && fileSource.documentId === documentId ? (
          <div className="workspace-file-viewer__image">
            <ZoomableImage fitToContainer key={documentId} alt={workspaceResourceBasename(selectedPath)} src={fileSource.url} />
            <small><ImageIcon size={12} /> {resource.data.size.toLocaleString()} bytes</small>
          </div>
        ) : hasFilePreview && resource.data?.blob ? (
          <FilePreviewView key={documentId} ownerId={ownerId} tabId={tab.id} resource={documentId}
            blob={resource.data.blob} name={workspaceResourceBasename(selectedPath)}
            onOpenLink={url => window.open(url, "_blank", "noopener,noreferrer")} active={active} dark={theme.resolvedTheme === "dark"} prepare={preparePreviewResources} />
        ) : chatMediaKind(selectedPath) === "pdf" && resource.data?.blob ? (
          <Suspense fallback={<div className="workspace-file-viewer__state"><LoaderCircle className="is-spinning" size={18} />{intl.formatMessage({ id: "pdf.loading", defaultMessage: "Loading PDF…" })}</div>}>
            <WorkspacePdfPreview key={fileKey} blob={resource.data.blob} name={workspaceResourceBasename(selectedPath)} />
          </Suspense>
        ) : (chatMediaKind(selectedPath) === "audio" || chatMediaKind(selectedPath) === "video") && resource.data?.blob ? (
          <WorkspaceMediaPreview key={fileKey} blob={resource.data.blob} name={workspaceResourceBasename(selectedPath)} kind={chatMediaKind(selectedPath) === "audio" ? "audio" : "video"} />
        ) : resource.data?.text !== null && resource.data?.text !== undefined ? (
          <Suspense fallback={<div className="workspace-file-viewer__state"><LoaderCircle className="is-spinning" size={18} />Loading editor…</div>}>
            {language === "markdown" && !showSource && !editing ? (
              <div className="workspace-file-markdown">
                <WebChatDocument
                  key={documentId}
                  documentId={documentId}
                  source={text}
                  hostId={snapshot.hostId}
                  cwd={workspacePathParent(selectedPath)}
                  theme={theme.resolvedTheme}
                  allowWideBlocks={false}
                  loadMediaSource={loadMediaSource}
                  onOpenResource={(target, decision) => {
                    if (decision.kind === "file" || decision.kind === "workspace-file") {
                      setSelectedPath(parseWorkspaceResource(target).path);
                    } else if (decision.kind === "external" || decision.kind === "mail") {
                      window.open(target, "_blank", "noopener,noreferrer");
                    }
                  }}
                />
              </div>
            ) : language === "html" && !showSource && !editing && htmlPreview !== null ? (
              <iframe
                className="workspace-file-html"
                key={documentId}
                referrerPolicy="no-referrer"
                sandbox=""
                srcDoc={htmlPreview}
                title={`${workspaceResourceBasename(selectedPath)} ${intl.formatMessage({ id: "panel.markdownPreview", defaultMessage: "Preview" })}`}
              />
            ) : previewOnly && (language === "markdown" || language === "html") ? (
              <pre
                className="workspace-file-source"
                tabIndex={0}
                role="region"
                aria-label={intl.formatMessage({ id: "panel.markdownSource", defaultMessage: "Source" })}
              ><code>{text}</code></pre>
            ) : (
              <WorkspaceCodeEditor
                editable={editing}
                hasDraft={dirty}
                key={fileKey}
                label={`${editing ? "Edit" : "View"} ${workspaceResourceBasename(selectedPath)}`}
                language={language}
                onChange={updateDraft}
                value={text}
              />
            )}
          </Suspense>
        ) : resource.data?.blob && htmlFilePreviewAvailable(snapshot.hostId, selectedPath) ? (
          <div className="workspace-file-viewer__state workspace-file-viewer__external-report">
            <p>{intl.formatMessage({ id: "preview.externalHint", defaultMessage: "Open this HTML report in your browser to view its contents and interactive controls." })}</p>
            <Button type="button" disabled={previewOpening} onClick={openBrowserPreview}>
              <ExternalLinkIcon size={16} />
              {intl.formatMessage({ id: "chat.link.openInBrowser", defaultMessage: "Open in browser" })}
            </Button>
          </div>
        ) : resource.data?.blob ? (
          <WorkspaceMediaPreview key={fileKey} blob={resource.data.blob} name={workspaceResourceBasename(selectedPath)} kind="file" />
        ) : (
          <div className="workspace-file-viewer__state"><AlertTriangle size={18} />{intl.formatMessage({ id: "panel.unsupportedFile", defaultMessage: "Preview unavailable for this file type or size." })}</div>
        )}
        {conflicted ? <div className="workspace-file-save-error">File changed on disk. Revert your draft before saving.</div> : null}
        {save.isError ? <div className="workspace-file-save-error">{save.error.message}</div> : null}
      </section>
    </div>
  );
}
