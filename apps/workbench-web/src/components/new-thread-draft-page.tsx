import { CheckIcon as Check, ChevronDownIcon as ChevronDown, ChevronRightIcon as ChevronRight, FolderIcon as Folder, LoadingRingIcon as LoaderCircle, SearchIcon as Search } from "@opencraft/design-system-web/action-icons";
import { useObservedReadiness } from '../runtime/observability-react';
import { ThreadGoalSurface } from "./thread-goal-surface";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { ThreadComposerPresentation } from "./thread-composer-presentation";
import {
  OpenCraftComposer,
  type OpenCraftComposerHandle,
  type ComposerEffectiveSelections,
  type ComposerSelectionCatalog,
  type ComposerShortcutCommand,
} from "@opencraft/composer-editor";
import type {
  ComposerAttachment,
  ComposerCatalog,
  ComposerController,
  ComposerFollowUpAction,
  SubmitIntent,
} from "@opencraft/composer-core";
import {
  draftSubmissionOwnsNavigation,
  type MachineResourceLifecycle,
  type NewThreadDraftSnapshot,
  type ThreadGoalResource,
} from "@opencraft/workbench-runtime";
import { menuGeometry } from "@opencraft/design-system/tokens";
import { useMachineConnectionPhase } from "../runtime/appserver-runtime-context";
import { ConnectionStatus } from "./target-connection-status";
import { machineResourcePhaseLabel } from "./machine-resource-presentation";
import { NewFolderIcon as FolderPlus, BranchIcon as GitBranch, CloudIcon as Cloud, LaptopIcon as Laptop, ServerIcon as Server } from "@opencraft/design-system-web/action-icons";
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
import { useWorkbenchPresentationRoot } from "./workbench-presentation-root";

export interface DraftHostOption {
  readonly id: string;
  readonly hostIds: readonly string[];
  readonly label: string;
  readonly platform: "macos" | "linux" | "windows" | null;
  readonly resource: MachineResourceLifecycle | null;
  readonly cloud: boolean;
  readonly role: "local" | "server" | "cloud";
  readonly connectable: boolean;
}

function MachineIcon({ role }: { role: DraftHostOption["role"] }) {
  const Icon = role === "local" ? Laptop : role === "cloud" ? Cloud : Server;
  return <Icon size={15} />;
}

function MachineRow({ host, selected }: { host: DraftHostOption; selected: boolean }) {
  const intl = useIntl();
  const phase = useMachineConnectionPhase(host.hostIds);
  const subtitle = [
    host.platform === "macos" ? "macOS" : host.platform === "linux" ? "Linux" : host.platform === "windows" ? "Windows" : host.cloud ? null : intl.formatMessage({ id: "workIn.unknownSystem", defaultMessage: "Unknown system" }),
    machineResourcePhaseLabel(host.resource, intl),
    phase === "ready" ? null : intl.formatMessage({ id: "workIn.offline", defaultMessage: "Offline" }),
  ].filter(Boolean).join(" · ");
  return <>
    <MachineIcon role={host.role} />
    <span><strong>{host.label}</strong><small>{subtitle}</small></span>
    <ConnectionStatus phase={phase} />
    {selected ? <Check size={15} /> : null}
  </>;
}

export interface NewThreadDraftPageProps {
  activeTabId?: string | null;
  composerPresentationEnabled?: boolean;
  readonly placeholder?: string;
  readonly heading?: string;
  readonly draft: NewThreadDraftSnapshot;
  readonly controller: ComposerController;
  readonly goals?: ThreadGoalResource;
  readonly onCreateGoal?: (objective: string) => Promise<void>;
  readonly selectionCatalog: ComposerSelectionCatalog;
  readonly catalog: ComposerCatalog;
  readonly effectiveSelections?: ComposerEffectiveSelections;
  readonly modelSelectionPolicy?: import("@opencraft/composer-core").ModelSelectionPolicy;
  readonly personalDefaultsPending?: boolean;
  readonly workspaceOptions: readonly DraftWorkspaceOption[];
  readonly workspaceOptionsLoading?: boolean;
  readonly nativeWorkspacePicking?: boolean;
  readonly showExecutionControls?: boolean;
  readonly activeHostId: string;
  readonly hostOptions: readonly DraftHostOption[];
  readonly connectionPhase: string;
  readonly onSelectHost: (hostId: string) => void | Promise<void>;
  readonly onSelectWorkspace: (workspace: DraftWorkspaceOption) => void;
  readonly onBrowseWorkspace: () => void | Promise<void>;
  readonly onResolveAttachment?: (
    file: File,
    pending: ComposerAttachment,
    signal?: AbortSignal,
  ) => ComposerAttachment | Promise<ComposerAttachment>;
  readonly onRemoveAttachment?: (
    attachment: ComposerAttachment,
  ) => void | Promise<void>;
  readonly composerAddMenuContent?: ReactNode | ((closeMenu: () => void) => ReactNode);
  readonly composerEndActions?: ReactNode;
  readonly shortcutCommands?: readonly ComposerShortcutCommand[];
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


interface DragState {
  pointerId: number;
  startX: number;
  startScrollLeft: number;
  moved: boolean;
}

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
  readonly portalContainer: HTMLElement | null;
  readonly draft: NewThreadDraftSnapshot;
  readonly workspaceOptions: readonly DraftWorkspaceOption[];
  readonly workspaceOptionsLoading: boolean;
  readonly nativeWorkspacePicking: boolean;
  readonly activeHostId: string;
  readonly hostOptions: readonly DraftHostOption[];
  readonly connectionPhase: string;
  readonly onSelectHost: (hostId: string) => void | Promise<void>;
  readonly onSelectWorkspace: (workspace: DraftWorkspaceOption) => void;
  readonly onBrowseWorkspace: () => void | Promise<void>;
  readonly onReturnFocus: () => void;
}

function ExecutionUtilityBar({
  portalContainer,
  draft,
  workspaceOptions,
  workspaceOptionsLoading,
  nativeWorkspacePicking,
  activeHostId,
  hostOptions,
  connectionPhase,
  onSelectHost,
  onSelectWorkspace,
  onBrowseWorkspace,
  onReturnFocus,
}: ExecutionUtilityBarProps) {
  const intl = useIntl();
  const selectionEpoch = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const [projectQuery, setProjectQuery] = useState("");
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [switchingHostId, setSwitchingHostId] = useState<string | null>(null);
  const [hostSelectionError, setHostSelectionError] = useState<string | null>(null);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const [workspaceSelectionError, setWorkspaceSelectionError] = useState<string | null>(null);
  const workspace = draft.target.execution.workspace;
  const executionLocked = draftSubmissionOwnsNavigation(draft.phase);
  const selectedWorkspace = useMemo(
    () => workspaceOptions.find((option) =>
      option.projectId === workspace.projectId && option.cwd === workspace.cwd) ?? null,
    [workspace.cwd, workspace.projectId, workspaceOptions],
  );
  const project = selectedWorkspace?.label ?? workspaceLabel(workspace.cwd);
  const activeHost = useMemo(
    () => hostOptions.find((host) => host.hostIds.includes(activeHostId)) ?? null,
    [activeHostId, hostOptions],
  );
  const displayedHost = switchingHostId === null
    ? activeHost
    : hostOptions.find((host) => host.id === switchingHostId) ?? activeHost;
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
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            className="new-thread-context-trigger"
            type="button"
            aria-label={intl.formatMessage({ id: "workIn.title", defaultMessage: "Work in" })}
            disabled={executionLocked}
          >
            <MachineIcon role={displayedHost?.role ?? "server"} />
            <span>{displayedHost === null ? intl.formatMessage({ id: "workIn.unknown", defaultMessage: "Unknown machine" }) : displayedHost.label}</span>
            <ConnectionStatus phase={switchingHostId === null ? connectionPhase : "connecting"} />
            <ChevronDown size={12} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={portalContainer}>
          {/* The Machine trigger leads the Project trigger. Start alignment
              anchors its menu in the Draft's leading overlay corridor. */}
          <DropdownMenu.Content
            className="new-thread-project-menu new-thread-host-menu"
            align="start"
            side="top"
            sideOffset={menuGeometry.rootSideOffset}
            collisionPadding={menuGeometry.collisionPadding}
            onCloseAutoFocus={(event) => { event.preventDefault(); onReturnFocus(); }}
          >
            <DropdownMenu.Label className="opencraft-composer-selection-menu__heading">{intl.formatMessage({ id: "workIn.title", defaultMessage: "Work in" })}</DropdownMenu.Label>
            <div className="new-thread-project-menu__items">
              {[false, true].map(cloud => <DropdownMenu.Group key={String(cloud)}>
              {cloud && hostOptions.some(host => host.cloud) ? <DropdownMenu.Label className="opencraft-composer-selection-menu__heading">{intl.formatMessage({ id: "workIn.cloud", defaultMessage: "Cloud" })}</DropdownMenu.Label> : null}
              {hostOptions.filter(host => host.cloud === cloud).map((host) => {
                const selected = host.hostIds.includes(activeHostId);
                return (
                  <DropdownMenu.Item
                    key={host.id}
                    className="new-thread-project-menu__item"
                    data-selected={selected ? "true" : undefined}
                    disabled={executionLocked || !host.connectable}
                    onSelect={() => {
                      if (selected && switchingHostId === null) return;
                      const epoch = ++selectionEpoch.current;
                      setSwitchingHostId(host.id);
                      setHostSelectionError(null);
                      void Promise.resolve(onSelectHost(host.id)).catch((cause) => {
                        if (epoch === selectionEpoch.current) setHostSelectionError(cause instanceof Error ? cause.message : String(cause));
                      }).finally(() => { if (epoch === selectionEpoch.current) setSwitchingHostId(null); });
                    }}
                  >
                    <MachineRow host={host} selected={selected} />
                  </DropdownMenu.Item>
                );
              })}
              </DropdownMenu.Group>)}
              {hostSelectionError === null ? null : (
                <div className="new-thread-project-menu__state is-error" role="alert">
                  {hostSelectionError}
                </div>
              )}
            </div>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <ChevronRight className="new-thread-context-separator" size={12} aria-hidden="true" focusable="false" />

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
            aria-label={intl.formatMessage({ id: "draft.chooseProjectFolder", defaultMessage: "Choose project folder" })}
            title={workspace.cwd ?? undefined}
            disabled={executionLocked}
          >
            <Folder size={15} /><span>{project ?? intl.formatMessage({ id: "draft.chooseProject", defaultMessage: "Choose project" })}</span><ChevronDown size={12} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={portalContainer}>
          <DropdownMenu.Content
            className="new-thread-project-menu"
            align="start"
            side="top"
            sideOffset={menuGeometry.rootSideOffset}
            collisionPadding={menuGeometry.collisionPadding}
            onCloseAutoFocus={(event) => { event.preventDefault(); onReturnFocus(); }}
          >
            <DropdownMenu.Label className="new-thread-project-menu__heading">
              <FormattedMessage id="draft.project" defaultMessage="Project" />
            </DropdownMenu.Label>
            <div className="new-thread-project-menu__search">
              <Search size={14} />
              <input
                ref={searchRef}
                value={projectQuery}
                placeholder={intl.formatMessage({ id: "draft.searchProjectsAndFolders", defaultMessage: "Search projects and folders" })}
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
                  <LoaderCircle size={14} /> <FormattedMessage id="draft.loadingProjects" defaultMessage="Loading projects…" />
                </div>
              ) : null}
              {!workspaceOptionsLoading && filteredWorkspaces.length === 0 ? (
                <div className="new-thread-project-menu__state"><FormattedMessage id="draft.noMatchingProject" defaultMessage="No matching project" /></div>
              ) : null}
            </div>
            <DropdownMenu.Separator className="new-thread-project-menu__separator" />
            <DropdownMenu.Item
              className="new-thread-project-menu__item"
              disabled={executionLocked || pickingWorkspace || connectionPhase !== "ready" || activeHost === null}
              onSelect={() => {
                setWorkspaceSelectionError(null);
                setPickingWorkspace(true);
                Promise.resolve().then(onBrowseWorkspace)
                  .catch(error => setWorkspaceSelectionError(error instanceof Error ? error.message : String(error)))
                  .finally(() => setPickingWorkspace(false));
              }}
            >
              <FolderPlus size={15} />
              <span>
                <strong><FormattedMessage id="draft.addProject" defaultMessage="Add project" /></strong>
                <small>{connectionPhase !== "ready" ? intl.formatMessage({ id: "draft.connectBeforeAddProject", defaultMessage: "Connect to this node before adding a project" })
                  : nativeWorkspacePicking ? intl.formatMessage({ id: "draft.chooseFolderOnDevice", defaultMessage: "Choose a folder on this device" }) : intl.formatMessage({ id: "draft.chooseFolderFromNode", defaultMessage: "Choose a folder from this node" })}</small>
              </span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {workspaceSelectionError === null ? null : (
        <span className="new-thread-project-menu__state is-error" role="alert">
          {workspaceSelectionError}
        </span>
      )}
      {pickingWorkspace ? <span role="status"><FormattedMessage id="draft.choosingFolder" defaultMessage="Choosing folder…" /></span> : null}

      {selectedWorkspace?.branch ? (
        <span className="new-thread-context-branch" title={intl.formatMessage({ id: "draft.gitBranch", defaultMessage: "Git branch: {branch}" }, { branch: selectedWorkspace.branch })}>
          <GitBranch size={14} /><span>{selectedWorkspace.branch}</span>
        </span>
      ) : null}
    </ComposerUtilityScrollArea>
  );
}

export function NewThreadDraftPage({
  activeTabId = null,
  composerPresentationEnabled = true,
  placeholder,
  heading,
  draft,
  controller,
  goals,
  onCreateGoal,
  selectionCatalog,
  catalog,
  effectiveSelections,
  modelSelectionPolicy,
  workspaceOptions,
  workspaceOptionsLoading = false,
  nativeWorkspacePicking = false,
  showExecutionControls = true,
  activeHostId,
  hostOptions,
  connectionPhase,
  onSelectHost,
  onSelectWorkspace,
  onBrowseWorkspace,
  onResolveAttachment,
  onRemoveAttachment,
  composerAddMenuContent,
  composerEndActions,
  shortcutCommands,
  personalDefaultsPending = false,
  onSubmit,
}: NewThreadDraftPageProps) {
  const intl = useIntl();
  const composerRef = useRef<OpenCraftComposerHandle>(null);
  useObservedReadiness(draft.scopeId, connectionPhase === 'ready' && !personalDefaultsPending && !draftSubmissionOwnsNavigation(draft.phase));
  const portalContainer = useWorkbenchPresentationRoot();

  if (draft.submission !== null) {
    throw new Error(
      `Conversation ${draft.scopeId} already owns its first Turn and cannot render a Draft Composer`,
    );
  }

  useEffect(() => {
    const animationFrame = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(animationFrame);
  }, [draft.id]);


  const composer = (goalMenuItem: ((closeMenu: (afterClose?: () => void) => void) => ReactNode) | null, goalBusy = false, goalContent: ReactNode = null) => <OpenCraftComposer
    attachedContent={goalContent}
    ref={composerRef}
    portalContainer={portalContainer}
    controller={controller}
    chromeHeader={showExecutionControls ? (
      <ExecutionUtilityBar
        portalContainer={portalContainer}
        draft={draft}
        workspaceOptions={workspaceOptions}
        workspaceOptionsLoading={workspaceOptionsLoading}
        nativeWorkspacePicking={nativeWorkspacePicking}
        activeHostId={activeHostId}
        hostOptions={hostOptions}
        connectionPhase={connectionPhase}
        onSelectHost={onSelectHost}
        onSelectWorkspace={onSelectWorkspace}
        onBrowseWorkspace={onBrowseWorkspace}
        onReturnFocus={() => composerRef.current?.focus()}
      />
    ) : undefined}
    disabled={goalBusy || draftSubmissionOwnsNavigation(draft.phase)}
    submissionDisabled={connectionPhase !== "ready" || personalDefaultsPending}
    isStreaming={false}
    placeholder={placeholder ?? intl.formatMessage({ id: "chat.companionPlaceholder", defaultMessage: "Share your thoughts, or ask me to help with something" })}
    onResolveAttachment={onResolveAttachment}
    onRemoveAttachment={onRemoveAttachment}
    addMenuContent={goalMenuItem === null ? composerAddMenuContent : closeMenu => <>
      {typeof composerAddMenuContent === "function" ? composerAddMenuContent(closeMenu) : composerAddMenuContent}
      {goalMenuItem(closeMenu)}
    </>}
    shortcutCommands={shortcutCommands}
    endActions={composerEndActions}
    selectionCatalog={selectionCatalog}
    catalog={catalog}
    mentionSuggestionsEnabled={false}
    effectiveSelections={effectiveSelections}
    modelSelectionPolicy={modelSelectionPolicy}
    onSubmit={onSubmit}
    onCancel={() => undefined}
  />;

  return (
    <div
      className="new-thread-draft-page"
      data-new-thread-draft-id={draft.id}
      data-new-thread-draft-phase={draft.phase}
    >
      <main className="new-thread-draft-main" aria-label={intl.formatMessage({ id: "draft.mainContent", defaultMessage: "Main content" })}>
        <div className="new-thread-draft-layout">
          <section className="new-thread-draft-hero" aria-labelledby="new-thread-heading">
            <h1 id="new-thread-heading">{heading ?? <FormattedMessage id="draft.heading" defaultMessage="What should we work on?" />}</h1>
          </section>
          <section className="new-thread-draft-composer-zone" aria-label={intl.formatMessage({ id: "draft.startNewTask", defaultMessage: "Start a new task" })}>
            <div className="thread-layout-width new-thread-draft-composer-width">
              <ThreadComposerPresentation controller={controller} scopeId={draft.scopeId} activeTabId={activeTabId} enabled={composerPresentationEnabled} timeline={null}>
              <div className="thread-composer-region" data-thread-find-composer="true">
                {goals ? <ThreadGoalSurface threadId={null} goals={goals} draftScope={draft.target}
                  onCreateGoal={onCreateGoal} disabled={connectionPhase !== "ready" || personalDefaultsPending || draftSubmissionOwnsNavigation(draft.phase)}
                  portalContainer={portalContainer}>{composer}</ThreadGoalSurface> : composer(null)}
              </div>
              </ThreadComposerPresentation>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
