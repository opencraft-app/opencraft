import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useIntl } from "@opencraft/i18n/react";
import { Button } from "@opencraft/design-system-web/button";
import {
  SearchIcon,
  ChevronRightIcon,
  FolderOpenIcon,
  LoadingRingIcon,
  WarningIcon,
} from "@opencraft/design-system-web/action-icons";
import type { AppServerFileSystemResourcePort } from "@opencraft/workbench-runtime";
import type { WorkspaceBrowserSession } from "./workspace-sessions";
import { selectWorkspaceDirectoryEntries } from "./workspace-file-tree-model";
import { joinWorkspacePath } from "./workspace-resource-model";
import { WorkspaceFileIcon } from "./workspace-file-icon";
import { FileFolderArtwork as WorkspaceFolderIcon } from "@opencraft/design-system-web/action-icons";

/** Directory navigation and the tree share the same filesystem query cache. */
export function WorkspaceDirectory({
  path,
  hostId,
  readScope,
  fileSystem,
  session,
  onSelect,
}: {
  path: string;
  hostId: string;
  readScope: string;
  fileSystem: AppServerFileSystemResourcePort;
  session: WorkspaceBrowserSession;
  onSelect(path: string): void;
}) {
  const intl = useIntl();
  const receipt = session.directories.get(path);
  const [query, setQuery] = useState(receipt?.query ?? "");
  const viewport = useRef<HTMLDivElement>(null);
  const filterId = useId();
  const filterInput = useRef<HTMLInputElement>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterLabel = intl.formatMessage({ id: "files.filterDirectory", defaultMessage: "Filter this folder" });
  const listing = useQuery({
    queryKey: ["appserver-fs", hostId, "directory", path, readScope],
    queryFn: () => fileSystem.readDirectory(path),
    select: selectWorkspaceDirectoryEntries,
    staleTime: 15_000,
  });
  useLayoutEffect(() => {
    if (viewport.current && listing.data) viewport.current.scrollTop = session.directories.get(path)?.top ?? 0;
  }, [path, listing.data, session]);
  const remember = (text = query) => {
    session.directories.delete(path);
    session.directories.set(path, { query: text, top: viewport.current?.scrollTop ?? 0 });
    while (session.directories.size > 64) session.directories.delete(session.directories.keys().next().value!);
  };
  const entries = listing.data?.filter((entry) =>
    entry.fileName.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <div className="workspace-directory" data-filter-open={filterOpen || !!query || undefined}>
      <div className="workspace-directory__tools">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={filterOpen || !!query}
          aria-controls={filterId}
          onClick={() => {
            if (query) filterInput.current?.focus();
            else setFilterOpen((value) => !value);
          }}
        >
          <SearchIcon size={14} />
          {filterLabel}
        </Button>
      </div>
      <label className="workspace-file-search">
        <SearchIcon size={16} />
        <input
          ref={filterInput}
          id={filterId}
          value={query}
          aria-label={intl.formatMessage({ id: "files.filterDirectory", defaultMessage: "Filter this folder" })}
          placeholder={intl.formatMessage({ id: "files.filterDirectory", defaultMessage: "Filter this folder" })}
          onChange={(event) => {
            setQuery(event.target.value);
            remember(event.target.value);
          }}
        />
      </label>
      <div className="workspace-directory__list" ref={viewport} onScroll={() => remember()}>
        {listing.isError && !listing.data ? (
          <DirectoryState
            icon={<WarningIcon />}
            text={intl.formatMessage({
              id: "files.directoryUnavailable",
              defaultMessage: "Could not read this folder.",
            })}
          >
            <Button variant="secondary" size="sm" onClick={() => void listing.refetch()}>
              {intl.formatMessage({ id: "files.retry", defaultMessage: "Retry" })}
            </Button>
          </DirectoryState>
        ) : null}
        {listing.isPending ? (
          <DirectoryState
            status
            icon={<LoadingRingIcon className="is-spinning" />}
            text={intl.formatMessage({ id: "files.loading", defaultMessage: "Loading…" })}
          />
        ) : null}
        {entries?.map((entry) => (
          <button
            type="button"
            className="workspace-directory__row"
            key={entry.fileName}
            onClick={() => {
              remember();
              onSelect(joinWorkspacePath(path, entry.fileName));
            }}
            title={entry.fileName}
          >
            <span className="workspace-directory__icon">
              {entry.isDirectory ? <WorkspaceFolderIcon /> : <WorkspaceFileIcon path={entry.fileName} size={24} />}
            </span>
            <span className="workspace-directory__name">{entry.fileName}</span>
            {entry.isDirectory ? <ChevronRightIcon className="workspace-directory__chevron" size={16} /> : null}
          </button>
        ))}
        {entries?.length === 0 ? (
          <DirectoryState
            status
            icon={query ? <SearchIcon /> : <FolderOpenIcon />}
            text={intl.formatMessage(
              query
                ? { id: "files.noMatches", defaultMessage: "No matching files" }
                : { id: "files.emptyDirectory", defaultMessage: "This folder is empty" },
            )}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Shared compact empty-state geometry for loading, empty and failure. */
function DirectoryState({
  icon,
  text,
  status,
  children,
}: {
  icon: ReactNode;
  text: string;
  status?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="workspace-directory__state ui-empty-state" role={status ? "status" : "alert"}>
      <div className="ui-empty-state__content">
        <span className="ui-empty-state__icon" aria-hidden="true">
          {icon}
        </span>
        <p className="ui-empty-state__description">{text}</p>
        {children ? <div className="ui-empty-state__actions">{children}</div> : null}
      </div>
    </div>
  );
}
