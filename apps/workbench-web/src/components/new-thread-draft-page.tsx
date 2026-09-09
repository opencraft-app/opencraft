import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  CodexComposer,
  type CodexComposerHandle,
  type ComposerEffectiveSelections,
  type ComposerSelectionCatalog,
} from "@opencraft/codex-composer";
import type {
  ComposerAttachment,
  ComposerCatalog,
  ComposerController,
  ComposerFollowUpAction,
  SubmitIntent,
} from "@opencraft/composer-core";
import {
  draftSubmissionOwnsNavigation,
  type NewThreadDraftSnapshot,
} from "@opencraft/workbench-runtime";
import { menuGeometry } from "@opencraft/design-system/tokens";
import { ConnectionStatus } from "./target-connection-status";
import {
  Check,
  ChevronDown,
  Folder,
  FolderPlus,
  GitBranch,
  Globe2,
  LoaderCircle,
  Search,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  searchDraftWorkspaceOptions,
  type DraftWorkspaceOption,
} from "../runtime/draft-workspace-model";

export interface DraftHostOption {
  readonly id: string;
  readonly label: string;
  readonly kind: "local" | "remote-ssh" | "durable" | "remote-control" | "wsl";
  readonly transportEndpoint: string | null;
  readonly executionLocation: string | null;
  readonly workspaceBrowseRoots: readonly string[];
}

export interface NewThreadDraftPageProps {
  readonly draft: NewThreadDraftSnapshot;
  readonly controller: ComposerController;
  readonly selectionCatalog: ComposerSelectionCatalog;
  readonly catalog: ComposerCatalog;
  readonly effectiveSelections?: ComposerEffectiveSelections;
  readonly workspaceOptions: readonly DraftWorkspaceOption[];
  readonly workspaceOptionsLoading?: boolean;
  readonly activeHostId: string;
  readonly hostOptions: readonly DraftHostOption[];
  readonly connectionPhase: string;
  readonly onSelectHost: (hostId: string) => void | Promise<void>;
  readonly onSelectWorkspace: (workspace: DraftWorkspaceOption) => void;
  readonly onBrowseWorkspace: () => void;
  readonly onResolveAttachment?: (
    file: File,
    pending: ComposerAttachment,
    signal?: AbortSignal,
  ) => ComposerAttachment | Promise<ComposerAttachment>;
  readonly composerEndActions?: ReactNode;
  readonly onSubmit: (
    intent: SubmitIntent,
    context: { readonly followUpAction: ComposerFollowUpAction | null },
  ) => boolean | void | Promise<boolean | void>;
}

function workspaceLabel(cwd: string | null): string | null {
  const segment = cwd?.split(/[\\/]+/u).filter(Boolean).at(-1);
  if (segment === undefined) return null;
  return `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`;
}

function hostKindLabel(kind: DraftHostOption["kind"]): string {
  return kind === "local" ? "Local" : kind === "wsl" ? "WSL" : "Remote";
}

interface DragState {
  pointerId: number;
  startX: number;
  startScrollLeft: number;
  moved: boolean;
}

/** Codex-style overflow owner: one axis, pointer capture and click suppression. */
function ComposerUtilityScrollArea({ children }: { readonly children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const [overflow, setOverflow] = useState(false);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const update = () => setOverflow(viewport.scrollWidth > viewport.clientWidth + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    if (viewport.firstElementChild instanceof HTMLElement) {
      observer.observe(viewport.firstElementChild);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={viewportRef}
      className="composer-utility-scroll-area"
      data-overflow={overflow ? "true" : undefined}
      onClickCapture={(event) => {
        if (!suppressClickRef.current) return;
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        if ((event.target as Element).closest("button,input,[role='menuitem']") !== null) return;
        const viewport = viewportRef.current;
        if (viewport === null || viewport.scrollWidth <= viewport.clientWidth) return;
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startScrollLeft: viewport.scrollLeft,
          moved: false,
        };
        viewport.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        const viewport = viewportRef.current;
        if (drag === null || viewport === null || drag.pointerId !== event.pointerId) return;
        const delta = event.clientX - drag.startX;
        if (!drag.moved && Math.abs(delta) < 4) return;
        drag.moved = true;
        viewport.scrollLeft = drag.startScrollLeft - delta;
        event.preventDefault();
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        if (drag === null || drag.pointerId !== event.pointerId) return;
        suppressClickRef.current = drag.moved;
        dragRef.current = null;
      }}
      onPointerCancel={() => { dragRef.current = null; }}
      onWheel={(event) => {
        const viewport = viewportRef.current;
        if (viewport === null || viewport.scrollWidth <= viewport.clientWidth) return;
        if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
        viewport.scrollLeft += event.deltaY;
      }}
    >
      <div className="composer-utility-scroll-area__content">{children}</div>
    </div>
  );
}

interface ExecutionUtilityBarProps {
  readonly draft: NewThreadDraftSnapshot;
  readonly workspaceOptions: readonly DraftWorkspaceOption[];
  readonly workspaceOptionsLoading: boolean;
  readonly activeHostId: string;
  readonly hostOptions: readonly DraftHostOption[];
  readonly connectionPhase: string;
  readonly onSelectHost: (hostId: string) => void | Promise<void>;
  readonly onSelectWorkspace: (workspace: DraftWorkspaceOption) => void;
  readonly onBrowseWorkspace: () => void;
  readonly onReturnFocus: () => void;
}

function ExecutionUtilityBar({
  draft,
  workspaceOptions,
  workspaceOptionsLoading,
  activeHostId,
  hostOptions,
  connectionPhase,
  onSelectHost,
  onSelectWorkspace,
  onBrowseWorkspace,
  onReturnFocus,
}: ExecutionUtilityBarProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [projectQuery, setProjectQuery] = useState("");
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [switchingHostId, setSwitchingHostId] = useState<string | null>(null);
  const [hostSelectionError, setHostSelectionError] = useState<string | null>(null);
  const workspace = draft.target.execution.workspace;
  const executionLocked = draftSubmissionOwnsNavigation(draft.phase);
  const selectedWorkspace = useMemo(
    () => workspaceOptions.find((option) =>
      option.projectId === workspace.projectId && option.cwd === workspace.cwd) ?? null,
    [workspace.cwd, workspace.projectId, workspaceOptions],
  );
  const project = selectedWorkspace?.label ?? workspaceLabel(workspace.cwd);
  const activeHost = useMemo(
    () => hostOptions.find((host) => host.id === activeHostId) ?? null,
    [activeHostId, hostOptions],
  );
  const canBrowseWorkspace = (activeHost?.workspaceBrowseRoots.length ?? 0) > 0
    || workspace.runtimeWorkspaceRoots.length > 0;
  const filteredWorkspaces = useMemo(() => {
    return searchDraftWorkspaceOptions(workspaceOptions, projectQuery);
  }, [projectQuery, workspaceOptions]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [projectMenuOpen]);

  return (
    <ComposerUtilityScrollArea>
      <DropdownMenu.Root
        open={projectMenuOpen}
        onOpenChange={(open) => {
          setProjectMenuOpen(open);
          if (!open) setProjectQuery("");
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button
            className="new-thread-context-trigger"
            type="button"
            aria-label="Choose project folder"
            disabled={executionLocked}
          >
            <Folder size={15} /><span>{project ?? "Choose project"}</span><ChevronDown size={12} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="new-thread-project-menu"
            align="start"
            side="top"
            sideOffset={menuGeometry.rootSideOffset}
            collisionPadding={menuGeometry.collisionPadding}
            onCloseAutoFocus={(event) => { event.preventDefault(); onReturnFocus(); }}
          >
            <DropdownMenu.Label className="new-thread-project-menu__heading">
              Project
            </DropdownMenu.Label>
            <div className="new-thread-project-menu__search">
              <Search size={14} />
              <input
                ref={searchRef}
                value={projectQuery}
                placeholder="Search projects and folders"
                onChange={(event) => setProjectQuery(event.currentTarget.value)}
              />
            </div>
            <div className="new-thread-project-menu__items">
              {filteredWorkspaces.map((option) => {
                const selected = option.projectId === workspace.projectId
                  && option.cwd === workspace.cwd;
                return (
                  <DropdownMenu.Item
                    key={`${option.projectId}:${option.cwd}`}
                    className="new-thread-project-menu__item"
                    data-selected={selected ? "true" : undefined}
                    disabled={executionLocked}
                    onSelect={() => onSelectWorkspace(option)}
                  >
                    <Folder size={15} />
                    <span>
                      <strong>{option.label}</strong>
                      <small>{option.runtimeWorkspaceRoots.length > 1
                        ? `${option.rootLabel} · ${option.cwd}`
                        : option.cwd}</small>
                    </span>
                    {selected ? <Check size={15} /> : null}
                  </DropdownMenu.Item>
                );
              })}
              {workspaceOptionsLoading ? (
                <div className="new-thread-project-menu__state">
                  <LoaderCircle size={14} /> Loading projects…
                </div>
              ) : null}
              {!workspaceOptionsLoading && filteredWorkspaces.length === 0 ? (
                <div className="new-thread-project-menu__state">No matching project</div>
              ) : null}
            </div>
            <DropdownMenu.Separator className="new-thread-project-menu__separator" />
            <DropdownMenu.Item
              className="new-thread-project-menu__item"
              disabled={executionLocked || !canBrowseWorkspace}
              onSelect={onBrowseWorkspace}
            >
              <FolderPlus size={15} />
              <span>
                <strong>Add project</strong>
                <small>{canBrowseWorkspace
                  ? "Choose a folder from this node"
                  : "This node does not advertise a browse root"}</small>
              </span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            className="new-thread-context-trigger"
            type="button"
            aria-label="Choose execution node"
            disabled={executionLocked || switchingHostId !== null}
          >
            <Globe2 size={15} />
            <span>{switchingHostId === null
              ? activeHost === null ? "Unavailable target" : activeHost.label
              : "Connecting…"}</span>
            <ConnectionStatus phase={switchingHostId === null ? connectionPhase : "connecting"} />
            <ChevronDown size={12} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          {/* The Host trigger sits after the Project trigger. End alignment
              keeps the menu in the Draft's leading overlay corridor. */}
          <DropdownMenu.Content
            className="new-thread-project-menu new-thread-host-menu"
            align="end"
            side="top"
            sideOffset={menuGeometry.rootSideOffset}
            collisionPadding={menuGeometry.collisionPadding}
            onCloseAutoFocus={(event) => { event.preventDefault(); onReturnFocus(); }}
          >
            <div className="new-thread-project-menu__items">
              {hostOptions.map((host) => {
                const selected = host.id === activeHostId;
                return (
                  <DropdownMenu.Item
                    key={host.id}
                    className="new-thread-project-menu__item"
                    data-selected={selected ? "true" : undefined}
                    disabled={executionLocked || switchingHostId !== null}
                    onSelect={() => {
                      if (selected) return;
                      setSwitchingHostId(host.id);
                      setHostSelectionError(null);
                      void Promise.resolve(onSelectHost(host.id)).catch((cause) => {
                        setHostSelectionError(cause instanceof Error ? cause.message : String(cause));
                      }).finally(() => setSwitchingHostId(null));
                    }}
                  >
                    <Globe2 size={15} />
                    <span>
                      <strong>{host.label}</strong>
                      <small>{hostKindLabel(host.kind)}{host.executionLocation
                        ? ` · ${host.executionLocation}`
                        : ""}</small>
                    </span>
                    {selected ? <Check size={15} /> : null}
                  </DropdownMenu.Item>
                );
              })}
              {hostSelectionError === null ? null : (
                <div className="new-thread-project-menu__state is-error" role="alert">
                  {hostSelectionError}
                </div>
              )}
            </div>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {selectedWorkspace?.branch ? (
        <span className="new-thread-context-branch" title={`Git branch: ${selectedWorkspace.branch}`}>
          <GitBranch size={14} /><span>{selectedWorkspace.branch}</span>
        </span>
      ) : null}
    </ComposerUtilityScrollArea>
  );
}

export function NewThreadDraftPage({
  draft,
  controller,
  selectionCatalog,
  catalog,
  effectiveSelections,
  workspaceOptions,
  workspaceOptionsLoading = false,
  activeHostId,
  hostOptions,
  connectionPhase,
  onSelectHost,
  onSelectWorkspace,
  onBrowseWorkspace,
  onResolveAttachment,
  composerEndActions,
  onSubmit,
}: NewThreadDraftPageProps) {
  const composerRef = useRef<CodexComposerHandle>(null);

  if (draft.submission !== null) {
    throw new Error(
      `Conversation ${draft.scopeId} already owns its first Turn and cannot render a Draft Composer`,
    );
  }

  useEffect(() => {
    const animationFrame = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(animationFrame);
  }, [draft.id]);

  return (
    <div
      className="new-thread-draft-page"
      data-new-thread-draft-id={draft.id}
      data-new-thread-draft-phase={draft.phase}
    >
      <main className="new-thread-draft-main" aria-label="Main content">
        <div className="new-thread-draft-layout">
          <section className="new-thread-draft-hero" aria-labelledby="new-thread-heading">
            <h1 id="new-thread-heading">What should we work on?</h1>
          </section>
          <section className="new-thread-draft-composer-zone" aria-label="Start a new task">
            <div className="thread-layout-width new-thread-draft-composer-width">
              <div className="thread-composer-region" data-thread-find-composer="true">
                <CodexComposer
                  ref={composerRef}
                  controller={controller}
                  chromeHeader={(
                    <ExecutionUtilityBar
                      draft={draft}
                      workspaceOptions={workspaceOptions}
                      workspaceOptionsLoading={workspaceOptionsLoading}
                      activeHostId={activeHostId}
                      hostOptions={hostOptions}
                      connectionPhase={connectionPhase}
                      onSelectHost={onSelectHost}
                      onSelectWorkspace={onSelectWorkspace}
                      onBrowseWorkspace={onBrowseWorkspace}
                      onReturnFocus={() => composerRef.current?.focus()}
                    />
                  )}
                  disabled={draftSubmissionOwnsNavigation(draft.phase)}
                  submissionDisabled={connectionPhase !== "ready"}
                  isStreaming={false}
                  placeholder="Ask OpenCraft to work on anything"
                  onResolveAttachment={onResolveAttachment}
                  endActions={composerEndActions}
                  selectionCatalog={selectionCatalog}
                  catalog={catalog}
                  effectiveSelections={effectiveSelections}
                  onSubmit={onSubmit}
                  onCancel={() => undefined}
                />
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
