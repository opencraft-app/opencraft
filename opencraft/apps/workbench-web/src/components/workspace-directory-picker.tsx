import type { FsReadDirectoryEntry } from "@opencraft/appserver-protocol/generated/v2";
import { ChevronLeft, Folder, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ModalSurface } from "./modal";
import { Button } from "./ui/button";

import {
  joinWorkspacePath,
  normalizeWorkspacePath,
  resolveWorkspacePickerInitialPath,
  workspaceParentPath,
} from "./workspace-directory-model";

export interface WorkspaceDirectoryPickerProps {
  readonly open: boolean;
  readonly rootPath: string;
  readonly initialPath?: string | null;
  readonly title?: string;
  readonly description?: string;
  readonly confirmLabel?: string;
  readonly onReadDirectory: (path: string) => Promise<readonly FsReadDirectoryEntry[]>;
  readonly onCancel: () => void;
  readonly onChoose: (path: string) => Promise<void>;
}

/**
 * Browser equivalent of Codex Desktop's native local-project dialog. It
 * browses the AppServer filesystem namespace; it never uploads a browser
 * directory or treats a DOM FileSystemHandle as a server workspace.
 */
export function WorkspaceDirectoryPicker({
  open,
  rootPath,
  initialPath,
  title = "Add project",
  description = "Choose a folder from this AppServer workspace.",
  confirmLabel = "Add project",
  onReadDirectory,
  onCancel,
  onChoose,
}: WorkspaceDirectoryPickerProps) {
  const normalizedRoot = useMemo(() => normalizeWorkspacePath(rootPath), [rootPath]);
  const [currentPath, setCurrentPath] = useState(() =>
    resolveWorkspacePickerInitialPath(initialPath, rootPath));
  const [entries, setEntries] = useState<readonly FsReadDirectoryEntry[]>([]);
  const [phase, setPhase] = useState<"idle" | "loading" | "choosing">("idle");
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  useEffect(() => {
    if (!open) return;
    setCurrentPath(resolveWorkspacePickerInitialPath(initialPath, normalizedRoot));
    setError(null);
  }, [initialPath, normalizedRoot, open]);

  useEffect(() => {
    if (!open) return;
    const generation = ++requestGeneration.current;
    setPhase("loading");
    setError(null);
    void onReadDirectory(currentPath).then(
      (nextEntries) => {
        if (generation !== requestGeneration.current) return;
        setEntries(nextEntries
          .filter((entry) => entry.isDirectory
            && !entry.fileName.startsWith(".")
            && !entry.fileName.includes("/")
            && !entry.fileName.includes("\\")
            && entry.fileName !== "..")
          .sort((left, right) => left.fileName.localeCompare(right.fileName)));
        setPhase("idle");
      },
      (cause) => {
        if (generation !== requestGeneration.current) return;
        setEntries([]);
        setError(cause instanceof Error ? cause.message : String(cause));
        setPhase("idle");
      },
    );
  }, [currentPath, onReadDirectory, open]);

  if (!open) return null;

  const choose = async () => {
    setPhase("choosing");
    setError(null);
    try {
      await onChoose(currentPath);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("idle");
    }
  };

  const rootLabel = normalizedRoot.split("/").filter(Boolean).at(-1) ?? normalizedRoot;
  const canChooseCurrentFolder = currentPath !== normalizedRoot;
  const relativeSegments = currentPath
    .slice(normalizedRoot.length)
    .split("/")
    .filter(Boolean);

  return (
    <ModalSurface
      appearance="utility"
      className="workspace-picker-dialog"
      dismissOnOutsidePress={phase !== "choosing"}
      label={title}
      onDismiss={() => {
        if (phase !== "choosing") onCancel();
      }}
      size="wide"
    >
        <header className="workspace-picker-header">
          <span className="workspace-picker-header__icon"><FolderOpen size={17} /></span>
          <div>
            <h2 id="workspace-picker-title">{title}</h2>
            <p>{description}</p>
          </div>
        </header>

        <nav className="workspace-picker-breadcrumbs" aria-label="Current folder">
          <button type="button" onClick={() => setCurrentPath(normalizedRoot)}>{rootLabel}</button>
          {relativeSegments.map((segment, index) => {
            const path = joinWorkspacePath(normalizedRoot, relativeSegments.slice(0, index + 1).join("/"));
            return (
              <span key={path}>
                <i>/</i>
                <button type="button" onClick={() => setCurrentPath(path)}>{segment}</button>
              </span>
            );
          })}
        </nav>

        <div className="workspace-picker-list" role="group" aria-label={`Folders in ${currentPath}`} aria-busy={phase === "loading"}>
          {currentPath !== normalizedRoot ? (
            <button
              type="button"
              className="workspace-picker-row workspace-picker-row--parent"
              onClick={() => setCurrentPath(workspaceParentPath(currentPath, normalizedRoot))}
            >
              <ChevronLeft size={15} />
              <span>Parent folder</span>
            </button>
          ) : null}
          {phase === "loading" ? <p className="workspace-picker-state">Loading folders…</p> : null}
          {phase !== "loading" && entries.length === 0 && error === null ? (
            <p className="workspace-picker-state">This folder has no subfolders.</p>
          ) : null}
          {entries.map((entry) => (
            <button
              key={entry.fileName}
              type="button"
              className="workspace-picker-row"
              onClick={() => setCurrentPath(joinWorkspacePath(currentPath, entry.fileName))}
            >
              <Folder size={16} />
              <span>{entry.fileName}</span>
            </button>
          ))}
        </div>

        {error === null ? null : <p className="workspace-picker-error" role="alert">{error}</p>}

        <footer className="workspace-picker-footer">
          <code title={currentPath}>{currentPath}</code>
          <div className="workspace-picker-footer__actions">
            <Button variant="outline" size="sm" onClick={onCancel} disabled={phase === "choosing"}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void choose()}
              disabled={phase !== "idle" || error !== null || !canChooseCurrentFolder}
              loading={phase === "choosing"}
              title={error !== null ? "This folder could not be opened" : canChooseCurrentFolder ? undefined : "Choose a subfolder"}
            >
              {confirmLabel}
            </Button>
          </div>
        </footer>
    </ModalSurface>
  );
}
