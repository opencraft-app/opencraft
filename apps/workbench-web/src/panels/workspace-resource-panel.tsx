import {
  workspaceFileRuntime,
  isWorkspaceFileRuntime,
  unavailableWorkspaceFiles,
} from "../runtime/workspace-file-runtime";
import type { AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import "./workspace-resource-panel.scss";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import { workspaceQueryAffected, workspaceWatchPool } from "./workspace-resource-access";
import { CopyIcon, MoreIcon, ExternalLinkIcon } from "@opencraft/design-system-web/action-icons";
import { htmlFilePreviewUrl, htmlFilePreviewAvailable } from "../runtime/html-file-preview";
import { Button, IconButton, DisclosureButton } from "@opencraft/design-system-web/button";
const ZoomableImage = lazy(() => import("@opencraft/chat-render-web/zoomable-image").then((module) => ({ default: module.ZoomableImage })));
import { FolderIcon as Folder, FolderOpenIcon as FolderOpen, LoadingRingIcon as LoaderCircle, EditIcon as Pencil, ResetIcon as RotateCcw, SearchIcon as Search } from "@opencraft/design-system-web/action-icons";
import { FilePreviewView, MAX_FILE_PREVIEW_BYTES, useFilePreviewAvailable } from "@opencraft/file-preview-web";
import { preparePreviewResources } from "./prepare-preview-resources";
import { WebChatDocument } from "@opencraft/chat-render-web";
import { useAppearanceTheme } from "../appearance-theme";
import { createAppServerMediaSourceLoader } from "../runtime/appserver-media-loader";
import { useIntl } from "@opencraft/i18n/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parse, parseFragment, serialize, type DefaultTreeAdapterTypes } from "parse5";
import { WorkspaceSessions } from "./workspace-sessions";
import { useWorkspaceSearch } from "./workspace-search";
import { useOptionalAsyncNotices } from "../components/async-notices-context";
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
  useSyncExternalStore,
  useLayoutEffect,
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
  workspaceDraftConflicted,
  workspaceDraftKey,
  workspaceFileLanguage,
  workspaceImageMime,
  workspacePathParent,
  workspaceResourceBasename,
  workspaceRootsForResource,
  encodeBase64Text,
  decodeBase64Bytes,
  type WorkspaceResourceLocation,
} from "./workspace-resource-model";
import { WorkspaceDirectory } from "./workspace-directory";
import { FileFolderArtwork as WorkspaceFolderIcon } from "@opencraft/design-system-web/action-icons";
import { ChevronLeftIcon } from "@opencraft/design-system-web/action-icons";
import { WorkspaceFileIcon } from "./workspace-file-icon";
import { WorkspaceFileTree } from "./workspace-file-tree";
import { WorkspaceFilePath } from "./workspace-file-path";
import { chatMediaKind } from "@opencraft/chat-render-react";
import { WorkspaceMediaPreview } from "./workspace-media-preview";

const WorkspaceCodeEditor = lazy(() => import("./workspace-code-editor").then((module) => ({ default: module.WorkspaceCodeEditor })));
import { BrowserAnnotationLayer } from "../browser-annotation/annotation-layer-lazy";
import { BrowserAnnotationToggle } from "../browser-annotation/annotation-toggle";
import { useFilePreviewAnnotation } from "../browser-annotation/use-file-preview-annotation";
import { useWorkbenchPresentationRoot } from "../components/workbench-presentation-root";
import { useTouchBrowserLayout } from "../components/use-touch-browser-layout";

interface LoadedWorkspaceResource {
  readonly previewTooLarge?: boolean;
  readonly blob: Blob | null;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly modifiedAtMs: number;
  readonly size: number;
  readonly text: string | null;
}

function useWorkspaceFileWatches(
  runtime: AppServerWorkbenchRuntime,
  paths: readonly string[], hostId: string, scope: string) {
  const blobs = useBlobResources();
  const queryClient = useQueryClient();
  const key = paths.join("\u0000");

  useEffect(() => {
    if (isWorkspaceFileRuntime(runtime) || runtime.resources.host.canRequest?.("fs/watch") === false) return;
    const pool = workspaceWatchPool(queryClient);
    const releases = [...new Set(paths.filter(Boolean))].map((path) => pool.acquire(runtime.resources.fileSystem, scope, path, (changedPaths) => {
        void Promise.all(changedPaths.map((changed) => blobs.invalidate({ scope, path: changed })))
        .then(() => queryClient.invalidateQueries({ predicate: (query) => workspaceQueryAffected(query.queryKey, hostId, scope, changedPaths) }))
        .catch(() => undefined);
    }));
    return () => { for (const release of releases) release(); };
  }, [blobs, key, queryClient, runtime, hostId, scope]);
}

export function WorkspaceResourcePreviewPanel(props: PanelRendererProps) {
  return <WorkspaceResourcePanel {...props} previewOnly />;
}

const htmlPreviewPolicy = "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
const htmlPreviewAnimationTags = new Set(["animate", "animateMotion", "animateTransform", "set", "discard"]);

function removeHtmlPreviewNavigation(document: DefaultTreeAdapterTypes.Document): void {
  const pending: DefaultTreeAdapterTypes.ParentNode[] = [document];
  while (pending.length > 0) {
    const parent = pending.pop()!;
    parent.childNodes = parent.childNodes.filter((child) => {
      if (!("tagName" in child)) return true;
      // Only the host-injected annotation agent may execute in this sandbox.
      if (child.tagName === "script") return false;
      child.attrs = child.attrs.filter((attr) => {
        if (/^on/iu.test(attr.name) || attr.name === "srcdoc" || attr.name === "srcset") return false;
        // Avoid speculative fetches before CSP admission. Local SVG fragments
        // and embedded bytes remain useful; original source/download is unchanged.
        if (["src", "href", "poster", "background", "data"].includes(attr.name)) return /^(?:#|data:|blob:)/iu.test(attr.value.trim());
        return true;
      });
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
  const html = document.childNodes.find(
    (node) => "tagName" in node && node.tagName === "html") as DefaultTreeAdapterTypes.Element;
  const head = html.childNodes.find(
    (node) => "tagName" in node && node.tagName === "head") as DefaultTreeAdapterTypes.Element;
  const policy = parseFragment(`<meta http-equiv="Content-Security-Policy" content="${htmlPreviewPolicy}">`)
    .childNodes[0] as DefaultTreeAdapterTypes.Element;
  policy.parentNode = head; head.childNodes.unshift(policy);
  return serialize(document);
}

export function WorkspaceResourcePanel({ tab, ownerId = "standalone", active, previewOnly = false, sessions: suppliedSessions, onSessionChange }: PanelRendererProps & {
  readonly previewOnly?: boolean;
  readonly sessions?: WorkspaceSessions;
  readonly onSessionChange?: (location: WorkspaceResourceLocation, dirty: boolean) => void;
}) {
  const intl = useIntl();
  const blobs = useBlobResources();
  const theme = useAppearanceTheme();
  const hostRuntime = useAppServerRuntime();
  const snapshot = useAppServerSnapshot();
  const rawThread = tab.durableRoute?.params.workspaceFileThreadId;
  const fileThreadId = typeof rawThread === "string" && rawThread ? rawThread : undefined;
  const generation = hostRuntime.resources.host.getConnectionGeneration?.() ?? 0;
  const fileScope = useQuery({
    queryKey: [
      "workspace-file-scope",
      snapshot.hostId,
      fileThreadId,
      fileBlobResource(hostRuntime, snapshot.hostId, "").scope,
    ],
    enabled: !!fileThreadId && snapshot.phase === "ready",
    retry: false,
    queryFn: async ({ signal }) => {
      if (!fileThreadId || !hostRuntime.resources.workspaceFiles) throw Error("Workspace files unavailable");
      const binding = await hostRuntime.resources.workspaceFiles.open(fileThreadId, signal);
      return { binding, owner: hostRuntime, threadId: fileThreadId, generation };
    },
  });
  const selectedFiles =
    fileScope.data?.owner === hostRuntime &&
    fileScope.data.threadId === fileThreadId &&
    fileScope.data.generation === generation &&
    !fileScope.isError
      ? fileScope.data.binding
      : undefined;
  const runtime = useMemo(
    () =>
      fileThreadId ? workspaceFileRuntime(hostRuntime, selectedFiles?.files ?? unavailableWorkspaceFiles) : hostRuntime,
    [hostRuntime, fileThreadId, generation, selectedFiles],
  );
  const queryClient = useQueryClient();
  const notices = useOptionalAsyncNotices();
  // Standalone embedded previews have a private lifetime; full Workbench supplies its owner.
  const [privateSessions] = useState(() => new WorkspaceSessions());
  const sessions = suppliedSessions ?? privateSessions;
  useEffect(() => () => privateSessions.dispose(), [privateSessions]);
  const hostId = snapshot.hostId;
  // Drafts share an owner, but must never share a document across workspaces.
  const sessionHostId = fileThreadId ? JSON.stringify([hostId, fileThreadId]) : hostId;
  const restored = tab.durableRoute?.params.location;
  const browser = sessions.browser(ownerId,
    sessionHostId, tab.id, typeof restored === "string" ? restored : (tab.resource ?? ""),
  );
  const revision = useSyncExternalStore(
    useCallback((listener) => sessions.subscribe(ownerId, sessionHostId, listener), [sessions, ownerId, sessionHostId]),
    () => sessions.revision(ownerId, sessionHostId), () => 0);
  const changed = () => sessions.changed(ownerId, sessionHostId);
  const selectedPath = browser.location.path;
  const openLocation = useCallback((location: WorkspaceResourceLocation) => {
    browser.location = location; browser.visited.add(location.path);
    if (location.line !== null) browser.source = location.path;
    sessions.changed(ownerId, sessionHostId);
    },
    [browser, sessions, ownerId, sessionHostId]);
  const selectFile = useCallback((path: string) => openLocation({ path, line: null, column: null }), [openLocation]);
  const dirtyPaths = sessions.dirtyPaths(ownerId, sessionHostId, tab.id);
  useLayoutEffect(() => { onSessionChange?.(browser.location, dirtyPaths.length > 0); }, [revision, browser, onSessionChange]);
  useEffect(() => {
    if (!dirtyPaths.length) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirtyPaths.length]);
  const hasFilePreview = useFilePreviewAvailable(selectedPath);
  const mediaKind = chatMediaKind(selectedPath);
  const downloadUrl = isWorkspaceFileRuntime(runtime) ? null : fileDownloadUrl(snapshot.hostId, selectedPath);
  const setSourceView = (value: string | null) => { browser.source = value === null ? null : selectedPath; changed(); };
  const documentId = JSON.stringify(["file-preview", snapshot.hostId, selectedPath, fileBlobResource(runtime, snapshot.hostId, selectedPath).scope]);
  const showSource = browser.source === selectedPath;
  const readScope = fileBlobResource(runtime, hostId, selectedPath).scope;
  const [externalPreviewError, setExternalPreviewError] = useState(false);
  useEffect(() => setExternalPreviewError(false), [documentId]);
  const openBrowserPreview = () => {
    setExternalPreviewError(false);
    try {
      if (isWorkspaceFileRuntime(runtime)) throw Error("External workspace preview unavailable");
      window.open(new URL(htmlFilePreviewUrl(snapshot.hostId, selectedPath), window.location.href).href,
        "_blank", "noopener,noreferrer");
    } catch { setExternalPreviewError(true); }
  };
  const loadMediaSource = useMemo(
    () => createAppServerMediaSourceLoader(runtime, blobs, snapshot.hostId),
    [runtime, blobs, snapshot.hostId, snapshot.connectionGeneration],
  );
  // Start focused on the preview. Visibility belongs to this panel and stays
  // unchanged while browsing files; toggling never remounts the viewer.
  const fileTreeOpen = browser.treeOpen;
  const setFileTreeOpen = (value: boolean) => { browser.treeOpen = value; changed(); };
  const fileTreeId = useId();
  const treeToggleLabel = intl.formatMessage(fileTreeOpen
    ? { id: "panel.hideFileTree", defaultMessage: "Hide file tree" }
    : { id: "panel.showFileTree", defaultMessage: "Show file tree" });
  const searchQuery = browser.query;
  const setSearchQuery = (value: string) => { browser.query = value; changed(); };
  const setEditingKey = (value: string | null) => { if (value === null) browser.editing.delete(workspaceDraftKey(hostId, selectedPath)); else browser.editing.add(value); changed(); };

  const execution = snapshot.conversation?.execution;
  const rootsKey = (previewOnly ? [] : workspaceRootsForResource(
          fileThreadId
            ? selectedFiles?.location.kind === "workspace"
              ? [selectedFiles.location.root]
              : []
            : (execution?.runtimeWorkspaceRoots ?? []),
          fileThreadId
            ? selectedFiles?.location.kind === "workspace"
              ? selectedFiles.location.root
              : null
            : (execution?.cwd ?? null),
    selectedPath,
  )).join("\u0000");
  const roots = useMemo(() => (rootsKey.length === 0 ? [] : rootsKey.split("\u0000")), [rootsKey]);
  const watchPaths = useMemo(
    () => (previewOnly ? [] : [...roots, selectedPath, workspacePathParent(selectedPath)]),
    [roots, selectedPath, previewOnly],
  );
  useWorkspaceFileWatches(runtime, watchPaths, snapshot.hostId, readScope);
  const searchSupported =
    !isWorkspaceFileRuntime(runtime) &&
    roots.length > 0 && runtime.resources.host.canRequest?.("fuzzyFileSearch/sessionStart") !== false;
  const search = useWorkspaceSearch(runtime.resources.fileSystem, roots, searchQuery, readScope, !previewOnly, searchSupported);

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
      let blob: Blob;
      try { blob = await lease.promise; } finally { lease.release(); }
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
    enabled: selectedPath.length > 0 && (!fileThreadId || !!selectedFiles || fileScope.isError),
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
  const doc = sessions.document(ownerId, sessionHostId, selectedPath);
  const fileDraft = doc?.draft ?? undefined;
  const serverText = resource.data?.text ?? null;
  useLayoutEffect(() => {
    if (serverText !== null) sessions.observe(ownerId, sessionHostId, selectedPath, serverText);
  }, [sessions, ownerId, sessionHostId, selectedPath, serverText]);
  const text = fileDraft?.text ?? doc?.baseText ?? serverText ?? "";
  const dirty = fileDraft !== undefined;
  const conflicted = dirty && (doc?.error === "conflict" || workspaceDraftConflicted(fileDraft, doc?.baseText ?? serverText));
  const editing = browser.editing.has(fileKey) || dirty;
  const updateDraft = (nextText: string) => { browser.editing.add(fileKey); sessions.edit(ownerId, sessionHostId, selectedPath, nextText); };
  const revertDraft = () => { sessions.discard(ownerId, sessionHostId, selectedPath); setEditingKey(null); };
  const saveFile = async () => {
    if (previewOnly || runtime.resources.host.canRequest?.("fs/writeFile") === false) return;
    const path = selectedPath;
    try {
      await sessions.save(ownerId,
        sessionHostId, path,
        async () => decodeWorkspaceText(decodeBase64Bytes((await runtime.resources.fileSystem.readFile(path)).dataBase64)),
        async (submitted) => { if (fileBlobResource(runtime, hostId, path).scope !== readScope) throw new Error("File connection changed"); await runtime.resources.fileSystem.writeFile(path, encodeBase64Text(submitted)); });
      // A successful write stays successful even if subsequent cache refresh fails.
      await blobs.invalidate({ scope: readScope, path }).catch(() => undefined);
      await queryClient.invalidateQueries({ queryKey: ["appserver-fs", hostId, "resource", path, readScope] }).catch(() => undefined);
    } catch {
      notices?.error({ key: `workspace-save:${hostId}:${path}`,
        message: intl.formatMessage({
          id: "files.saveFailed",
          defaultMessage: "Could not save the file. Your changes are kept.",
        }),
      });
    }
  };
  const canWrite = !previewOnly && runtime.resources.host.canRequest?.("fs/writeFile") !== false;
  const imageMime = workspaceImageMime(selectedPath);
  const language = workspaceFileLanguage(selectedPath);
  const htmlPreview = useMemo(() => (language === "html" ? htmlPreviewDocument(text) : null), [language, text]);
  const htmlFrame = useRef<HTMLIFrameElement | null>(null);
  const htmlVisible = language === "html" && !showSource && !editing && htmlPreview !== null;
  const htmlAnnotation = useFilePreviewAnnotation({
    frame: htmlFrame,
    html: htmlVisible ? htmlPreview : null,
    hostId,
    path: selectedPath,
    tabId: tab.id,
  });
  const presentationRoot = useWorkbenchPresentationRoot();
  const touchLayout = useTouchBrowserLayout();

  return (
    <div
      className="workspace-resource-panel"
      data-preview-only={previewOnly || undefined}
      data-tree-collapsed={!fileTreeOpen || undefined}
    >
      {!previewOnly ? (
        <aside className="workspace-file-browser" id={fileTreeId} hidden={!fileTreeOpen}>
          <label className="workspace-file-search">
            <Search size={13} />
            <input
              aria-label={intl.formatMessage({ id: "files.search", defaultMessage: "Search workspace files" })}
              disabled={!searchSupported}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder={intl.formatMessage({ id: "files.searchPlaceholder", defaultMessage: "Search files" })}
              value={searchQuery}
            />
            {searchQuery ? (
              <IconButton
                aria-label={intl.formatMessage({ id: "files.clearSearch", defaultMessage: "Clear search" })}
                onClick={() => setSearchQuery("")}
              >
                <RotateCcw size={12} />
              </IconButton>
            ) : null}
            {search.status === "searching" ? <LoaderCircle className="is-spinning" size={12} /> : null}
          </label>
          {dirtyPaths.length ? (
            <div
              className="workspace-file-drafts"
              aria-label={intl.formatMessage({ id: "files.unsaved", defaultMessage: "Unsaved changes" })}
            >
              {dirtyPaths.map((path) => (
                <Button key={path} variant="ghost" onClick={() => selectFile(path)}>
                  {workspaceResourceBasename(path)} •
                </Button>
              ))}
            </div>
          ) : null}
          <div className="workspace-file-tree" hidden={!searchSupported || searchQuery.trim().length === 0}>
            {search.status === "error" ? (
              <Button onClick={search.retry}>
                {intl.formatMessage({ id: "files.searchFailed", defaultMessage: "Search failed. Retry" })}
              </Button>
            ) : searchSupported && searchQuery.trim().length > 0 ? (
              search.results.length === 0 && !(search.status === "searching") ? (
                <div className="workspace-file-tree__empty">
                  {intl.formatMessage({ id: "files.noMatches", defaultMessage: "No matching files" })}
                </div>
              ) : (
                search.results.map((result) => {
                  const path = joinWorkspacePath(result.root, result.path);
                  return (
                    <button
                      className="workspace-file-search-result"
                      key={`${result.root}:${result.path}`}
                      onClick={() => selectFile(path)}
                      type="button"
                    >
                      {result.match_type === "directory" ? (
                        <Folder size={14} />
                      ) : (
                        <WorkspaceFileIcon path={path} size={14} />
                      )}
                      <span>
                        <strong>{result.file_name}</strong>
                        <small>{result.path}</small>
                      </span>
                    </button>
                  );
                })
              )
            ) : null}
          </div>
          <WorkspaceFileTree
            key={snapshot.hostId}
            fileSystem={runtime.resources.fileSystem}
            readScope={readScope}
            session={browser}
            hidden={searchSupported && searchQuery.trim().length > 0}
            hostId={snapshot.hostId}
            roots={roots}
            selectedPath={selectedPath}
            onSelect={selectFile}
          />
        </aside>
      ) : null}
      <section className="workspace-file-viewer">
        <header className="workspace-file-viewer__header">
          {!previewOnly ? (
            <IconButton
              className="chrome-button workspace-file-tree-toggle"
              type="button"
              aria-label={treeToggleLabel}
              title={treeToggleLabel}
              aria-expanded={fileTreeOpen}
              aria-controls={fileTreeId}
              onClick={() => setFileTreeOpen(!fileTreeOpen)}
            >
              {fileTreeOpen ? <FolderOpen size={16} /> : <Folder size={16} />}
            </IconButton>
          ) : null}
          {!previewOnly ? (
            <IconButton
              className="workspace-file-back"
              type="button"
              disabled={workspacePathParent(selectedPath) === selectedPath}
              aria-label={intl.formatMessage({ id: "files.parent", defaultMessage: "Parent directory" })}
              onClick={() => selectFile(workspacePathParent(selectedPath))}
            >
              <ChevronLeftIcon size={18} />
            </IconButton>
          ) : null}
          {resource.data?.isDirectory ? (
            <WorkspaceFolderIcon size={22} />
          ) : (
            <WorkspaceFileIcon path={selectedPath} size={15} />
          )}
          <span>
            <strong title={selectedPath}>{workspaceResourceBasename(selectedPath)}</strong>
          </span>
          {(language === "markdown" || language === "html") && resource.data?.text != null && !editing ? (
            <div className="workspace-file-viewer__actions">
              <Button variant="ghost" aria-pressed={!showSource} onClick={() => setSourceView(null)} type="button">
                {intl.formatMessage({ id: "panel.markdownPreview", defaultMessage: "Preview" })}
              </Button>
              <Button variant="ghost" aria-pressed={showSource} onClick={() => setSourceView(documentId)} type="button">
                {intl.formatMessage({ id: "panel.markdownSource", defaultMessage: "Source" })}
              </Button>
            </div>
          ) : null}
          {canWrite && (serverText !== null || fileDraft !== undefined) ? (
            <div className="workspace-file-viewer__actions">
              {editing ? (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!dirty || conflicted || doc?.saving}
                    onClick={() => void saveFile()}
                    title={intl.formatMessage({ id: "files.save", defaultMessage: "Save" })}
                    type="button"
                  >
                    <Save size={14} /> {intl.formatMessage({ id: "files.save", defaultMessage: "Save" })}
                  </Button>
                  <IconButton
                    disabled={!dirty || doc?.saving}
                    onClick={revertDraft}
                    aria-label={intl.formatMessage({ id: "files.discard", defaultMessage: "Discard unsaved changes" })}
                    title={intl.formatMessage({ id: "files.discard", defaultMessage: "Discard unsaved changes" })}
                    type="button"
                  >
                    <RotateCcw size={14} />
                  </IconButton>
                </>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => setEditingKey(fileKey)}
                  title={intl.formatMessage({ id: "files.edit", defaultMessage: "Edit" })}
                  type="button"
                >
                  <Pencil size={14} /> {intl.formatMessage({ id: "files.edit", defaultMessage: "Edit" })}
                </Button>
              )}
            </div>
          ) : null}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <DisclosureButton
                size="chrome"
                aria-label={intl.formatMessage({ id: "files.actions", defaultMessage: "File actions" })}
              >
                <MoreIcon size={16} />
              </DisclosureButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="workspace-file-menu" align="end" sideOffset={4}>
                {canDownload && !resource.data?.isDirectory ? (
                  <DropdownMenu.Item asChild className="workspace-file-menu__item">
                    <a href={downloadUrl ?? fileSource?.url} download={workspaceResourceBasename(selectedPath)}>
                      <Download size={16} />
                      {intl.formatMessage({ id: "panel.downloadFile", defaultMessage: "Download file" })}
                    </a>
                  </DropdownMenu.Item>
                ) : null}
                {!previewOnly ? (
                  <DropdownMenu.Item
                    className="workspace-file-menu__item"
                    onSelect={() => {
                      void blobs
                        .invalidate({ scope: readScope, path: selectedPath })
                        .then(() =>
                          queryClient.invalidateQueries({
                            predicate: (query) =>
                              workspaceQueryAffected(query.queryKey, hostId, readScope, [
                                selectedPath,
                                workspacePathParent(selectedPath),
                              ]),
                          }),
                        )
                        .catch(() => undefined);
                    }}
                  >
                    <RotateCcw size={16} />
                    {intl.formatMessage({ id: "files.refresh", defaultMessage: "Refresh files" })}
                  </DropdownMenu.Item>
                ) : null}
                {!previewOnly ? (
                  <DropdownMenu.Item
                    className="workspace-file-menu__item"
                    onSelect={() => {
                      selectFile(workspacePathParent(selectedPath));
                      setFileTreeOpen(true);
                    }}
                  >
                    <FolderOpen size={16} />
                    {intl.formatMessage({ id: "files.parent", defaultMessage: "Parent directory" })}
                  </DropdownMenu.Item>
                ) : null}
                {serverText !== null ? (
                  <DropdownMenu.CheckboxItem
                    className="workspace-file-menu__item"
                    checked={browser.wrapLines}
                    onCheckedChange={(value) => {
                      browser.wrapLines = value === true;
                      changed();
                    }}
                  >
                    {intl.formatMessage({ id: "files.wrapLines", defaultMessage: "Wrap long lines" })}
                  </DropdownMenu.CheckboxItem>
                ) : null}
                <DropdownMenu.Item
                  className="workspace-file-menu__item"
                  onSelect={() => {
                    void Promise.resolve()
                      .then(() => navigator.clipboard.writeText(selectedPath))
                      .catch(() =>
                        notices?.error({
                          key: "workspace-copy",
                          message: intl.formatMessage({
                            id: "files.copyFailed",
                            defaultMessage: "Could not copy the path.",
                          }),
                        }),
                      );
                  }}
                >
                  <CopyIcon size={16} />
                  {intl.formatMessage({ id: "files.copyPath", defaultMessage: "Copy path" })}
                </DropdownMenu.Item>
                {dirtyPaths.length ? (
                  <DropdownMenu.Item
                    className="workspace-file-menu__item"
                    title={intl.formatMessage({
                      id: "files.closeHint",
                      defaultMessage: "Save or discard changes before closing.",
                    })}
                    onSelect={() => {
                      setFileTreeOpen(true);
                      selectFile(dirtyPaths[0]!);
                    }}
                  >
                    {intl.formatMessage(
                      { id: "files.unsavedCount", defaultMessage: "Unsaved ({count})" },
                      { count: dirtyPaths.length },
                    )}
                  </DropdownMenu.Item>
                ) : null}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          {!resource.data?.isDirectory ? (
            <div className="workspace-file-viewer__actions">
              {htmlVisible ? <BrowserAnnotationToggle controller={htmlAnnotation.controller} blocked={false} /> : null}
              {!isWorkspaceFileRuntime(runtime) && htmlFilePreviewAvailable(snapshot.hostId, selectedPath) ? (
                <IconButton
                  type="button"
                  aria-label={intl.formatMessage({ id: "chat.link.openInBrowser", defaultMessage: "Open in browser" })}
                  title={intl.formatMessage({ id: "chat.link.openInBrowser", defaultMessage: "Open in browser" })}
                  onClick={openBrowserPreview}
                >
                  <ExternalLinkIcon size={14} />
                </IconButton>
              ) : null}
              <a
                className="workspace-file-download"
                role="link"
                aria-label={intl.formatMessage({ id: "panel.downloadFile", defaultMessage: "Download file" })}
                title={intl.formatMessage({ id: "panel.downloadFile", defaultMessage: "Download file" })}
                aria-disabled={!canDownload || undefined}
                tabIndex={canDownload ? undefined : -1}
                href={canDownload ? (downloadUrl ?? fileSource?.url) : undefined}
                download={workspaceResourceBasename(selectedPath)}
              >
                <Download size={14} aria-hidden="true" />
              </a>
            </div>
          ) : null}
        </header>
        {!previewOnly ? (
          <WorkspaceFilePath
            path={workspacePathParent(selectedPath)}
            onSelect={(path) => {
              selectFile(path);
              setFileTreeOpen(true);
            }}
          />
        ) : null}
        <div className="workspace-file-feedback" role="status">
          {conflicted ? (
            intl.formatMessage({
              id: "files.conflict",
              defaultMessage: "The file changed on disk. Copy your changes or discard them before saving.",
            })
          ) : doc?.error === "write" ? (
            intl.formatMessage({
              id: "files.saveFailed",
              defaultMessage: "Could not save the file. Your changes are kept.",
            })
          ) : resource.isError && resource.data ? (
            <Button onClick={() => void resource.refetch()}>
              {intl.formatMessage({ id: "files.refreshFailed", defaultMessage: "Refresh failed. Retry" })}
            </Button>
          ) : dirty ? (
            intl.formatMessage({ id: "files.unsaved", defaultMessage: "Unsaved changes" })
          ) : null}
        </div>
        {externalPreviewError ? (
          <p className="workspace-file-viewer__external-error" role="alert">
            {intl.formatMessage({
              id: "preview.externalUnavailable",
              defaultMessage: "Could not open the preview. Try again or download the original file.",
            })}
          </p>
        ) : null}
        {resource.isPending && !fileDraft ? (
          <div className="workspace-file-viewer__state">
            <LoaderCircle className="is-spinning" size={18} />
            {intl.formatMessage({ id: "panel.readingFile", defaultMessage: "Loading file…" })}
          </div>
        ) : resource.isError && !resource.data && !fileDraft ? (
          <div className="workspace-file-viewer__state is-error">
            <AlertTriangle size={18} />
            {intl.formatMessage({ id: "files.readFailed", defaultMessage: "Could not read this file." })}
            <Button onClick={() => void resource.refetch()}>
              {intl.formatMessage({ id: "files.retry", defaultMessage: "Retry" })}
            </Button>
          </div>
        ) : resource.data?.isDirectory ? (
          previewOnly ? (
            <div className="workspace-file-viewer__state">
              {intl.formatMessage({
                id: "panel.directoryHint",
                defaultMessage: "Choose a file link in the conversation to preview its contents.",
              })}
            </div>
          ) : (
            <WorkspaceDirectory
              key={selectedPath}
              path={selectedPath}
              hostId={hostId}
              readScope={readScope}
              fileSystem={runtime.resources.fileSystem}
              session={browser}
              onSelect={selectFile}
            />
          )
        ) : resource.data?.previewTooLarge ? (
          <div className="workspace-file-viewer__state" role="status">
            {intl.formatMessage({
              id: "preview.tooLarge",
              defaultMessage: "This file is too large to preview (25 MB limit). Download it to view.",
            })}
          </div>
        ) : imageMime !== null &&
          resource.data?.blob &&
          fileSource?.blob === resource.data.blob &&
          fileSource.documentId === documentId ? (
          <div className="workspace-file-viewer__image">
            <Suspense fallback={null}>
              <ZoomableImage
                fitToContainer
                key={documentId}
                alt={workspaceResourceBasename(selectedPath)}
                src={fileSource.url}
              />
            </Suspense>
            <small>
              <ImageIcon size={12} /> {resource.data.size.toLocaleString()} bytes
            </small>
          </div>
        ) : hasFilePreview && resource.data?.blob ? (
          <FilePreviewView
            key={documentId}
            ownerId={ownerId}
            tabId={tab.id}
            resource={documentId}
            blob={resource.data.blob}
            name={workspaceResourceBasename(selectedPath)}
            download={mediaKind !== "audio" && mediaKind !== "video"}
            onOpenLink={(url) => window.open(url, "_blank", "noopener,noreferrer")}
            active={active}
            dark={theme.resolvedTheme === "dark"}
            prepare={preparePreviewResources}
          />
        ) : serverText !== null || fileDraft !== undefined ? (
          <Suspense
            fallback={
              <div className="workspace-file-viewer__state">
                <LoaderCircle className="is-spinning" size={18} />
                {intl.formatMessage({ id: "files.loading", defaultMessage: "Loading…" })}
              </div>
            }
          >
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
                      openLocation(parseWorkspaceResource(target));
                    } else if (decision.kind === "external" || decision.kind === "mail") {
                      window.open(target, "_blank", "noopener,noreferrer");
                    }
                  }}
                />
              </div>
            ) : htmlVisible ? (
              <>
                <iframe
                  ref={htmlFrame}
                  className="workspace-file-html"
                  key={documentId}
                  referrerPolicy="no-referrer"
                  sandbox="allow-scripts"
                  srcDoc={htmlAnnotation.srcDoc ?? htmlPreview!}
                  title={`${workspaceResourceBasename(selectedPath)} ${intl.formatMessage({ id: "panel.markdownPreview", defaultMessage: "Preview" })}`}
                />
                <BrowserAnnotationLayer
                  controller={htmlAnnotation.controller}
                  slot={htmlFrame}
                  portal={presentationRoot ?? null}
                  touch={touchLayout}
                />
              </>
            ) : previewOnly && (language === "markdown" || language === "html") ? (
              <pre
                className="workspace-file-source"
                tabIndex={0}
                role="region"
                aria-label={intl.formatMessage({ id: "panel.markdownSource", defaultMessage: "Source" })}
              >
                <code>{text}</code>
              </pre>
            ) : (
              <WorkspaceCodeEditor
                wrapLines={browser.wrapLines}
                editable={editing && canWrite}
                viewStates={browser.views}
                documentKey={fileKey}
                location={browser.location}
                key={fileKey}
                label={workspaceResourceBasename(selectedPath)}
                language={language}
                onChange={updateDraft}
                value={text}
              />
            )}
          </Suspense>
        ) : resource.data?.blob && htmlFilePreviewAvailable(snapshot.hostId, selectedPath) ? (
          <div className="workspace-file-viewer__state workspace-file-viewer__external-report">
            <p>
              {intl.formatMessage({
                id: "preview.externalHint",
                defaultMessage: "Open this HTML report in your browser to view its contents and interactive controls.",
              })}
            </p>
            <Button type="button" onClick={openBrowserPreview}>
              <ExternalLinkIcon size={16} />
              {intl.formatMessage({ id: "chat.link.openInBrowser", defaultMessage: "Open in browser" })}
            </Button>
          </div>
        ) : resource.data?.blob ? (
          <WorkspaceMediaPreview
            key={fileKey}
            blob={resource.data.blob}
            name={workspaceResourceBasename(selectedPath)}
            kind="file"
          />
        ) : (
          <div className="workspace-file-viewer__state">
            <AlertTriangle size={18} />
            {intl.formatMessage({
              id: "panel.unsupportedFile",
              defaultMessage: "Preview unavailable for this file type or size.",
            })}
          </div>
        )}
      </section>
    </div>
  );
}
