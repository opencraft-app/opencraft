import { WorkspacePlacementPicker, type WorkspacePlacementControl } from './workspace-placement-picker';
import { DisclosureButton } from "@opencraft/design-system-web/button";
import { AddIcon as Plus, CheckIcon as Check, ChevronDownIcon as ChevronDown } from "@opencraft/design-system-web/action-icons";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { draftSubmissionOwnsNavigation, type NewThreadDraftSnapshot } from "@opencraft/workbench-runtime";
import { menuGeometry } from "@opencraft/design-system/tokens";
import { useMachineConnectionPhase, useOptionalPersonalMachines } from "../runtime/appserver-runtime-context";
import { ConnectionStatus } from "./target-connection-status";
import { machineResourcePhaseLabel } from "./machine-resource-presentation";
import { BranchIcon as GitBranch, CloudIcon as Cloud, LaptopIcon as Laptop, ServerIcon as Server } from "@opencraft/design-system-web/action-icons";
import { lazy, Suspense, type PointerEvent as ReactPointerEvent, type ReactNode, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type DraftWorkspaceOption } from "../runtime/draft-workspace-model";
import { useAsyncNotices } from "./async-notices-context";
import type { DraftHostOption } from "./new-thread-draft-page";

const LazyAddMachineModal = lazy(() =>
  import("./add-machine-modal").then((module) => ({ default: module.AddMachineModal })),
);

const EMPTY_PERSONAL_SUBSCRIBE = () => () => {};
const NULL_PERSONAL_DIRECTORY = () => null;

function WorkInAddMachineItem({
  disabled,
  onOpen,
}: {
  readonly disabled: boolean;
  readonly onOpen: () => void;
}) {
  const intl = useIntl();
  const personalMachines = useOptionalPersonalMachines();
  const directory = useSyncExternalStore(
    personalMachines ? personalMachines.subscribe : EMPTY_PERSONAL_SUBSCRIBE,
    personalMachines ? personalMachines.getDirectorySnapshot : NULL_PERSONAL_DIRECTORY,
    NULL_PERSONAL_DIRECTORY,
  );
  if (!personalMachines || !directory) return null;
  return (
    <>
      <DropdownMenu.Separator className="opencraft-composer-selection-menu__separator" />
      <DropdownMenu.Item
        className="new-thread-project-menu__item"
        disabled={disabled}
        onSelect={() => {
          onOpen();
        }}
      >
        <Plus size={15} />
        <span>
          <strong>{intl.formatMessage({ id: "workIn.addMachine", defaultMessage: "Add machine…" })}</strong>
        </span>
      </DropdownMenu.Item>
    </>
  );
}

function WorkInAddMachineModalHost({
  open,
  portalContainer,
  onReturnFocus,
  onClose,
}: {
  readonly open: boolean;
  readonly portalContainer: HTMLElement | null;
  readonly onReturnFocus: () => void;
  readonly onClose: () => void;
}) {
  const personalMachines = useOptionalPersonalMachines();
  const notices = useAsyncNotices();
  if (!open || !personalMachines) return null;
  return (
    <Suspense fallback={null}>
      <LazyAddMachineModal
        personalMachines={personalMachines}
        portalContainer={portalContainer}
        returnFocus={() => {
          onReturnFocus();
          return null;
        }}
        reportError={notices.error}
        onClose={onClose}
      />
    </Suspense>
  );
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
  readonly placement?: WorkspacePlacementControl;
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

export function ExecutionUtilityBar({
  portalContainer,
  draft,
  placement,
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
  const intl = useIntl(), notices = useAsyncNotices();
  const selectionEpoch = useRef(0);
  const [switchingHostId, setSwitchingHostId] = useState<string | null>(null);
  const [addMachineOpen, setAddMachineOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<'host' | 'workspace' | null>(null);
  const openMenuRef = useRef<'host' | 'workspace' | null>(null);
  const setMenuState = (next: 'host' | 'workspace' | null) => {
    openMenuRef.current = next;
    setOpenMenu(next);
  };
  const workspace = draft.target.execution.workspace;
  const executionLocked = draftSubmissionOwnsNavigation(draft.phase);
  const selectedWorkspace = useMemo(
    () => workspaceOptions.find((option) =>
      !draft.target.execution.environment && !workspace.source && option.projectId === workspace.projectId && option.cwd === workspace.cwd) ?? null,
    [draft.target.execution.environment, workspace.source, workspace.cwd, workspace.projectId, workspaceOptions],
  );
  const activeHost = useMemo(
    () => hostOptions.find((host) => host.hostIds.includes(activeHostId)) ?? null,
    [activeHostId, hostOptions],
  );
  const displayedHost = switchingHostId === null
    ? activeHost
    : hostOptions.find((host) => host.id === switchingHostId) ?? activeHost;
  return (
    <ComposerUtilityScrollArea>
      <DropdownMenu.Root
        open={openMenu === 'host'}
        onOpenChange={(next) => setMenuState(next ? 'host' : (openMenuRef.current === 'host' ? null : openMenuRef.current))}
      >
        <DropdownMenu.Trigger asChild>
          <DisclosureButton
            className="new-thread-context-trigger"
            type="button"
            aria-label={intl.formatMessage({ id: "workIn.title", defaultMessage: "Work in" })}
            disabled={executionLocked}
          >
            <MachineIcon role={displayedHost?.role ?? "server"} />
            <span>{displayedHost === null ? intl.formatMessage({ id: "workIn.unknown", defaultMessage: "Unknown machine" }) : displayedHost.label}</span>
            <ConnectionStatus phase={switchingHostId === null ? connectionPhase : "connecting"} />
            <ChevronDown size={12} />
          </DisclosureButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={portalContainer}>
          {/* The node trigger leads the workspace trigger. Start alignment
              anchors its menu in the Draft's leading overlay corridor. */}
          <DropdownMenu.Content
            className="new-thread-project-menu new-thread-host-menu"
            align="start"
            side="top"
            sideOffset={menuGeometry.rootSideOffset}
            collisionPadding={menuGeometry.collisionPadding}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (openMenuRef.current === null) onReturnFocus();
            }}
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
                      void Promise.resolve().then(() => onSelectHost(host.id)).catch(() => {
                        if (epoch === selectionEpoch.current) notices.error({ key: "node-selection", message: intl.formatMessage({ id: "workspacePlacement.nodeFailed", defaultMessage: "Could not switch to this node. Try again." }) });
                      }).finally(() => { if (epoch === selectionEpoch.current) setSwitchingHostId(null); });
                    }}
                  >
                    <MachineRow host={host} selected={selected} />
                  </DropdownMenu.Item>
                );
              })}
              </DropdownMenu.Group>)}
              <WorkInAddMachineItem
                disabled={executionLocked}
                onOpen={() => setAddMachineOpen(true)}
              />
            </div>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <WorkInAddMachineModalHost
        open={addMachineOpen}
        portalContainer={portalContainer}
        onReturnFocus={onReturnFocus}
        onClose={() => setAddMachineOpen(false)}
      />

      <WorkspacePlacementPicker control={placement} execution={draft.target.execution} locked={executionLocked}
        portalContainer={portalContainer}
        open={openMenu === 'workspace'}
        onOpenChange={(next) => setMenuState(next ? 'workspace' : (openMenuRef.current === 'workspace' ? null : openMenuRef.current))}
        onReturnFocus={() => { if (openMenuRef.current === null) onReturnFocus(); }}
        workspaceOptions={workspaceOptions} workspaceOptionsLoading={workspaceOptionsLoading}
        canBrowse={connectionPhase === "ready" && activeHost !== null} nativeWorkspacePicking={nativeWorkspacePicking}
        onBrowseWorkspace={onBrowseWorkspace} onSelectWorkspace={onSelectWorkspace} />

      {selectedWorkspace?.branch ? (
        <span className="new-thread-context-branch" title={intl.formatMessage({ id: "draft.gitBranch", defaultMessage: "Git branch: {branch}" }, { branch: selectedWorkspace.branch })}>
          <GitBranch size={14} /><span>{selectedWorkspace.branch}</span>
        </span>
      ) : null}
    </ComposerUtilityScrollArea>
  );
}

