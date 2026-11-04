import { readHostModelReadiness } from "@opencraft/plugin-builtin-agents/model-readiness";
import { composerCapabilitiesKey } from "./runtime/composer-capabilities-query";
import { ButtonPlaceholder } from "@opencraft/design-system-web/button";
import { historyLengthBucket, historyEngine } from "./runtime/thread-history-first-paint";
import { completeConversationComposerSubmission } from "./runtime/composer-submission-admission";
import { configureDesktopServer } from './runtime/configure-desktop-server';
import { desktopServerPort } from './runtime/desktop-server-connections';
import { useThreadOrchestrationTimeline } from "./runtime/use-thread-orchestration-timeline";
import { useTurnNotifications } from "./runtime/turn-notifications-context";
import { resolveHostModelSettingsPage } from "@opencraft/extension-runtime";
import { ConversationSummaryButton, ConversationSummarySurface, ConversationSummaryLayout, useConversationSummary, useSummaryGoal } from "./components/conversation-summary";
import { serverUrl } from "./runtime/server-context";
import { workbenchLocationUrl } from "./runtime/workbench-navigation";
import { ConversationToolbarSizing } from "./components/toolbar-dock-state";
import { conversationToolbarActionIds } from "./components/toolbar-dock-model";
import { useConversationDisplay } from "./runtime/use-conversation-display";
import { displayTimingCounts } from "./runtime/display-timing-diagnostics";
import { reportDisplayEvent } from "./runtime/recovery-diagnostics";
import { serverFetch } from "./runtime/server-context";
import { ConversationReferenceSurface } from "./components/conversation-reference-surface";
import { copyConversationReference } from "./runtime/conversation-reference-actions";
import { useAsyncNotices } from "./components/async-notices";
import { ContinuationFailureNotice } from "./components/continuation-failure-notice";
import { useObservedReadiness } from './runtime/observability-react';
import { executionEngineExtension } from "@opencraft/appserver-client";
import { ScheduledTaskCatalogContext } from "./runtime/scheduled-task-catalog-context";
import { SIDE_CHAT_COMPOSER_COMMAND, runSideChatComposerCommand } from "./panels/side-chat-composer-command";
import { MonitorIcon as Monitor } from "@opencraft/design-system-web/action-icons";
import type { ConversationPresentationProvider } from "./runtime/conversation-presentation";
import { useConversationHistoryRefresh } from "./components/conversation-history-refresh";
import { createMcpAppOwner } from "./mcp-apps/owner";
import type { McpAppWidgetStateStore } from "./mcp-apps/contract";
import { canHandleWorkbenchShortcut, matchesWorkbenchShortcut, shortcutLabel } from "./workbench-shortcuts";
import { WorkbenchShortcutHelp } from "./components/workbench-shortcut-help";
import { WorkbenchPresentationActivityProvider } from "./components/workbench-presentation-activity";
import { ConversationSearch, type ConversationSearchTarget } from "./components/conversation-search";
import { OVERHOME_VIEW_ID } from "./runtime/mini-apps";
import { ApplicationRouteMotion, useApplicationDesktopBackdrop } from "./components/application-desktop-motion";
import { ImageEditorContext } from "@opencraft/extension-react";
import { IdentityAvatarContext } from "@opencraft/extension-react";
import { submitEmbeddedPrompt } from "./embedded-chat/embedded-prompt-submission";
import { isEmbeddedConversationPainted } from "./embedded-chat/embedded-paint";
import { createDeferredView } from "@opencraft/extension-react";
const WorkspaceResourcePreviewPanel = createDeferredView(async () => (await import("./panels/workspace-resource-panel")).WorkspaceResourcePreviewPanel);
import { EditableThreadTitle } from "./components/editable-thread-title";
import { ApplicationBrand } from "./components/application-brand";
import { DEFAULT_APPLICATION_BRANDING } from "@opencraft/extension-contract";
import { applyApplicationBranding } from "./runtime/application-branding";
import { shouldTypeToCompose } from "./type-to-compose";
import { findStandaloneHostComposerAction } from "@opencraft/workbench-runtime";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDefaultFollowUpAction } from "./runtime/use-default-follow-up-action";
import { useIntl } from "@opencraft/i18n/react";
import { groupWorkInMachines, machineName, machineRole } from "./runtime/work-in-presentation";
import { useWorkInEngineCatalog } from "./runtime/appserver-runtime-context";
import {
  createClientId,
  retargetSubmitIntentForFollowUp,
  type ComposerAttachment,
  type ComposerFollowUpAction,
  type SubmitIntent,
} from "@opencraft/composer-core";
import {
  compileSubmitIntent,
  restoreQueuedInput,
} from "@opencraft/composer-appserver";
import { queuedSubmissionPresentation, queueSenderPresentation, visibleQueuedSubmissions } from "./queued-submission-presentation";
import {
  OpenCraftComposer,
  type ComposerSelectionCatalog,
} from "@opencraft/composer-editor";
import { asHostId, asTurnId, deriveAsyncQuestionStates, findPendingInteraction, parseAsyncQuestionReply, renderAsyncQuestionReply, type AsyncQuestion, type TimelineSnapshot, type TurnDiffTimelineBlock } from "@opencraft/chat-core";
import type { ChatResourceDecision, ChatResourceOpenIntent } from "@opencraft/chat-render-web";
import type { PlatformViewHost } from "@opencraft/extension-react";
import type {
  LatestTurnPlacementSnapshot,
  TimelineSurfaceCapabilities,
} from "@opencraft/timeline-virtualizer";
import { useStableEvent } from "@opencraft/react-runtime";
import { nativeProjectPicker } from "./runtime/project-folder-picker";
import { groupWorkInMachines as groupNewConversationMachines, workInAgentHosts, chooseWorkInHost, ThreadTitleWriter, legacyDirectServerProjectionFromHost } from "@opencraft/workbench-runtime";
import { readCachedThreadName, writeCachedThreadName } from "./runtime/thread-title-cache";
import { archiveThread } from "./runtime/thread-archive";
import { forkAndOpenThread } from "./runtime/thread-fork-navigation";
import { formatDocumentTitle } from "./runtime/document-title";
import {
  canInvokeHostPanelCommand,
  type PanelAction,
  type PanelTabDescriptor,
  type HostPanelCommand,
  type HostPanelState,
  type PanelToolbarActionContext,
} from "@opencraft/workbench-panels";
import { createPortal } from "react-dom";
import {
  createInteractionResponse,
  createWorkbenchThreadLocation,
  draftSubmissionOwnsNavigation,
  equalWorkbenchLocation,
  findHostConnectionInterventionError,
  projectComposerModelChoices,
} from "@opencraft/workbench-runtime";
import { OPENCRAFT_THREAD_QUEUE_EXTENSION, OPENCRAFT_PERMISSION_MODES_EXTENSION, supportsAtomicQueuedSteer, supportsUnconfirmedSteerDiscard, type OpenCraftPermissionProfile } from "@opencraft/appserver-protocol";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  useBrowserWorkbench,
} from "./browser/browser-runtime-context";
import {
  AppShell,
} from "./components/app-shell";
import {
  AppShellHeader,
  AppShellNavigationControls,
} from "./components/app-shell-header";
import {
  AppShellRouteRegionsProvider,
  appShellPlatformViewRegions,
  useAppShellRouteHeader,
} from "./components/app-shell-route-regions";
import {
  Conversation,
  type ConversationInteractionAction,
  type ConversationRestoreSnapshot,
  type ConversationScrollApi,
} from "./components/conversation";
import {
  ConversationRecoveryNotice,
  ConversationRecoveryEmptyState,
  conversationRecoveryPresentation,
  conversationRecoveryIsPending,
  conversationRecoveryIsUnstable,
} from "./components/conversation-recovery";
import { ConversationPendingInteractionPanel } from "./components/conversation-renderers/interaction/interaction-renderers";
import { InteractionDraftStore } from "./components/conversation-renderers/interaction/interaction-drafts";
import { useConversationRecoveryDiagnostic } from "./runtime/conversation-recovery-diagnostic";
import { RightPanel } from "./components/right-panel";
import { ThreadComposerPresentation } from "./components/thread-composer-presentation";
import { ThreadGoalSurface } from "./components/thread-goal-surface";
import { ThreadRecoveryNotice } from "./components/thread-recovery-notice";
import { TurnDiffReviewDialog } from "./components/conversation/turn-diff-review-dialog";
import { ComposerTurnChangeSummary } from "./components/conversation/turn-diff-resource";
import { Button } from "./components/ui/button";
import { DraftSetupNotice } from "./components/draft-setup-notice";
import { NewThreadDraftPage } from "./components/new-thread-draft-page";
import { isWorkbenchToolPage } from "./runtime/workbench-tool-pages";
import { WorkbenchToolNavigation, useWorkbenchToolActions } from "./components/workbench-tool-navigation";
import { InternalDeveloperModeGate } from "./components/internal-developer-mode-gate";
import { useInternalDeveloperMode } from "./internal-developer-mode";
import {
  ManagementSettingsContent,
  ModalHost,
  showAnnouncementLab,
  type ModalRequest,
  useAnnouncementModalRequests,
} from "./components/modal";
import { PendingConversationPage } from "./components/pending-conversation-page";
import { Sidebar } from "./components/sidebar";
import { useSidebarCommands } from "./components/use-sidebar-commands";
import { WorkspaceDirectoryPicker } from "./components/workspace-directory-picker";
import { useWorkbenchPresentationRoot } from "./components/workbench-presentation-root";
import { useResponsiveSidebarDock } from "./components/use-responsive-sidebar-dock";
import { usePersistedSidebarWidth } from "./components/use-persisted-sidebar-width";
import {
  selectedProjectStorageKey,
  readLocalPreference,
  setLocalPreference,
  useActiveAppServerThread,
  useAppServerHosts,
  useAppServerRuntime,
  useAppServerSnapshot,
  useAppServerComposerCatalog,
  useComposerCatalog,
  useProjectCatalog,
  useConversationScopeRegistry,
  useConversationScopeRegistrySnapshot,
  useConversationViewActivation,
  useConversationViewDisplayKey,
  useConversationViewIdentity,
  useHostConnectionPhase,
  useRootComposerController,
  useThreadCatalog,
  useMultiHostThreadCatalog,
  useThreadPinWriter,
} from "./runtime/appserver-runtime-context";
import {
  setAppearanceThemeId,
  setThemePreference,
  useAppearanceTheme,
} from "./appearance-theme";
import { resolveBrowserAttachmentForHost } from "./runtime/browser-attachment-resolver";
import { createAppServerMediaSourceLoader } from "./runtime/appserver-media-loader";
import { useBlobResources, useImageProcessing } from "./runtime/appserver-runtime-context";
import {
  buildDraftWorkspaceOptions,
  resolveDraftDirectorySelection,
} from "./runtime/draft-workspace-model";

import {
  usePanelRendererSnapshot,
  usePanelToolbarActions,
  useConversationPanelState,
  useWorkbenchPanelRuntime,
} from "./runtime/panel-runtime-context";
import { getWindowChromePolicy, useWindowChrome } from "./window-chrome";
import { useTimelineViewportHost } from "./timeline-viewport";
import { ComposerExtensionActions } from "./runtime/composer-action-renderers";
import { useConnectorPresentation } from "./components/connectors/connector-panel";
import { useExtensionWorkbenchProjection } from "./runtime/extension-workbench-projection";
import { useAuthenticationPresentation } from "./runtime/use-authentication-presentation";
import {
  FULL_WORKBENCH_PRESENTATION,
  type WorkbenchPresentationPolicy,
} from "./workbench-presentation-policy";

const SettingsContent = lazy(async () => {
  const module = await import("./components/settings-page");
  return { default: module.SettingsContent };
});
const ConversationTaskMenu = lazy(async () => {
  const module = await import("./components/conversation-task-menu");
  return { default: module.ConversationTaskMenu };
});
const SettingsNavigation = lazy(async () => {
  const module = await import("./components/settings-page");
  return { default: module.SettingsNavigation };
});

function humanizeCatalogValue(value: string): string {
  return value
    .replace(/^:/, "")
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) =>
      part.length <= 3
        ? part.toUpperCase()
        : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`,
    )
    .join(" ");
}

export interface EmbeddedWorkbenchAppSession {
  readonly chatId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly readOnly: boolean;
  readonly running: boolean;
  readonly pinned: boolean;
}

export interface EmbeddedWorkbenchAppActions {
  submitPrompt(text: string): boolean;
  selectThread(threadId: string): Promise<void>;
  createThread(): Promise<void>;
  loadMoreThreads(): Promise<void>;
  renameThread(threadId: string, title: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  setThreadPinned(threadId: string, pinned: boolean): Promise<void>;
}

export interface EmbeddedWorkbenchAppPresentation {
  readonly modelSelectionPolicy?: import("@opencraft/composer-core").ModelSelectionPolicy;
  readonly onConfigureModels?: () => void;
  readonly panelHost?: {
    readonly target: HTMLElement;
    readonly presentation?: { subscribe: (listener: () => void) => (() => void); getSnapshot: () => boolean };
    readonly publish: (state: HostPanelState) => void;
    readonly bind: (command: (command: HostPanelCommand) => boolean) => (() => void);
  };
  readonly hostId: string;
  /** The conversation surface has painted; the Host may still be connecting. */
  readonly onPainted: () => void;
  readonly onReady: (threadId: string | null) => void;
  readonly onError: (error: Error) => void;
  readonly onSessionsChange: (detail: {
    readonly sessions: readonly EmbeddedWorkbenchAppSession[];
    readonly loading: boolean;
    readonly error: string | null;
    readonly hasMoreSessions: boolean;
    readonly pinSupported: boolean;
    readonly selectedChatId: string | null;
    readonly isDraft: boolean;
  }) => void;
  readonly bindActions: (actions: EmbeddedWorkbenchAppActions) => (() => void);
}

const EMPTY_IMAGE_EDITOR = Object.freeze({ contribution: null });
const NO_IMAGE_EDITOR_SUBSCRIPTION = () => () => {};
const NO_IMAGE_EDITOR_SNAPSHOT = () => EMPTY_IMAGE_EDITOR;

export function App({
  embedded,
  conversationPresentation,
  presentation = FULL_WORKBENCH_PRESENTATION,
}: {
  readonly embedded?: EmbeddedWorkbenchAppPresentation;
  readonly conversationPresentation?: ConversationPresentationProvider;
  readonly presentation?: WorkbenchPresentationPolicy;
} = {}) {
  const intl = useIntl();
  const turnNotifications = useTurnNotifications();
  const notices = useAsyncNotices();
  const modelSelectionPolicy = embedded?.modelSelectionPolicy ?? (embedded ? "host-default" : "user");
  const internalDeveloperMode = useInternalDeveloperMode();
  const [accountOpen, setAccountOpen] = useState(false);
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [conversationSearchTarget, setConversationSearchTarget] = useState<(ConversationSearchTarget & { hostId: string; threadId: string }) | null>(null);
  const [closingSideChat, setClosingSideChat] = useState<{ ownerId: string; tab: PanelTabDescriptor } | null>(null);
  const appearanceTheme = useAppearanceTheme();
  const windowChrome = useWindowChrome();
  const portalContainer = useWorkbenchPresentationRoot();
  const chromePolicy = getWindowChromePolicy(windowChrome);
  useTimelineViewportHost(windowChrome);
  const runtime = useAppServerRuntime();
  const activeThreadLease = useActiveAppServerThread();
  const conversationScopes = useConversationScopeRegistry();
  const draftSnapshot = useConversationScopeRegistrySnapshot();
  const draft =
    draftSnapshot.activeDraftId === null
      ? null
      : (draftSnapshot.drafts.find(
          (candidate) => candidate.id === draftSnapshot.activeDraftId,
        ) ?? null);
  const composerController = useRootComposerController();
  const defaultFollowUpAction = useDefaultFollowUpAction();
  const hostCatalog = useAppServerHosts();
  const selectSearchedThread = useCallback((hostId: string, id: string, target?: ConversationSearchTarget) => {
    setConversationSearchTarget(null);
    void hostCatalog.selectConversation(createWorkbenchThreadLocation(hostId, id)).then(activated => {
      if (activated && target) setConversationSearchTarget({ ...target, hostId, threadId: id });
    }).catch(error => console.error("Failed to activate searched Thread", error));
  }, [hostCatalog]);
  const attentionScope = hostCatalog.threadAttention.getScope();
  const conversationViewIdentity = useConversationViewIdentity();
  const extensionPlatform = (
    globalThis as typeof globalThis & {
      opencraftDesktop?: { readonly kind?: string };
    }
  ).opencraftDesktop?.kind === "electron"
    ? "electron"
    : "web";
  const conversationViewActivation = useConversationViewActivation();
  const snapshot = useAppServerSnapshot();
  useEffect(() => {
    setConversationSearchTarget(current => current
      && (current.hostId !== snapshot.hostId || current.threadId !== snapshot.activeThreadId) ? null : current);
  }, [snapshot.hostId, snapshot.activeThreadId]);
  const activeHostConnectionPhase = useHostConnectionPhase(snapshot.hostId);
  const environmentSnapshot = useSyncExternalStore(
    hostCatalog.environmentDirectory.subscribe,
    hostCatalog.environmentDirectory.getSnapshot,
    hostCatalog.environmentDirectory.getSnapshot,
  );
  const engineExtensions = runtime.resources.host.getInitializeResult()?.capabilities?.extensions;
  const queueExtension = executionEngineExtension(engineExtensions, snapshot.activeThreadId, OPENCRAFT_THREAD_QUEUE_EXTENSION);
  const followUpCapability = executionEngineExtension(engineExtensions, snapshot.activeThreadId, "opencraft/thread-follow-up") as { queue?: boolean; steer?: boolean } | undefined;
  const permissionModesExtension = executionEngineExtension(engineExtensions, snapshot.activeThreadId, OPENCRAFT_PERMISSION_MODES_EXTENSION);
  const supportsPermissionModes = typeof permissionModesExtension === "object"
    && permissionModesExtension !== null
    && "version" in permissionModesExtension
    && permissionModesExtension.version === 1;
  const queueAtomicSteer = supportsAtomicQueuedSteer(queueExtension);
  const queueUnconfirmedSteerDiscard = supportsUnconfirmedSteerDiscard(queueExtension);
  const queueReorderable = !(
    typeof queueExtension === "object" &&
    queueExtension !== null &&
    "reorder" in queueExtension &&
    queueExtension.reorder === false
  );
  const activeHost =
    hostCatalog.hosts.find((host) => host.hostId === snapshot.hostId) ??
    hostCatalog.hosts[0]!;
  const machines = useMemo(() => groupWorkInMachines(hostCatalog.profiles, environmentSnapshot.entries), [hostCatalog.profiles, environmentSnapshot.entries]);
  const activeMachine = machines.find(machine => machine.hosts.some(host => host.hostId === snapshot.hostId));
  const newConversationMachines = useMemo(() => groupNewConversationMachines(hostCatalog.profiles.filter(host => host.hideFromNewChat !== true), environmentSnapshot.entries), [hostCatalog.profiles, environmentSnapshot.entries]);
  const composerHostOptions = useMemo(() => newConversationMachines.map(machine => ({
    id: machine.id,
    hostIds: machine.hosts.map(host => host.hostId),
    label: machineName(machine, extensionPlatform, intl),
    role: machineRole(machine, extensionPlatform),
    platform: machine.identity?.platform ?? null,
    resource: machine.resource,
    cloud: machine.cloud,
    connectable: machine.hosts.some(host => host.enabled),
  })), [newConversationMachines, extensionPlatform, intl]);
  const engineCatalog = useWorkInEngineCatalog(workInAgentHosts(activeMachine, snapshot.hostId).filter(host => draft === null || host.hideFromNewChat !== true || host.hostId === snapshot.hostId).map(host => host.hostId), snapshot.hostId);
  const queryClient = useQueryClient();
  const blobs = useBlobResources();
  const images = useImageProcessing();
  const loadMediaSource = useMemo(
    () =>
      createAppServerMediaSourceLoader(runtime, blobs, snapshot.hostId),
    [blobs, runtime, snapshot.hostId],
  );
  const resolveActiveHostAttachment = useCallback(
    (file: File, pending: ComposerAttachment, signal?: AbortSignal) =>
      resolveBrowserAttachmentForHost(runtime, file, pending, images, signal),
    [runtime, images],
  );
  const removeActiveHostAttachment = useCallback(
    async (attachment: ComposerAttachment) => {
      const ref = attachment.metadata?.attachmentRef;
      if (typeof ref !== "object" || ref === null || !("id" in ref) || typeof ref.id !== "string") return;
      const ownerHostId = typeof attachment.metadata?.attachmentHostId === "string" ? attachment.metadata.attachmentHostId : snapshot.hostId;
      if (ownerHostId === snapshot.hostId) await runtime.resources.attachments.remove(ref.id);
      else await hostCatalog.agentRuntimes.request(ownerHostId, "attachment/remove", { id: ref.id });
    },
    [runtime, snapshot.hostId, hostCatalog.agentRuntimes],
  );
  const rawCatalog = useThreadCatalog();
  const rawMultiHostCatalog = useMultiHostThreadCatalog();
  const threadPinWriter = useThreadPinWriter();
  const pinRevision = useSyncExternalStore(threadPinWriter.subscribe, threadPinWriter.getSnapshot, threadPinWriter.getSnapshot);
  const catalog = { ...rawCatalog, threads: useMemo(() => rawCatalog.threads.map(thread =>
    threadPinWriter.project({ hostId: snapshot.hostId, threadId: thread.id }, thread)),
  [rawCatalog.threads, threadPinWriter, pinRevision, snapshot.hostId, snapshot.connectionGeneration, snapshot.phase]) };
  const multiHostCatalog = { ...rawMultiHostCatalog, threads: useMemo(() => rawMultiHostCatalog.threads.map(thread =>
    threadPinWriter.project({ hostId: thread.connectionHostId, threadId: thread.id }, thread)),
  [rawMultiHostCatalog.threads, threadPinWriter, pinRevision]) };
  const projectCatalog = useProjectCatalog();
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const { sidebarOpen, setSidebarOpen } = useResponsiveSidebarDock();
  const { width: sidebarWidth, commit: commitSidebarWidth } = usePersistedSidebarWidth(presentation.shellNavigation);
  // layout token. Top-level routes consume the token instead of inventing
  // route-local widths, so switching routes cannot move the content boundary.
  useLayoutEffect(() => {
    if (!presentation.contextSidebar) return;
    document.documentElement.style.setProperty(
      "--opencraft-sidebar-preferred-width",
      `${sidebarWidth}px`,
    );
    return () => {
      document.documentElement.style.removeProperty(
        "--opencraft-sidebar-preferred-width",
      );
    };
  }, [presentation.contextSidebar, sidebarWidth]);
  const timelineSurfaceCapabilities = useMemo<TimelineSurfaceCapabilities>(
    () => ({
      // These are renderer capabilities, not values inferred from AppServer data.
      embeddedPortalTarget: true,
      hasLiveEmbeddedSurface: false,
      pipAnchorHostId: null,
      // The current task panel consumes an explicit gutter. Shift/overlay hosts
      // can supply a motion value through this same boundary later.
      wideContentOffsetPx: 0,
    }),
    [],
  );
  const routeRestoreCheckpoints = hostCatalog.routeCheckpoints as Map<
    string,
    ConversationRestoreSnapshot
  >;
  const conversationScrollApiRef = useRef<ConversationScrollApi | null>(null);
  const pendingLatestTurnPlacementRef = useRef<LatestTurnPlacementSnapshot | null>(null);
  const captureLatestTurnPlacement = useCallback(() => {
    const placement = conversationScrollApiRef.current?.captureLatestTurnSubmitPlacement() ?? null;
    pendingLatestTurnPlacementRef.current = placement;
    return placement;
  }, []);
  const clearLatestTurnPlacement = useCallback((placement: LatestTurnPlacementSnapshot | null) => {
    if (placement !== null && pendingLatestTurnPlacementRef.current === placement) {
      pendingLatestTurnPlacementRef.current = null;
      conversationScrollApiRef.current?.releaseLatestTurnSubmitPlacementCapture();
    }
  }, []);
  const consumeLatestTurnPlacement = useCallback(() => {
    const placement = pendingLatestTurnPlacementRef.current;
    pendingLatestTurnPlacementRef.current = null;
    return placement;
  }, []);
  const activeThreadId = snapshot.activeThreadId;
  const displayKey = useConversationViewDisplayKey();
  const localThreadId = activeThreadId ?? (displayKey?.hostId === snapshot.hostId ? displayKey.threadId : null);
  const localOutbox = useMemo(() => localThreadId === null ? null : runtime.localOutbox?.(localThreadId) ?? null,
    [runtime, localThreadId]);
  const subscribeLocalOutbox = useCallback((listener: () => void) => localOutbox?.subscribe(listener) ?? (() => {}), [localOutbox]);
  const localOutboxRevision = useSyncExternalStore(subscribeLocalOutbox, localOutbox?.getRevision ?? (() => 0));
  const localQueuedSubmissions = useMemo(() => localOutbox?.project() ?? [], [localOutbox, localOutboxRevision]);
  const workbenchNavigation = hostCatalog.navigation;
  const workbenchNavigationSnapshot = useSyncExternalStore(
    workbenchNavigation.subscribe,
    workbenchNavigation.getSnapshot,
    workbenchNavigation.getSnapshot,
  );
  const routeHeader = useAppShellRouteHeader(
    workbenchNavigationSnapshot.routeScopeId,
  );
  const desktopBackdrop = useApplicationDesktopBackdrop(workbenchNavigationSnapshot.applicationRoute);
  const canGoBack = workbenchNavigationSnapshot.canGoBack;
  const canGoForward = workbenchNavigationSnapshot.canGoForward;
  const settingsOpen =
    presentation.machineManagement && workbenchNavigationSnapshot.applicationRoute.kind === "settings";
  const extensionViewOpen =
    workbenchNavigationSnapshot.applicationRoute.kind === "extension-view";
  const conversationRouteOpen =
    workbenchNavigationSnapshot.applicationRoute.kind === "conversation";
  const pendingFirstSubmission = draft?.submission ?? null;
  useEffect(() => {
    if (pendingFirstSubmission === null || !conversationRouteOpen) return;
    const frame = requestAnimationFrame(() => composerController.focus());
    return () => cancelAnimationFrame(frame);
  }, [composerController, pendingFirstSubmission, conversationRouteOpen]);

  useEffect(() => {
    hostCatalog.setConversationPresentationActive?.(conversationRouteOpen);
    return () => hostCatalog.setConversationPresentationActive?.(false);
  }, [hostCatalog.setConversationPresentationActive, conversationRouteOpen]);
  const settingsSection =
    workbenchNavigationSnapshot.applicationRoute.kind === "settings"
      ? workbenchNavigationSnapshot.applicationRoute.slug
      : "appearance";
  const settingsContributionSnapshot = useSyncExternalStore(
    hostCatalog.extensionContributions.subscribe,
    hostCatalog.extensionContributions.getSnapshot,
    hostCatalog.extensionContributions.getSnapshot,
  );
  const selectedSettingsContribution = settingsContributionSnapshot.settingsPages.find(
    ({ contribution }) => contribution.id === settingsSection,
  )?.contribution ?? null;
  const managementSettingsOpen = settingsOpen
    && selectedSettingsContribution?.management !== undefined;
  const standaloneManagementOpen = managementSettingsOpen
    && isWorkbenchToolPage(selectedSettingsContribution);
  const routeSettingsOpen = settingsOpen && !managementSettingsOpen;
  // A target-management route is a modal semantic surface. The underlying
  // conversation keeps its physical shell and geometry, but is inert while
  // the dialog owns interaction and focus.
  const conversationSurfaceVisible = conversationRouteOpen
    || (managementSettingsOpen && !standaloneManagementOpen);
  const shellSidebarOpen = presentation.contextSidebar ? sidebarOpen : false;
  const openSettingsFromConversation = useCallback((slug?: string) => {
    const focusedElement = document.activeElement;
    if (
      focusedElement instanceof HTMLElement &&
      focusedElement.closest(".workbench-conversation-route") !== null
    ) {
      focusedElement.blur();
    }
    workbenchNavigation.openSettings(slug);
  }, [workbenchNavigation]);
  const extensionViewHost = useMemo<PlatformViewHost>(() => ({
    authentication: hostCatalog.authenticationFlows,
    platform: extensionPlatform,
    activeHostId: snapshot.hostId,
    profiles: hostCatalog.profiles,
    ensureRuntimeReady: async (hostId) => { await hostCatalog.agentRuntimes.ensureReady(hostId); },
    provisionHost: hostCatalog.provisionHost,
    removeHost: hostCatalog.removeHost,
    openView: workbenchNavigation.openExtensionView,
    openConversation: async (serverId, threadId) => {
      const profile = hostCatalog.profiles.find(profile => legacyDirectServerProjectionFromHost({
        hostId: profile.hostId, hostKind: profile.hostKind, label: profile.displayName,
      }).serverOrigin.serverId === serverId);
      if (!profile) throw new Error("Conversation Server is not connected");
      await workbenchNavigation.selectConversation(createWorkbenchThreadLocation(profile.hostId, threadId));
    },
    openSettings: (section: string) => { setAccountOpen(false); workbenchNavigation.openSettings(section); },
    pushViewResource: workbenchNavigation.pushExtensionViewResource,
    replaceViewResource: workbenchNavigation.replaceExtensionViewResource,
    prepareImageUpload: async (blob) => (await images.compress(blob)).blob,
  }), [extensionPlatform, hostCatalog, images, snapshot.hostId, workbenchNavigation]);
  const imageEditor = useSyncExternalStore(hostCatalog.imageEditors?.subscribe ?? NO_IMAGE_EDITOR_SUBSCRIPTION, hostCatalog.imageEditors?.getSnapshot ?? NO_IMAGE_EDITOR_SNAPSHOT).contribution;
  const identityAvatar = useSyncExternalStore(hostCatalog.identityAvatars.subscribe, hostCatalog.identityAvatars.getSnapshot).contribution;
  const threadListGrouping = useSyncExternalStore(hostCatalog.threadListGrouping.subscribe, hostCatalog.threadListGrouping.getSnapshot).contribution;
  const branding = useSyncExternalStore(hostCatalog.applicationBranding.subscribe, hostCatalog.applicationBranding.getSnapshot).contribution ?? DEFAULT_APPLICATION_BRANDING;
  useEffect(() => {
    if (embedded !== undefined || extensionPlatform !== "web") return;
    return applyApplicationBranding(document, branding);
  }, [branding, embedded, extensionPlatform]);
  const threadBadge = useSyncExternalStore(hostCatalog.threadBadges.subscribe, hostCatalog.threadBadges.getSnapshot).contribution;
  const extensionProjection = useExtensionWorkbenchProjection({
    contributions: hostCatalog.extensionContributions,
    renderers: hostCatalog.platformViewRenderers,
    accounts: hostCatalog.platformAccounts,
    botDirectory: hostCatalog.botDirectory,
    host: extensionViewHost,
    applicationRoute: workbenchNavigationSnapshot.applicationRoute,
    internalDeveloperMode,
    openSettings: workbenchNavigation.openSettings,
    openView: workbenchNavigation.openExtensionView,
  });
  const connectorPresentation = useConnectorPresentation(hostCatalog.connectorManager, hostCatalog.connectorApprovals,
    { hostId: hostCatalog.selectedHostId, scopeId: conversationViewIdentity.scopeId }, extensionProjection.manageConnectors);
  const composerEndActions = (
    <>{presentation.connectorLauncher ? connectorPresentation.launcher : null}<ComposerExtensionActions
      actionIds={presentation.composerActions}
      controller={composerController}
      disabled={draft !== null && draftSubmissionOwnsNavigation(draft.phase)}
      platform={extensionPlatform}
      registry={hostCatalog.composerActionRenderers}
    /></>
  );
  const composerAddMenuContent = presentation.connectorLauncher
    ? connectorPresentation.addMenuContent
    : null;
  useEffect(() => {
    if (extensionProjection.account?.snapshot.phase === "anonymous" && extensionProjection.account.provider.signInViewId) setAccountOpen(false);
  }, [extensionProjection.account?.snapshot.phase, extensionProjection.account?.provider]);
  const authenticationPresentation = useAuthenticationPresentation(hostCatalog.authenticationFlows, extensionProjection.account,
    JSON.stringify([hostCatalog.currentLocation, workbenchNavigationSnapshot.applicationRoute]));
  const hostConnectionIntervention = findHostConnectionInterventionError(
    conversationViewActivation.error,
  );
  const activeHostProviderId = hostCatalog.profiles.find(
    (profile) => profile.hostId === activeHost.hostId,
  )?.providerId ?? null;
  const hostShortcutCommands = activeHost.hostId === snapshot.hostId
    ? runtime.resources.composerCommands?.commands.map(command => ({
      name: command.name, description: intl.formatMessage(command.description),
    })) : undefined;
  // Account/catalog availability never owns the working conversation surface.
  // Only the selected Host's actual connection failure may request intervention.
  const connectionIntervention = hostConnectionIntervention?.providerId === activeHostProviderId
      ? hostConnectionIntervention
      : null;
  const connectionInterventionNode = connectionIntervention === null
    ? null
    : extensionProjection.connectionInterventions.find(
      (surface) => surface.providerId === connectionIntervention.providerId
        && surface.intervention === connectionIntervention.code,
    )?.node ?? null;
  useEffect(() => {
    if (extensionViewOpen && extensionProjection.activeView === null) {
      workbenchNavigation.closeExtensionView();
    }
  }, [extensionProjection.activeView, extensionViewOpen, workbenchNavigation]);
  const activeConversationRestoreKey = conversationViewIdentity.viewId;
  const [interactionDraftStore] = useState(() => new InteractionDraftStore());
  const [mcpAppWidgetStates] = useState<McpAppWidgetStateStore>(() => new Map());
  useObservedReadiness(draft === null ? activeConversationRestoreKey : null, snapshot.phase === 'ready' && activeThreadLease !== null
    && snapshot.conversation?.authoritative === true && runtime.resources.host.canRequest?.('turn/start') === true);
  useEffect(() => () => {
    pendingLatestTurnPlacementRef.current = null;
    conversationScrollApiRef.current?.releaseLatestTurnSubmitPlacementCapture();
  }, [activeConversationRestoreKey]);
  const lastDraftWorkspaceRef = useRef(
    draft?.target.execution.workspace ?? {
      cwd: null,
      runtimeWorkspaceRoots: [] as readonly string[],
    },
  );

  const selectDraftWorkspace = useCallback(
    (workspace: {
      readonly cwd: string;
      readonly runtimeWorkspaceRoots: readonly string[];
      readonly projectId?: string;
    }) => {
      if (presentation.executionSelection === "fixed") return;
      lastDraftWorkspaceRef.current = workspace;
      const key = selectedProjectStorageKey(draft?.target.execution.hostId ?? snapshot.hostId);
      setLocalPreference(key, workspace.projectId ?? null);
      if (draft === null) throw new Error("No active Draft can be retargeted");
      hostCatalog.retargetDraft(draft.id, {
        hostId: draft.target.execution.hostId,
        workspace,
      });
    },
    [presentation.executionSelection, draft, hostCatalog, snapshot.hostId],
  );

  const conversationResourceOwnerId = conversationViewIdentity.scopeId;
  // Navigation entries are replaceable presentations of one conversation.
  // Layout and resource tabs belong to the stable conversation, not that entry.
  const panelOwnerId = conversationResourceOwnerId;
  const panelPresentationId = conversationViewIdentity.viewId;
  const panelRuntime = useWorkbenchPanelRuntime();
  const browserWorkbench = useBrowserWorkbench();
  const panelState = useConversationPanelState(panelOwnerId);
  const panelRenderers = usePanelRendererSnapshot();
  const allPanelToolbarActions = usePanelToolbarActions();
  const panelToolbarActions = allPanelToolbarActions
    .filter(action => presentation.panelActions === "all" || presentation.panelActions.includes(action.id))
    .map(action => action.id === "opencraft.browser.new-tab" ? { ...action,
      label: intl.formatMessage({ id: "panel.newBrowser", defaultMessage: "New browser tab" }),
      creationLabel: intl.formatMessage({ id: "panel.browser", defaultMessage: "Browser" }),
    } : action.id === "opencraft.cloud-desktop.open" ? { ...action,
      label: intl.formatMessage({ id: "panel.desktopEntry", defaultMessage: "Cloud computer" }),
      creationLabel: intl.formatMessage({ id: "panel.desktopEntry", defaultMessage: "Cloud computer" }),
    } : action.id === "workspace.files.open" ? { ...action,
      label: intl.formatMessage({ id: "panel.openFiles", defaultMessage: "Open files" }),
      creationLabel: intl.formatMessage({ id: "panel.files", defaultMessage: "Files" }),
    } : action);
  const panelToolbarContext: PanelToolbarActionContext = {
    threadId: draft ? null : activeThreadId,
    projectId: draft?.target.execution.workspace.projectId ?? catalog.protocolThreads.find(thread => thread.id === activeThreadId)?.projectId ?? null,
    ownerId: panelOwnerId, resourceOwnerId: conversationResourceOwnerId, hostId: snapshot.hostId,
    cwd: snapshot.conversation?.execution.cwd ?? catalog.protocolThreads.find(thread => thread.id === activeThreadId)?.cwd
      ?? draft?.target.execution.workspace.cwd ?? activeHost.workspaceBrowseRoots[0] ?? null,
  };
  const sideChatAction = panelToolbarActions.find(action => action.id === "sidechat.new");
  const threadShortcutCommands = activeThreadLease !== null && sideChatAction
    && (sideChatAction.isAvailable?.(panelToolbarContext) ?? true)
    ? [{ name: SIDE_CHAT_COMPOSER_COMMAND.name, description: sideChatAction.label, submitOnSelect: true },
      ...(hostShortcutCommands ?? []).filter(command => command.name !== SIDE_CHAT_COMPOSER_COMMAND.name)]
    : hostShortcutCommands;
  const presentedPanelRenderers = presentation.filePreviewOnly
    ? panelRenderers.filter(renderer => renderer.kind === "browser" || renderer.kind === "resource" || renderer.kind === "cloud-desktop")
      .map(renderer => renderer.kind === "resource" ? { ...renderer, Component: WorkspaceResourcePreviewPanel } : renderer)
    : panelRenderers;
  const requestClosePanel = (tab: PanelTabDescriptor) => {
    if (tab.kind === "sidechat" && tab.resource && panelRuntime.context.sideChats?.hasContent(tab.resource)) {
      setClosingSideChat({ ownerId: panelOwnerId, tab });
    } else panelRuntime.panels.close(panelOwnerId, tab.region, tab.id);
  };
  const dispatchPanel = useCallback(
    (action: PanelAction) => {
      panelRuntime.panels.dispatch(panelOwnerId, action);
    },
    [panelRuntime.panels, panelOwnerId],
  );
  const toggleRightPanel = useCallback(() => {
    if (panelState.right.open) {
      dispatchPanel({
        type: "set-region-open",
        region: "right",
        open: false,
        reason: "manual",
      });
      return;
    }
    // content and permits an empty RightPanel outlet. A concrete tab is only
    // created by a real capability action.
    dispatchPanel({
      type: "set-region-open",
      region: "right",
      open: true,
      reason: "manual",
      allowEmpty: panelState.right.tabs.length === 0,
    });
  }, [dispatchPanel, panelState.right.open, panelState.right.tabs.length]);
  const timeline = snapshot.conversation?.timeline ?? null;
  // The committed View has a display identity before network lease acquisition.
  // This local binding never grants execution or authoritative history access.
  const { selection: display, scope: displayScope, hasSubmission } = useConversationDisplay(hostCatalog.displayContinuity, displayKey, timeline);
  const displayHostId = displayKey?.hostId ?? null;
  const displayThreadId = displayKey?.threadId ?? null;
  const visibleTimeline = useThreadOrchestrationTimeline(display.timeline,runtime.resources.orchestration,
    displayHostId === snapshot.hostId && snapshot.transport.state === "open");
  const showingDisplayCache = display.source !== "history" && display.source !== "empty";
  const historyPaintObserver = workbenchNavigation.historyFirstPaint;
  const historyPaintAttempt = useSyncExternalStore(historyPaintObserver.subscribe, historyPaintObserver.getSnapshot, historyPaintObserver.getSnapshot);
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === "hidden") historyPaintObserver.abort(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [historyPaintObserver]);
  const historyPaintOwnsView = historyPaintAttempt?.viewId === conversationViewIdentity.viewId && conversationRouteOpen;
  const historyPaintTurns = historyPaintOwnsView ? new Set(visibleTimeline?.frames.map(frame => frame.turnId) ?? []).size : 0;
  const historyPaintLength = historyLengthBucket(historyPaintTurns,
    !showingDisplayCache && snapshot.conversation?.authoritative === true && snapshot.conversation.history.hasOlder === false, visibleTimeline?.historyTurnCount);
  const historyPaintEngine = historyEngine(engineExtensions, displayThreadId);
  const historyPaintReady = historyPaintOwnsView && (visibleTimeline?.frames.length ?? 0) > 0;
  const onHistoryVisibleContentReady = useCallback(() => {
    if (historyPaintAttempt && historyPaintReady) historyPaintObserver.settle(historyPaintAttempt, "ok", {lengthBucket: historyPaintLength, engine: historyPaintEngine});
  }, [historyPaintObserver, historyPaintAttempt, historyPaintReady, historyPaintLength, historyPaintEngine]);
  useEffect(() => {
    if (!historyPaintAttempt || !historyPaintOwnsView) return;
    if (snapshot.phase === "error" || conversationViewActivation.phase === "error" || snapshot.conversation?.error || snapshot.conversation?.history.error ) {
      historyPaintObserver.settle(historyPaintAttempt, "failed", {lengthBucket: historyPaintLength, engine: historyPaintEngine});
    } else if (!showingDisplayCache && snapshot.conversation?.authoritative && historyPaintTurns === 0 && !snapshot.conversation.history.hasOlder) {
      historyPaintObserver.settle(historyPaintAttempt, "empty", {lengthBucket: historyPaintLength, engine: historyPaintEngine});
    }
  }, [historyPaintObserver, historyPaintAttempt, historyPaintOwnsView, conversationViewActivation.phase, snapshot.phase, snapshot.conversation, historyPaintLength, historyPaintEngine, showingDisplayCache, historyPaintTurns]);

  const displayCounts = useMemo(() => displayTimingCounts(visibleTimeline), [visibleTimeline]);
  const displaySignature = JSON.stringify(displayCounts);
  useEffect(() => {
    if (!displayCounts.messages) return;
    const frame = requestAnimationFrame(() => {
      const times = [...document.querySelectorAll(".thread-user-message time, [data-assistant-message-sent-time]")];
      const visibleTimes = times.filter(element => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        for (let node: Element | null = element; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
        }
        return true;
      }).length;
      reportDisplayEvent("display-paint", { ...displayCounts, renderedTimes: times.length, visibleTimes });
    });
    return () => cancelAnimationFrame(frame);
    // The signature reports coverage transitions, not every streaming delta.
  }, [displaySignature, displayScope, displayHostId, displayThreadId]);


  const [turnDiffReview, setTurnDiffReview] = useState<{
    readonly block: TurnDiffTimelineBlock;
    readonly path: string | null;
    readonly threadId: string;
  } | null>(null);
  const openTurnDiffReview = useCallback((block: TurnDiffTimelineBlock, path?: string) => {
    if (activeThreadId !== null) setTurnDiffReview({ block, path: path ?? null, threadId: activeThreadId });
  }, [activeThreadId]);
  const reviewedBlock = turnDiffReview?.threadId === activeThreadId
    ? timeline?.frames.flatMap((frame) => frame.changeSummary == null ? frame.blocks : [frame.changeSummary, ...frame.blocks]).find((block): block is TurnDiffTimelineBlock =>
      block.type === "turn-diff" && block.id === turnDiffReview.block.id) ?? turnDiffReview.block
    : null;
  const recoveryRequiresUpdate = snapshot.transport.failure?.code === "APP_HOST_PROTOCOL_MISMATCH";
  const recoveryPresentation = conversationRecoveryPresentation({
    authoritative: snapshot.conversation?.authoritative === true,
    hasVisibleHistory: (visibleTimeline?.frames.length ?? 0) > 0,
    failed: snapshot.phase === "error" || (activeThreadLease === null
      ? conversationViewActivation.phase === "error"
      : snapshot.conversation?.error != null),
  });
  const recoveryDiagnostic = useConversationRecoveryDiagnostic({
    scope: JSON.stringify([displayScope, snapshot.hostId, activeThreadId]),
    failed: recoveryPresentation === "cold-error" || recoveryPresentation === "warm-error",
    active: recoveryPresentation !== "none",
    progress: snapshot.phase !== "ready" ? snapshot.recovery
      : snapshot.residentThreads.find(thread => thread.threadId === activeThreadId)?.recovery,
    stage: snapshot.phase !== "ready" ? "connection"
      : activeThreadLease === null ? "activation" : "history",
    error: snapshot.phase === "error" ? snapshot.error
      : activeThreadLease === null ? conversationViewActivation.error : snapshot.conversation?.error,
    runtime: snapshot.phase,
    transport: snapshot.transport,
  });
  const conversationRecovering = activeThreadId !== null
    && conversationRecoveryIsPending(recoveryPresentation, recoveryDiagnostic, recoveryRequiresUpdate);
  const connectionRecovering = snapshot.phase === "connecting" || snapshot.phase === "reconnecting"
    || (snapshot.phase === "error" && conversationRecoveryIsPending("cold-error", recoveryDiagnostic, recoveryRequiresUpdate));
  const recoveryPlaceholder = connectionRecovering
    ? intl.formatMessage({ id: "chat.composer.reconnecting", defaultMessage: "Reconnecting…" })
    : conversationRecovering
      ? intl.formatMessage({ id: "chat.composer.loading", defaultMessage: "Loading…" })
      : undefined;
  useEffect(() => {
    if (recoveryPresentation !== "cold-error" && recoveryPresentation !== "warm-error") return;
    console.info("[conversation-recovery] failed", {
      hostId: snapshot.hostId,
      threadId: activeThreadId,
      presentation: recoveryPresentation,
      runtimePhase: snapshot.phase,
      activationPhase: conversationViewActivation.phase,
    });
  }, [recoveryPresentation, snapshot.hostId, activeThreadId, snapshot.phase, conversationViewActivation.phase]);
  const navigationSource = activeThreadLease?.getNavigation() ?? null;
  const pendingInteraction = useMemo(
    () => findPendingInteraction(timeline),
    [timeline],
  );
  const isStreaming =
    snapshot.conversation?.activeTurn !== null &&
    snapshot.conversation?.activeTurn !== undefined;
  const stopOwnerRef = useRef(activeThreadLease);
  stopOwnerRef.current = activeThreadLease;
  const cancelStream = useCallback((context: {
    readonly trigger: "pointer" | "keyboard";
    readonly isTrusted: boolean;
    readonly occurredAt: number;
  }) => {
    const turnId = activeThreadLease?.getSnapshot().activeTurn?.turnId;
    if (turnId !== undefined) void activeThreadLease?.interrupt(turnId, {
      source: "composer-stop",
      ...context,
    }).catch(() => {
      if (stopOwnerRef.current !== activeThreadLease || activeThreadLease?.getSnapshot().activeTurn?.turnId !== turnId) return;
      notices.error({ key: `stop:${snapshot.hostId}:${activeThreadId}:${turnId}`,
        message: intl.formatMessage({ id: "chat.stop.failed", defaultMessage: "Could not stop the response. Try again." }) });
    });
  }, [activeThreadLease, notices, intl, snapshot.hostId, activeThreadId]);
  const updateQueuedSubmission = useCallback(
    async (id: string, intent: SubmitIntent) => {
      if (activeThreadLease === null)
        throw new Error("No active Thread owns this queue");
      await activeThreadLease.updateQueuedSubmission(
        id,
        compileSubmitIntent(intent).input,
      );
    },
    [activeThreadLease],
  );
  const deleteQueuedSubmission = useCallback(
    async (id: string) => {
      if (activeThreadLease === null) {
        if (localOutbox && await localOutbox.remove(id)) return;
        throw new Error("No active Thread owns this queue");
      }
      await activeThreadLease.deleteQueuedSubmission(id);
    },
    [activeThreadLease, localOutbox],
  );
  const discardUnconfirmedSteer = useCallback(
    async (id: string, expectedTurnId: string) => {
      if (activeThreadLease === null)
        throw new Error("No active Thread owns this steering claim");
      await activeThreadLease.discardUnconfirmedSteer(id, asTurnId(expectedTurnId));
    },
    [activeThreadLease],
  );
  const reorderQueuedSubmissions = useCallback(
    async (ids: readonly string[]) => {
      if (activeThreadLease === null)
        throw new Error("No active Thread owns this queue");
      await activeThreadLease.reorderQueuedSubmissions(ids);
    },
    [activeThreadLease],
  );
  const steerQueuedSubmission = useCallback(
    async (id: string) => {
      if (activeThreadLease === null)
        throw new Error("No active Thread owns this queue");
      await activeThreadLease.steerQueuedSubmission(id);
    },
    [activeThreadLease],
  );
  const resumeQueuedSubmissions = useCallback(async () => {
    if (activeThreadLease === null)
      throw new Error("No active Thread owns this queue");
    await activeThreadLease.startQueuedSubmission();
  }, [activeThreadLease]);
  const mcpAppOwnerRef = useRef<ReturnType<typeof createMcpAppOwner> | null>(null);
  const sendMessage = useCallback(
    (
      intent: SubmitIntent,
      context: { readonly followUpAction: ComposerFollowUpAction | null },
    ): boolean | Promise<boolean> => {
      const sideChatSnapshot = activeThreadLease?.getSnapshot() ?? null;
      const sideChatCommand = runSideChatComposerCommand(intent, {
        key: sideChatSnapshot?.key ?? null,
        authoritative: snapshot.phase === "ready" && sideChatSnapshot?.authoritative === true,
        action: sideChatAction, context: panelToolbarContext,
      });
      if (sideChatCommand !== null) return sideChatCommand;
      if (activeThreadLease === null && localOutbox && intent.target.type !== "new-thread"
        && intent.target.key.hostId === snapshot.hostId && intent.target.key.threadId === localThreadId) {
        return localOutbox.admit(intent).then(() => true);
      }
      // Host connectivity gates command admission, never Draft editability.
      // Re-check at the semantic boundary as the status can change between a
      // rendered enabled button and its click handler.
      const localQueueAdmission = intent.target.type !== "new-thread" && activeThreadLease !== null
        && (snapshot.phase !== "ready" || activeThreadLease.getSnapshot().authoritative !== true
          || activeThreadLease.getSnapshot().queuedSubmissions.some(item => item.local));
      if (snapshot.phase !== "ready" && !localQueueAdmission) return false;
      if (!localQueueAdmission && context.followUpAction !== null && runtime.resources.host.canRequest?.(
        context.followUpAction === "queue" ? "thread/queue/add" : "turn/steer",
      ) === false) return false;
      const currentConversation = activeThreadLease?.getSnapshot() ?? null;
      const intentHostId = intent.target.type === "new-thread"
        ? intent.target.execution.hostId
        : intent.target.key.hostId;
      const hostCommandPort = runtime.resources.composerCommands;
      const hostAction = hostCommandPort === undefined ? null
        : findStandaloneHostComposerAction(intent, hostCommandPort.commands);
      if (!localQueueAdmission && intentHostId === snapshot.hostId && hostAction !== null && hostCommandPort) {
        const threadId = intent.target.type === "new-thread" ? null : intent.target.key.threadId;
        const expectedTurnId = threadId !== null
          && currentConversation?.key.hostId === intentHostId
          && currentConversation.key.threadId === threadId
          ? currentConversation.activeTurn?.turnId ?? null
          : null;
        const invoking = hostCommandPort.invoke(hostAction.name, {
          threadId,
          expectedTurnId,
        });
        if (context.followUpAction !== null) {
          void invoking.catch(error => {
            const target = composerController.getSnapshot().draft.target;
            if (target.type === "existing-thread" && target.key.hostId === intentHostId && target.key.threadId === threadId) {
              composerController.dispatch({ type: "set-lifecycle", phase: "failed", error: error instanceof Error ? error.message : String(error) });
            }
          });
        }
        return invoking.then(() => true);
      }
      let submittedIntent = intent;
      let submittedPlacement: LatestTurnPlacementSnapshot | null = null;
      const followsActiveTurn =
        context.followUpAction !== null &&
        currentConversation?.activeTurn !== null &&
        currentConversation?.activeTurn !== undefined;
      if (followsActiveTurn) {
        submittedIntent = retargetSubmitIntentForFollowUp(
          intent,
          currentConversation.key,
          currentConversation.activeTurn.turnId,
          context.followUpAction!,
        );
      }
      if (
        intent.target.type !== "new-thread"
        && (!followsActiveTurn || context.followUpAction === "steer")
      ) {
        // The response may finish between the render and the click. In that
        // race the user's message becomes a normal next turn instead of being
        // rejected or lost. Steering also creates a new latest Activity inside
        // the same Turn, so it owns the identical placement transaction.
        submittedPlacement = captureLatestTurnPlacement();
      }
      let submission: ReturnType<typeof hostCatalog.submit>;
      try {
        if (intent.target.type !== "new-thread" && intent.target.key.hostId === snapshot.hostId
          && intent.target.key.threadId === activeThreadLease?.getSnapshot().key.threadId) {
          submittedIntent = mcpAppOwnerRef.current?.augment(submittedIntent) ?? submittedIntent;
        }
        submission = hostCatalog.submit(submittedIntent);
      } catch (error) {
        clearLatestTurnPlacement(submittedPlacement);
        throw error;
      }

      if (intent.target.type !== "new-thread") {
        return completeConversationComposerSubmission(submittedIntent, submission,
          activeThreadLease?.getSnapshot() ?? null,
          () => clearLatestTurnPlacement(submittedPlacement));
      }

      // The Conversation Scope synchronously owns the immutable first Turn,
      // even before the Host has assigned a Thread ID. The Composer can clear
      // immediately; thread creation, promotion and a failed first Turn are
      // projected by that same Scope instead of retaining duplicate editor text.
      void submission.catch(() => {
        clearLatestTurnPlacement(submittedPlacement);
      });
      return true;
    },
    [
      conversationScopes,
      sideChatAction,
      panelToolbarContext,
      hostCatalog,
      queryClient,
      activeThreadLease,
      localThreadId,
      localOutbox,
      composerController,
      captureLatestTurnPlacement,
      clearLatestTurnPlacement,
      snapshot.hostId,
      snapshot.phase,
      runtime,
    ],
  );
  const appSendMessageRef = useRef(sendMessage);
  appSendMessageRef.current = sendMessage;
  const mcpAppsAuthoritative = snapshot.conversation?.authoritative === true;
  const mcpAppOwner = useMemo(() => {
    if (activeThreadId === null || activeThreadLease === null || showingDisplayCache || !mcpAppsAuthoritative || snapshot.phase !== "ready") return null;
    const generation = runtime.resources.host.getConnectionGeneration?.() ?? 0;
    const assertCurrent = () => {
      const current = activeThreadLease.getSnapshot();
      if (mcpAppOwnerRef.current !== owner || runtime.getSnapshot().phase !== "ready" || !current.authoritative
        || current.key.hostId !== snapshot.hostId || current.key.threadId !== activeThreadId
        || (runtime.resources.host.getConnectionGeneration?.() ?? 0) !== generation) throw new Error("MCP App owner is no longer current");
    };
    const owner: ReturnType<typeof createMcpAppOwner> = createMcpAppOwner({
      key: `${snapshot.hostId}:${activeThreadId}:${generation}`, threadId: activeThreadId, assertCurrent,
      widgetStateStore: { scope: JSON.stringify([snapshot.hostId, activeThreadId]), entries: mcpAppWidgetStates },
      request: (method, params) => runtime.resources.protocol.request(method, params),
      openLink: url => { window.open(url, "_blank", "noopener,noreferrer"); },
      sendMessage: async text => {
        assertCurrent();
        const draft = composerController.getSnapshot().draft;
        const id = createClientId();
        const intent: SubmitIntent = { commandId: id, clientMessageId: id,
          target: { type: "existing-thread", key: activeThreadLease.getSnapshot().key },
          document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text }] }] },
          attachments: [], context: [], selections: draft.selections, options: { autoContext: false }, createdAt: Date.now() };
        const accepted = await appSendMessageRef.current(intent, { followUpAction: activeThreadLease.getSnapshot().activeTurn ? "steer" : null });
        if (!accepted) throw new Error("App message was not admitted");
      },
    });
    return owner;
  }, [activeThreadId, activeThreadLease, showingDisplayCache, mcpAppsAuthoritative, snapshot.phase, snapshot.hostId, runtime, composerController, mcpAppWidgetStates]);
  mcpAppOwnerRef.current = mcpAppOwner;
  const answerAsyncQuestion = useCallback(async (question: AsyncQuestion, answer: string) => {
    if (snapshot.phase !== "ready" || activeThreadLease === null) throw new Error("Reconnect to answer this question");
    const conversation = activeThreadLease.getSnapshot();
    if (!conversation.authoritative || deriveAsyncQuestionStates(conversation.timeline).get(question.id) !== "pending") {
      throw new Error("This question is no longer available");
    }
    const currentDraft = composerController.getSnapshot().draft;
    if (currentDraft.target.type !== "existing-thread"
      || currentDraft.target.key.hostId !== conversation.key.hostId
      || currentDraft.target.key.threadId !== conversation.key.threadId) {
      throw new Error("The composer is attached to a different conversation");
    }
    const reply = renderAsyncQuestionReply(question, answer);
    const baseIntent: SubmitIntent = {
      commandId: createClientId(),
      clientMessageId: createClientId(),
      target: { type: "existing-thread", key: conversation.key },
      document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: reply }] }] },
      attachments: [],
      context: [],
      selections: currentDraft.selections,
      options: currentDraft.options,
      createdAt: Date.now(),
    };
    const intent = conversation.activeTurn === null ? baseIntent : retargetSubmitIntentForFollowUp(
      baseIntent, conversation.key, conversation.activeTurn.turnId, "steer",
    );
    await hostCatalog.submit(intent);
  }, [snapshot.phase, activeThreadLease, composerController, hostCatalog]);
  const queuedAsyncQuestionIds = useMemo(() => (snapshot.conversation?.queuedSubmissions ?? []).flatMap((submission) => {
    if (submission.input.length !== 1) return [];
    const input = submission.input[0];
    return input?.type === "text" ? (parseAsyncQuestionReply(input.text)?.map((reply) => reply.questionItemId) ?? []) : [];
  }), [snapshot.conversation?.queuedSubmissions]);
  const respondToInteraction = useCallback(
    async (requestId: string, action: ConversationInteractionAction) => {
      const interaction = activeThreadLease
        ?.getSnapshot()
        .pendingInteractions.find(
          (candidate) => candidate.requestId === requestId,
        );
      if (interaction === undefined)
        throw new Error("This request is no longer pending");
      if (activeThreadLease === null)
        throw new Error("No active Thread is available");
      await activeThreadLease.respond(
        createInteractionResponse(interaction, action),
      );
    },
    [activeThreadLease],
  );
  const navigateToHome = useCallback(() => {
    const activeProtocolThread = catalog.protocolThreads.find(
      (thread) => thread.id === activeThreadLease?.threadId,
    );
    const activeProject =
      activeProtocolThread?.projectId == null
        ? undefined
        : projectCatalog.projects.find(
            (project) => project.id === activeProtocolThread.projectId,
          );
    const persistedProjectId = readLocalPreference(
      selectedProjectStorageKey(snapshot.hostId),
    );
    const persistedProject =
      persistedProjectId === null
        ? undefined
        : projectCatalog.projects.find(
            (project) => project.id === persistedProjectId,
          );
    const project =
      activeProject ?? persistedProject ?? projectCatalog.projects[0];
    const cwd = project?.roots[0]?.path ?? null;
    const workspace =
      project === undefined || cwd === null
        ? { cwd: null, runtimeWorkspaceRoots: [] as readonly string[] }
        : {
            cwd,
            runtimeWorkspaceRoots: project.roots.map((root) => root.path),
            projectId: project.id,
          };
    lastDraftWorkspaceRef.current = workspace;
    const hostId = asHostId(hostCatalog.selectedHostId);
    try {
      hostCatalog.navigateToHome({
        execution: { hostId, workspace },
        entrypoint: "new-chat",
      });
    } catch (error) {
      console.error("Failed to navigate to New chat Home", error);
    }
  }, [
    catalog.protocolThreads,
    conversationScopes,
    hostCatalog,
    projectCatalog.projects,
    runtime,
    setSidebarOpen,
    snapshot.hostId,
  ]);

  const openBrowserTab = useCallback(
    (initialUrl?: string, background = false) => {
      browserWorkbench.open(conversationResourceOwnerId, {
        panelOwnerId,
        hostId: snapshot.hostId,
        background,
        ...(initialUrl === undefined ? {} : { initialUrl }),
      });
    },
    [browserWorkbench, conversationResourceOwnerId, panelOwnerId, snapshot.hostId],
  );

  useLayoutEffect(() => {
    browserWorkbench.bindView(conversationResourceOwnerId, panelPresentationId);
  }, [browserWorkbench, conversationResourceOwnerId, panelPresentationId]);

  const openChatResource = useCallback(
    (target: string, decision: ChatResourceDecision, intent?: ChatResourceOpenIntent) => {
      if (decision.kind === "mail") {
        window.open(target, "_blank", "noopener,noreferrer");
        return;
      }
      if (decision.kind === "external") {
        if (intent?.target === "external-browser") {
          window.open(target, "_blank", "noopener,noreferrer");
          return;
        }
        try {
          openBrowserTab(target, intent?.disposition === "new-tab");
        } catch {
          window.open(target, "_blank", "noopener,noreferrer");
        }
        return;
      }
      if (decision.kind === "anchor") {
        document
          .getElementById(decodeURIComponent(target.slice(1)))
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      panelRuntime.panels.open(panelOwnerId, "resource", { resource: target });
    },
    [openBrowserTab, panelRuntime.panels, panelOwnerId],
  );
  const loadItemDetails = useStableEvent((ids: readonly string[], signal: AbortSignal) => activeThreadLease?.loadItemDetails(ids, signal) ?? Promise.resolve());
  const loadOlderConversation = useStableEvent(
    () => activeThreadLease?.loadOlder() ?? Promise.resolve(),
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (canHandleWorkbenchShortcut(event)) {
        const matches = (command: Parameters<typeof matchesWorkbenchShortcut>[1]) => matchesWorkbenchShortcut(event, command, navigator.platform);
        if (matches("newChat")) { event.preventDefault(); navigateToHome(); return; }
        if (presentation.shellNavigation && matches("settings")) { event.preventDefault(); openSettingsFromConversation(); return; }
        if (presentation.rightPanel && !embedded?.panelHost && conversationSurfaceVisible && (embedded === undefined || (draft === null && activeThreadId !== null)) && matches("panel")) { event.preventDefault(); toggleRightPanel(); return; }
        if (conversationRouteOpen && matches("composer")) { event.preventDefault(); composerController.focus(); return; }
        if (presentation.shellNavigation && matches("help")) { event.preventDefault(); setShortcutHelpOpen(true); return; }
      }
      // transfer to Composer when no editable surface, menu or dialog owns
      // the event; browser shortcuts and IME composition remain untouched.
      if (shouldTypeToCompose(event)) {
        event.preventDefault();
        composerController.insertText(event.key);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [composerController, navigateToHome, toggleRightPanel, presentation.shellNavigation, presentation.rightPanel, conversationRouteOpen, conversationSurfaceVisible, openSettingsFromConversation, embedded, draft, activeThreadId]);


  const collapseSidebar = useCallback(() => setSidebarOpen(false), []);
  const expandSidebar = useCallback(() => setSidebarOpen(true), []);

  const activeThread = catalog.threads.find(
    (thread) => thread.id === activeThreadId,
  );
  const activeProtocolThread = catalog.protocolThreads.find(
    (thread) => thread.id === activeThreadId,
  );
  const composerCatalog = useComposerCatalog(
    snapshot.conversation?.execution.cwd ??
      activeProtocolThread?.cwd ??
      draft?.target.execution.workspace.cwd ??
      activeHost.workspaceBrowseRoots[0] ??
      null,
    draft === null ? activeThreadId : null,
    presentation.runtimeHostConfiguration,
  );
  const setupModelPage = resolveHostModelSettingsPage(
    settingsContributionSnapshot.settingsPages.map(({ contribution }) => contribution),
    snapshot.hostId, extensionPlatform, internalDeveloperMode,
  );
  const draftConnectionObservation = useRef({ hostId: snapshot.hostId, wasReady: false });
  if (draftConnectionObservation.current.hostId !== snapshot.hostId) draftConnectionObservation.current = { hostId: snapshot.hostId, wasReady: false };
  useEffect(() => {
    if (activeHostConnectionPhase === "ready") draftConnectionObservation.current.wasReady = true;
  }, [activeHostConnectionPhase, snapshot.hostId]);
  const initialConnectionFailed = snapshot.error !== null && !draftConnectionObservation.current.wasReady;
  const supportsModelSetup = !embedded && presentation.runtimeHostConfiguration && setupModelPage?.modelReadiness === true;
  const explicitSetupModel = useSyncExternalStore(composerController.subscribe,
    () => composerController.getSnapshot().draft.selections.model,
    () => composerController.getSnapshot().draft.selections.model);
  const setupSelectedModel = explicitSetupModel ?? composerCatalog.newThreadDefaults?.model
    ?? composerCatalog.models.find(model => model.isDefault)?.model ?? null;
  const modelReadiness = useQuery({
    queryKey: [...composerCapabilitiesKey(snapshot.hostId), "setup", snapshot.connectionGeneration, setupSelectedModel],
    enabled: draft !== null && supportsModelSetup && activeHostConnectionPhase === "ready",
    retry: false, staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const ready = await readHostModelReadiness((hostId, method, params) => hostCatalog.agentRuntimes.request(hostId, method, params), snapshot.hostId, setupSelectedModel);
      signal.throwIfAborted();
      return ready;
    },
  });
  const noUsableModels = (composerCatalog.modelsReady && composerCatalog.models.length === 0)
    || (supportsModelSetup && modelReadiness.data === false);
  const draftSetupKind = !embedded && presentation.runtimeHostConfiguration && draft !== null
    ? (activeHostConnectionPhase === "error" || (activeHostConnectionPhase !== "ready" && initialConnectionFailed)) ? "connection" as const
      : activeHostConnectionPhase === "ready" && ((composerCatalog.modelError && composerCatalog.models.length === 0) || modelReadiness.error) ? "catalog-error" as const
        : activeHostConnectionPhase === "ready" && noUsableModels && !composerCatalog.modelError && !modelReadiness.error ? "models" as const : null
    : null;
  const draftSetupNotice = draftSetupKind === null ? undefined : <DraftSetupNotice
    kind={draftSetupKind} hostName={activeHost.label}
    onConfigure={setupModelPage ? () => openSettingsFromConversation(setupModelPage.id) : undefined}
    onConnectionSettings={() => openSettingsFromConversation("machines")}
    onRetry={() => {
      if (draftSetupKind === "connection") void runtime.reconnect().catch(() => undefined);
      else { composerCatalog.retryModels(); void modelReadiness.refetch(); }
    }}
  />;
  const composerWorkspaceRoots = useMemo<readonly string[]>(() => {
    if (draft !== null) {
      return draft.target.execution.workspace.runtimeWorkspaceRoots;
    }
    const roots = snapshot.conversation?.execution.runtimeWorkspaceRoots ?? [];
    if (roots.length > 0) return roots;
    const cwd =
      snapshot.conversation?.execution.cwd ?? activeProtocolThread?.cwd;
    return cwd == null ? [] : [cwd];
  }, [
    activeProtocolThread?.cwd,
    snapshot.conversation?.execution.cwd,
    snapshot.conversation?.execution.runtimeWorkspaceRoots,
    draft,
  ]);
  const composerSuggestionCatalog = useAppServerComposerCatalog(
    composerWorkspaceRoots,
  );
  const composerSelectionCatalog = useMemo<ComposerSelectionCatalog>(
    () => ({
      policyRestricted: composerCatalog.models.some(model => model.policyRestricted),
      models: projectComposerModelChoices(composerCatalog.models),
      displayModels: projectComposerModelChoices(composerCatalog.displayModels),
      permissionProfiles: composerCatalog.permissionProfiles.map((rawProfile) => {
        const profile = rawProfile as OpenCraftPermissionProfile;
        return {
          id: profile.id,
          value: profile.id,
          label: supportsPermissionModes ? profile.openCraftLabel ?? humanizeCatalogValue(profile.id) : humanizeCatalogValue(profile.id),
          description: profile.description,
          disabled: !profile.allowed,
          mode: supportsPermissionModes ? profile.openCraftMode ?? null : null,
          nativeProfileId: supportsPermissionModes ? profile.openCraftNativeProfileId ?? null : null,
        };
      }).sort((left, right) => {
        const rank = { "read-only": 0, "accept-edits": 1, auto: 2, full: 3 } as const;
        return (left.mode === null ? 4 : rank[left.mode]) - (right.mode === null ? 4 : rank[right.mode]);
      }),
      isFetching: composerCatalog.isFetching,
      modelError: composerCatalog.modelError?.message ?? null,
      onRememberModelDefaults: modelSelectionPolicy === "user" ? composerCatalog.rememberModelDefaults : undefined,
      onConfigureModels: embedded?.onConfigureModels,
      onModelMenuOpen: modelSelectionPolicy === "session" ? composerCatalog.retryModels : () => { composerCatalog.onModelMenuOpen(); engineCatalog.open(); },
      agentGroups: modelSelectionPolicy !== "user" || draft === null || presentation.executionSelection === "fixed" ? undefined : engineCatalog.groups.map(group => ({
        id: group.hostId,
        label: hostCatalog.profiles.find(host => host.hostId === group.hostId)?.agent ?? hostCatalog.hosts.find(host => host.hostId === group.hostId)?.label ?? group.hostId,
        active: group.hostId === snapshot.hostId,
        models: projectComposerModelChoices(group.hostId === snapshot.hostId ? composerCatalog.models : group.models),
        loading: group.hostId === snapshot.hostId ? composerCatalog.isFetching : group.loading,
        error: group.hostId === snapshot.hostId ? composerCatalog.modelError?.message : group.error,
        retry: group.hostId === snapshot.hostId ? composerCatalog.retryModels : group.retry,
        select: async (model) => {
          const currentTier = composerController.getSnapshot().draft.selections.serviceTier;
          const requestedTier = currentTier !== undefined ? currentTier : composerCatalog.newThreadDefaults?.serviceTier;
          const serviceTier = model.serviceTiers?.some(tier => tier.id === requestedTier) ? requestedTier ?? null : null;
          await hostCatalog.selectHost(group.hostId, group.hostId === snapshot.hostId ? undefined : { model: model.value, effort: model.defaultEffort, serviceTier });
          if (group.hostId !== snapshot.hostId) composerCatalog.rememberModelDefaults?.({ model: model.value, effort: model.defaultEffort, serviceTier }, group.hostId);
        },
        manage: (() => {
          const page = resolveHostModelSettingsPage(settingsContributionSnapshot.settingsPages.map(({ contribution }) => contribution), group.hostId, extensionPlatform, internalDeveloperMode);
          return page ? () => hostCatalog.navigation.openSettings(page.id) : undefined;
        })(),
      })),
      retryModels: composerCatalog.retryModels,
      permissionProfileError:
        composerCatalog.permissionProfileError?.message ?? null,
    }),
    [
      modelSelectionPolicy, embedded?.onConfigureModels, presentation.executionSelection, engineCatalog, draft, hostCatalog, snapshot.hostId,
      settingsContributionSnapshot, extensionPlatform, internalDeveloperMode,
      composerCatalog.isFetching,
      composerCatalog.modelError,
      composerCatalog.onModelMenuOpen,
      composerCatalog.rememberModelDefaults,
      composerCatalog.newThreadDefaults,
      composerController,
      composerCatalog.retryModels,
      composerCatalog.models,
      composerCatalog.displayModels,
      composerCatalog.permissionProfileError,
      composerCatalog.permissionProfiles,
      supportsPermissionModes,
    ],
  );
  const draftWorkspaceOptions = useMemo(() => {
    return buildDraftWorkspaceOptions(projectCatalog.projects);
  }, [projectCatalog.projects]);
  const threadTitleWriter = useMemo(() => new ThreadTitleWriter({
    read: key => readCachedThreadName(queryClient, key),
    write: (key, value) => writeCachedThreadName(queryClient, key, value),
    persist: async (key, value) => {
      await hostCatalog.threadManagement.rename(key.hostId, key.threadId, value);
      void queryClient.invalidateQueries({ queryKey: ["appserver", key.hostId, "threads"] }).catch(() => undefined);
    },
  }), [hostCatalog.threadManagement, queryClient]);
  const pendingTitleRevision = useSyncExternalStore(threadTitleWriter.subscribe, threadTitleWriter.getSnapshot, threadTitleWriter.getSnapshot);
  const restoreArchivedThread = useCallback(async (hostId: string, threadId: string) => {
    await hostCatalog.threadManagement.unarchive(hostId, threadId);
    await queryClient.invalidateQueries({ queryKey: ["appserver", hostId, "threads"] });
  }, [hostCatalog.threadManagement, queryClient]);
  const loadArchivedThreads = useCallback(async (hostId: string) => {
    return hostCatalog.threadManagement.listArchived(hostId);
  }, [hostCatalog.threadManagement]);
  const archivedConversationsAvailable = hostCatalog.threadManagement.capabilities(snapshot.hostId, activeThreadId ?? undefined).archive;
  const embeddedSessions = useMemo(() => {
    if (embedded === undefined) return [];
    return catalog.threads.map((thread): EmbeddedWorkbenchAppSession => {
      const protocolThread = catalog.protocolThreads.find((candidate) => candidate.id === thread.id);
      const updatedAt = protocolThread?.updatedAt ?? 0;
      return {
        chatId: thread.id,
        title: thread.title,
        createdAt: updatedAt,
        updatedAt,
        readOnly: false,
        running: thread.status === "running",
        pinned: thread.pinned === true,
      };
    });
  }, [catalog.protocolThreads, catalog.threads, embedded]);
  useEffect(() => {
    if (embedded === undefined) return;
    embedded.onSessionsChange({
      sessions: embeddedSessions,
      loading: (catalog.isPending && snapshot.phase !== "error") || catalog.isFetching,
      error: catalog.isError || snapshot.phase === "error"
        ? intl.formatMessage({ id: "sidebar.catalog.discoveryError", defaultMessage: "Couldn't load remote connections" }) : null,
      hasMoreSessions: catalog.hasNextPage,
      pinSupported: hostCatalog.threadManagement.capabilities(embedded.hostId).pin === true,
      selectedChatId: snapshot.hostId === embedded.hostId ? activeThreadId : null,
      isDraft: draft !== null && draft.submission === null,
    });
  }, [activeThreadId, catalog.hasNextPage, catalog.isError, catalog.isFetching, catalog.isPending, draft, embedded, embeddedSessions, hostCatalog.threadManagement, intl, snapshot.hostId, snapshot.phase]);
  // The local Draft paints before the Host connects (the Composer stays
  // submission-disabled until ready); a restored Thread paints when ready.
  const painted = isEmbeddedConversationPainted(draft, conversationViewActivation.phase);
  useEffect(() => {
    if (embedded === undefined || !painted) return;
    embedded.onPainted();
  }, [embedded, painted]);
  useEffect(() => {
    if (embedded === undefined) return;
    if (conversationViewActivation.phase === "error") {
      embedded.onError(
        conversationViewActivation.error ?? new Error("Embedded Workbench conversation failed"),
      );
      return;
    }
    if (conversationViewActivation.phase === "ready" && snapshot.hostId === embedded.hostId) {
      embedded.onReady(activeThreadId);
    }
  }, [activeThreadId, conversationViewActivation.error, conversationViewActivation.phase, embedded, snapshot.hostId]);
  useEffect(() => {
    if (embedded === undefined) return;
    return embedded.bindActions({
      submitPrompt: (text) => {
        if (composerController.getSnapshot().draft.target.type !== "new-thread") {
          navigateToHome();
          return false;
        }
        return submitEmbeddedPrompt(composerController, embedded.hostId, snapshot.phase === "ready", text,
          intent => sendMessage(intent, { followUpAction: null }) === true);
      },
      selectThread: async (threadId) => {
        await hostCatalog.navigate(createWorkbenchThreadLocation(embedded.hostId, threadId));
      },
      createThread: async () => { navigateToHome(); },
      loadMoreThreads: async () => {
        const result = await catalog.fetchNextPage();
        if (result !== null && typeof result === "object" && "isError" in result && result.isError) {
          throw "error" in result ? result.error : new Error("Failed to load conversations");
        }
      },
      renameThread: async (threadId, title) => {
        await hostCatalog.threadManagement.rename(embedded.hostId, threadId, title);
        void queryClient.invalidateQueries({ queryKey: ["appserver", embedded.hostId, "threads"] }).catch(() => undefined);
      },
      deleteThread: async (threadId) => {
        await hostCatalog.threadManagement.delete(embedded.hostId, threadId);
        void queryClient.invalidateQueries({ queryKey: ["appserver", embedded.hostId, "threads"] }).catch(() => undefined);
        if (activeThreadId === threadId) navigateToHome();
      },
      setThreadPinned: async (threadId, pinned) => {
        await threadPinWriter.set({ hostId: embedded.hostId, threadId }, pinned);
      },
    });
  }, [activeThreadId, catalog.fetchNextPage, composerController, embedded, hostCatalog, threadPinWriter, navigateToHome, queryClient, sendMessage, snapshot.phase]);
  const workspaceSelectionEpoch = useRef(0);
  useLayoutEffect(() => {
    workspaceSelectionEpoch.current++;
    return () => { workspaceSelectionEpoch.current++; };
  }, [draft?.id, draft?.phase, draft?.target.execution.hostId,
    draft?.target.execution.workspace.cwd, runtime, snapshot.hostId, conversationRouteOpen, settingsOpen]);
  const readWorkspaceDirectory = useCallback(
    async (path: string) =>
      (await runtime.resources.fileSystem.readDirectory(path)).entries,
    [runtime],
  );
  const chooseWorkspaceDirectory = useCallback(
    async (path: string) => {
      if (draft === null || draftSubmissionOwnsNavigation(draft.phase) || !conversationRouteOpen || settingsOpen) return;
      const epoch = workspaceSelectionEpoch.current;
      const selected = await resolveDraftDirectorySelection({ path,
        projects: projectCatalog.projects,
        projectCatalogError: projectCatalog.error,
        createProject: params => runtime.resources.projects.create(params),
      });
      if (selected.createdProject) {
        await queryClient.invalidateQueries({
          queryKey: ["appserver", snapshot.hostId, "projects"],
        });
      }
      if (epoch !== workspaceSelectionEpoch.current) return;
      selectDraftWorkspace(selected.workspace);
      setWorkspacePickerOpen(false);
    },
    [
      projectCatalog.projects,
      projectCatalog.error,
      queryClient,
      runtime,
      selectDraftWorkspace,
      snapshot.hostId,
      draft,
      conversationRouteOpen,
      settingsOpen,
    ],
  );
  const workspaceBrowseRoot = activeHost.workspaceBrowseRoots[0]
    ?? draft?.target.execution.workspace.runtimeWorkspaceRoots[0] ?? "/";
  const localProjectPicker = nativeProjectPicker(activeHost);
  const browseWorkspace = useCallback(async () => {
    if (localProjectPicker === null) {
      setWorkspacePickerOpen(true);
      return;
    }
    const epoch = workspaceSelectionEpoch.current;
    try {
      const path = await localProjectPicker.pickDirectory();
      if (path !== null && epoch === workspaceSelectionEpoch.current) await chooseWorkspaceDirectory(path);
    } catch (error) {
      if (epoch === workspaceSelectionEpoch.current) throw error;
    }
  }, [localProjectPicker, workspaceBrowseRoot, chooseWorkspaceDirectory]);
  const closeSettings = useCallback(() => {
    workbenchNavigation.closeSettings();
  }, [workbenchNavigation]);
  const selectSettingsSection = useCallback((section: string, mode?: "push" | "replace") => {
    workbenchNavigation.openSettings(section, mode);
  }, [workbenchNavigation]);
  const workNavigationActions = useWorkbenchToolActions({
    section: standaloneManagementOpen ? settingsSection : null,
    extensionContributions: hostCatalog.extensionContributions,
    onSectionChange: selectSettingsSection,
  });
  const settingsNavigation = settingsOpen ? (
    <Suspense fallback={null}>
      <SettingsNavigation
        section={settingsSection}
        onSectionChange={selectSettingsSection}
        extensionContributions={hostCatalog.extensionContributions}
        profiles={hostCatalog.profiles}
        machines={machines}
        activeHostId={snapshot.hostId}
        showArchivedConversations={archivedConversationsAvailable}
        onBack={closeSettings}
        presentation={managementSettingsOpen ? "dialog" : "sidebar"}
      />
    </Suspense>
  ) : null;
  const settingsContent = settingsOpen ? (
    <Suspense
      fallback={
        <div className="settings-page-loading" role="status">
          Loading settings…
        </div>
      }
    >
      <SettingsContent
        section={settingsSection}
        onSectionChange={selectSettingsSection}
        profiles={hostCatalog.profiles}
        machines={machines}
        activeHostId={snapshot.hostId}
        onRemove={hostCatalog.removeHost}
        onProvisionHost={hostCatalog.provisionHost}
        onConnectDesktopServer={desktopServerPort() ? async (origin, signal) => {
          const profile = await configureDesktopServer({ origin, signal, port: desktopServerPort()!, profiles: hostCatalog.profiles, provision: hostCatalog.provisionHost });
          signal.throwIfAborted();
          hostCatalog.navigateToHome({ execution: { hostId: profile.hostId as import('@opencraft/chat-core').HostId, workspace: { cwd: null, runtimeWorkspaceRoots: [] } } });
        } : undefined}
        onOpenView={workbenchNavigation.openExtensionView}
        onPushViewResource={workbenchNavigation.pushExtensionViewResource}
        onReplaceViewResource={workbenchNavigation.replaceExtensionViewResource}
        extensionContributions={hostCatalog.extensionContributions}
        extensionRuntime={hostCatalog.extensionRuntime}
        extensionManager={hostCatalog.extensionManager}
        platformViewRenderers={hostCatalog.platformViewRenderers}
        regions={appShellPlatformViewRegions}
        archivedConversations={archivedConversationsAvailable ? {
          load: loadArchivedThreads,
          restore: restoreArchivedThread,
        } : undefined}
        themes={appearanceTheme.availableThemes}
        themeId={appearanceTheme.themeId}
        themePreference={appearanceTheme.preference}
        onThemeChange={setAppearanceThemeId}
        onThemePreferenceChange={setThemePreference}
        onOpenAnnouncementLab={() => {
          void showAnnouncementLab(hostCatalog.announcements);
        }}
      />
    </Suspense>
  ) : null;
  const settingsRoute = routeSettingsOpen ? (
    <section className="settings-page" aria-label="Settings">
      {settingsContent}
    </section>
  ) : null;
  const modalRequests: ModalRequest[] = [];
  if (closingSideChat) modalRequests.push({
    id: "close-side-chat", label: "Close side chat?", layer: "confirmation", size: "compact", appearance: "utility",
    onDismiss: () => setClosingSideChat(null),
    content: <div><p>This temporary conversation will be discarded. It cannot be recovered.</p>
      <Button variant="secondary" onClick={() => setClosingSideChat(null)}>Keep chatting</Button>
      <Button variant="destructive" onClick={() => {
        const current = panelRuntime.panels.getOwnerSnapshot(closingSideChat.ownerId);
        const tab = [...current.right.tabs, ...current.bottom.tabs].find(entry => entry.id === closingSideChat.tab.id);
        if (tab) panelRuntime.panels.close(closingSideChat.ownerId, tab.region, tab.id);
        setClosingSideChat(null);
      }}>Close side chat</Button></div>,
  });
  const announcementModalRequests = useAnnouncementModalRequests(hostCatalog.announcements);
  if (managementSettingsOpen && !standaloneManagementOpen) {
    modalRequests.push({
      id: "management-settings",
      label: `${hostCatalog.profiles.find((profile) => profile.hostId === snapshot.hostId)?.displayName ?? "Hermes"} settings`,
      size: "workspace",
      className: "management-settings-dialog",
      dismissOnOutsidePress: false,
      content: (
        <ManagementSettingsContent navigation={settingsNavigation}>
          {settingsContent}
        </ManagementSettingsContent>
      ),
      onDismiss: closeSettings,
    });
  }
  if (accountOpen && extensionProjection.account !== null) {
    modalRequests.push({
      id: "account",
      label: "Account Settings",
      appearance: "utility",
      returnFocus: () => [...document.querySelectorAll<HTMLButtonElement>('.shell-navigation__entrance[data-surface="account"]')].find(button => button.getClientRects().length > 0) ?? null,
      size: "wide",
      dismissOnOutsidePress: false,
      content: extensionProjection.account.content,
      onDismiss: () => setAccountOpen(false),
    });
  }
  // Imperative announcements are appended last so a preview requested from a
  // Settings window becomes the top nested window instead of appearing under it.
  if (authenticationPresentation.modal) modalRequests.push(authenticationPresentation.modal);
  modalRequests.push(...announcementModalRequests);
  modalRequests.push(...connectorPresentation.requests);
  const presentedRightPanelOpen =
    presentation.rightPanel && panelState.right.open;
  const presentedRightPanelFullWidth =
    presentation.rightPanel && panelState.rightPanelFullWidth;
  const conversationRightPanelAvailable = conversationSurfaceVisible
    && (embedded === undefined || (draft === null && activeThreadId !== null));
  const panelHost = embedded?.panelHost;
  const hostPanelActive = useSyncExternalStore(panelHost?.presentation?.subscribe ?? (() => () => {}),
    panelHost?.presentation?.getSnapshot ?? (() => false), () => false);
  // The installed adapter owns availability and rechecks authority on launch.
  const cloudDesktopAction = panelToolbarActions.find(action => action.id === "opencraft.cloud-desktop.open");
  const composerDesktopEntry = presentation.composerDesktopEntry === true && conversationRouteOpen && cloudDesktopAction
    && (cloudDesktopAction.isAvailable?.(panelToolbarContext) ?? true) ? (
    <button type="button" className="opencraft-composer-shortcut-trigger" data-testid="composer-cloud-desktop-entry"
      onClick={() => {
        try {
          void Promise.resolve(cloudDesktopAction.run(panelToolbarContext)).catch(() => {
            window.dispatchEvent(new CustomEvent("opencraft-panel-action-failed"));
          });
        } catch { window.dispatchEvent(new CustomEvent("opencraft-panel-action-failed")); }
      }}>
      <Monitor size={15} aria-hidden="true" />
      <span>{intl.formatMessage({ id: "composer.cloudComputer", defaultMessage: "Cloud computer" })}</span>
    </button>
  ) : null;
  const panelHostProjection: HostPanelState = {
    ownerId: panelOwnerId, available: conversationRightPanelAvailable,
    open: panelState.right.open, fullWidth: panelState.rightPanelFullWidth,
    activeTabId: panelState.right.activeTabId,
    tabs: panelState.right.tabs.map(tab => ({ id: tab.id,
      title: tab.kind === "cloud-desktop" ? intl.formatMessage({ id: "panel.desktopEntry", defaultMessage: "Cloud computer" })
        : tab.kind === "browser" && tab.title === "New tab"
        ? intl.formatMessage({ id: "panel.newTab", defaultMessage: "New tab" }) : tab.title.slice(0, 512),
      kind: tab.kind, closable: tab.closable, preview: tab.preview })),
    actions: (conversationRouteOpen ? panelToolbarActions : []).filter(action => action.region === "right"
      && (action.isAvailable?.(panelToolbarContext) ?? true))
      .map(action => ({ id: action.id, label: action.creationLabel ?? action.label, icon: action.icon })),
  };
  const panelHostWire = JSON.stringify(panelHostProjection);
  useEffect(() => { panelHost?.publish(JSON.parse(panelHostWire) as HostPanelState); }, [panelHost, panelHostWire]);
  // The same panel owner admits Web and native actions. Retired owner commands
  // cannot select/close a resource in the next conversation.
  const invokeHostPanel = useStableEvent((command: HostPanelCommand) => {
    if (!conversationRouteOpen || !canInvokeHostPanelCommand(panelHostProjection, command)) return false;
    const tab = "tabId" in command ? panelState.right.tabs.find(tab => tab.id === command.tabId) : undefined;
    switch (command.action) {
      case "open": dispatchPanel({ type: "set-region-open", region: "right", open: command.open, reason: "manual", allowEmpty: true }); return true;
      case "full-width": dispatchPanel({ type: "toggle-right-full-width" }); return true;
      case "select": if (!tab) return false; dispatchPanel({ type: "activate-tab", region: "right", tabId: tab.id }); return true;
      case "close": if (!tab?.closable) return false; requestClosePanel(tab); return true;
      case "move": if (!tab || (command.beforeTabId !== null && !panelState.right.tabs.some(tab => tab.id === command.beforeTabId))) return false;
        dispatchPanel({ type: "move-tab", region: "right", tabId: tab.id, beforeTabId: command.beforeTabId }); return true;
      case "launch": {
        const action = panelToolbarActions.find(action => action.id === command.actionId && action.region === "right"
          && (action.isAvailable?.(panelToolbarContext) ?? true));
        if (!action) return false;
        try {
          void Promise.resolve(action.run(panelToolbarContext)).catch(() => {
            window.dispatchEvent(new CustomEvent("opencraft-panel-action-failed"));
          });
        } catch { window.dispatchEvent(new CustomEvent("opencraft-panel-action-failed")); }
        return true;
      }
    }
  });
  useEffect(() => panelHost?.bind(invokeHostPanel), [panelHost, invokeHostPanel]);
  const rightPanelView = !presentation.rightPanel ? null : <WorkbenchPresentationActivityProvider active={conversationRouteOpen}><RightPanel
    hostPresentationActive={panelHost ? conversationRightPanelAvailable && (panelState.right.open || hostPanelActive) : undefined}
    emptyHint={presentation.filePreviewOnly ? intl.formatMessage({ id: "panel.fileHint", defaultMessage: "Click a file in the conversation to preview it here." }) : undefined}
    state={panelState} presentationId={panelPresentationId} renderers={presentedPanelRenderers}
    toolbarActions={conversationRouteOpen ? panelToolbarActions : []} toolbarActionContext={panelToolbarContext}
    onAction={dispatchPanel} onCloseTab={requestClosePanel} portalContainer={portalContainer} /></WorkbenchPresentationActivityProvider>;
  // Applications replace context/content, never the Shell control plane.
  // Target management remains an independent modal semantic surface.
  const headerNavigationActions = chromePolicy.leadingNavigationActions;
  const applicationDesktopOpen = workbenchNavigationSnapshot.applicationRoute.kind === "extension-view"
    && workbenchNavigationSnapshot.applicationRoute.viewId === OVERHOME_VIEW_ID;
  const presentedHeaderNavigationActions = presentation.shellNavigation
    ? headerNavigationActions.map(action => applicationDesktopOpen && action === "sidebar-toggle" ? "home" as const : action)
    : [];
  const invokeHeaderHome = applicationDesktopOpen ? workbenchNavigation.openChat : navigateToHome;
  const pageTitle = routeSettingsOpen
    ? null
    : extensionViewOpen
      ? (workbenchNavigationSnapshot.applicationRoute.kind === "extension-view" && workbenchNavigationSnapshot.applicationRoute.viewId === OVERHOME_VIEW_ID
        ? intl.formatMessage({ id: "navigation.applications", defaultMessage: "Applications" }) : extensionProjection.activeView?.title ?? null)
      : draft === null
        ? (activeThread?.title ?? "Untitled task")
        : null;
  const applicationName = branding.name;
  const documentTitle = formatDocumentTitle(settingsOpen ? null : pageTitle, applicationName);
  useEffect(() => {
    if (embedded !== undefined) return;
    document.title = documentTitle;
  }, [documentTitle, embedded]);
  useEffect(() => {
    if (embedded !== undefined) return;
    return () => { document.title = applicationName; };
  }, [embedded, applicationName]);
  const scheduleCapability = executionEngineExtension(runtime.resources.host.getInitializeResult()?.capabilities?.extensions, activeThreadId, "opencraft/conversation-schedules") as { version?: number } | undefined;
  const schedulesAvailable = scheduleCapability?.version === 1 && runtime.resources.host.canRequest?.("opencraft/schedules/read") === true;
  const conversationMenuAvailable = conversationSurfaceVisible && draft === null && activeThreadId !== null
        && (schedulesAvailable || hostCatalog.tasks || hostCatalog.threadManagement.capabilities(snapshot.hostId, activeThreadId ?? undefined).rename || hostCatalog.threadManagement.capabilities(snapshot.hostId, activeThreadId ?? undefined).pin || hostCatalog.threadManagement.capabilities(snapshot.hostId, activeThreadId ?? undefined).archive || hostCatalog.threadManagement.capabilities(snapshot.hostId, activeThreadId ?? undefined).fork || activeThread?.project || snapshot.conversation?.execution.cwd || activeProtocolThread?.cwd);
  const refreshConversationCatalog = useCallback(() => queryClient.invalidateQueries({
    queryKey: ["appserver", snapshot.hostId, "threads"],
  }), [queryClient, snapshot.hostId]);
  const conversationContribution = conversationSurfaceVisible && draft === null && activeThreadId !== null
    ? conversationPresentation?.({
      hostId: snapshot.hostId, threadId: activeThreadId, extra: activeProtocolThread?.extra,
      ready: snapshot.phase === "ready", authoritative: snapshot.conversation?.authoritative === true,
      canFork: hostCatalog.threadManagement.capabilities(snapshot.hostId, activeThreadId ?? undefined).fork,
      readExtra: async () => (await hostCatalog.agentRuntimes.request(snapshot.hostId, "thread/read", {
        threadId: activeThreadId, includeTurns: false,
      })).thread.extra,
      fork: () => forkAndOpenThread({
        routeScopeId: () => workbenchNavigation.getSnapshot().routeScopeId,
        fork: () => hostCatalog.threadManagement.fork(snapshot.hostId, activeThreadId),
        refreshThreads: refreshConversationCatalog,
        openThread: childId => hostCatalog.navigate(createWorkbenchThreadLocation(snapshot.hostId, childId)),
      }),
    }) : null;
  useConversationHistoryRefresh(activeThreadLease,
    conversationContribution?.refreshHistory === true && snapshot.phase === "ready", refreshConversationCatalog);
  const headerThreadId = activeThreadId ?? "";
  const conversationToolbarProps: import("./components/conversation-task-menu").ConversationTaskMenuProps = {
    port: hostCatalog.tasks ?? undefined,
    schedules: schedulesAvailable ? { request: (method, params) => hostCatalog.agentRuntimes.request(snapshot.hostId, method, params) } : undefined,
    scope: displayScope,
    serverId: legacyDirectServerProjectionFromHost({ hostId: activeHost.hostId, hostKind: activeHost.kind, label: activeHost.label }).serverOrigin.serverId,
    threadId: headerThreadId,
    shareUrl: !embedded && headerThreadId && ["https:", "http:"].includes(window.location.protocol)
      ? new URL(serverUrl(workbenchLocationUrl(createWorkbenchThreadLocation(snapshot.hostId, headerThreadId))), window.location.origin).href : undefined,
    title: activeThread?.title ?? pageTitle ?? "",
    pinned: activeThread?.pinned,
    project: activeThread?.project,
    workspaceDirectory: snapshot.conversation?.execution.cwd ?? activeProtocolThread?.cwd ?? undefined,
    onRename: hostCatalog.threadManagement.capabilities(snapshot.hostId, activeThreadId ?? undefined).rename
              ? title => threadTitleWriter.rename({ hostId: snapshot.hostId, threadId: headerThreadId }, title) : undefined,
    onSetPinned: hostCatalog.threadManagement.capabilities(snapshot.hostId, activeThreadId ?? undefined).pin
              ? async pinned => {
                await threadPinWriter.set({ hostId: snapshot.hostId, threadId: headerThreadId }, pinned);
              } : undefined,
    onArchive: hostCatalog.threadManagement.capabilities(snapshot.hostId, activeThreadId ?? undefined).archive
              ? () => archiveThread({
                archive: () => hostCatalog.threadManagement.archive(snapshot.hostId, headerThreadId),
                refreshThreads: () => queryClient.invalidateQueries({ queryKey: ["appserver", snapshot.hostId, "threads"] }),
              }) : undefined,
    onFork: hostCatalog.threadManagement.capabilities(snapshot.hostId, activeThreadId ?? undefined).fork
              ? () => forkAndOpenThread({
                routeScopeId: () => workbenchNavigation.getSnapshot().routeScopeId,
                fork: () => hostCatalog.threadManagement.fork(snapshot.hostId, headerThreadId),
                refreshThreads: () => queryClient.invalidateQueries({ queryKey: ["appserver", snapshot.hostId, "threads"] }),
                openThread: childId => hostCatalog.navigate(createWorkbenchThreadLocation(snapshot.hostId, childId)),
              }) : undefined,
    verifyConversation: async () => { await hostCatalog.agentRuntimes.request(snapshot.hostId, "thread/read", { threadId: headerThreadId, includeTurns: false }); },
    onOpenTasks: () => workbenchNavigation.openExtensionView("opencraft.tasks.board"),
  };
  const summaryScopeKey = JSON.stringify([displayScope, displayHostId, displayThreadId]);
  const summary = useConversationSummary(summaryScopeKey, conversationSurfaceVisible && draft === null && displayThreadId !== null);
  const summaryGoal = useSummaryGoal(runtime.resources.goals, displayHostId === snapshot.hostId && displayThreadId === activeThreadId ? displayThreadId : null);
  const summaryCurrent = !showingDisplayCache && snapshot.phase === "ready" && visibleTimeline?.authoritative === true;
  const conversationMenuSizing = <ConversationToolbarSizing scope={displayScope} actionIds={conversationToolbarActionIds(conversationToolbarProps)} />;
  const conversationActionSizing = <span className="conversation-header-actions">{summary.enabled ? <ButtonPlaceholder className="chrome-button" /> : null}{conversationMenuSizing}</span>;
  const header = (
    <AppShellHeader
      conversationHeader={conversationSurfaceVisible}
      subtitle={conversationContribution?.subtitle}
      navigationBrand={embedded === undefined && extensionPlatform === "web" ? <ApplicationBrand branding={branding} onHome={workbenchNavigation.openChat} /> : undefined}
      headerActionSizing={conversationActionSizing}
      headerAction={<span className="conversation-header-actions"><ConversationSummaryButton controller={summary} />{conversationMenuAvailable ? (
        <Suspense fallback={conversationMenuSizing}>
          <ConversationTaskMenu
            key={JSON.stringify([displayScope, snapshot.hostId, activeThreadId])}
            im={settingsContributionSnapshot.settingsPages.some(page => page.contribution.id === "opencraft.im.channels") ? {
              fetcher: serverFetch, openSettings: () => workbenchNavigation.openSettings("opencraft.im.channels"),
            } : undefined}
            {...conversationToolbarProps}
          />
        </Suspense>
      ) : null}</span>}
      titleContent={conversationSurfaceVisible && draft === null && activeThread !== undefined && hostCatalog.threadManagement.capabilities(snapshot.hostId, activeThreadId ?? undefined).rename ? (
        <EditableThreadTitle
          key={JSON.stringify([snapshot.hostId, activeThread.id])}
          title={activeThread.title}
          project={embedded === undefined ? (activeThread.project ?? "OpenCraft") : undefined}
          onRename={title => threadTitleWriter.rename({ hostId: snapshot.hostId, threadId: activeThread.id }, title)}
        />
      ) : undefined}
      title={standaloneManagementOpen || extensionViewOpen ? null : pageTitle}
      project={
        embedded !== undefined || routeSettingsOpen || extensionViewOpen
          ? null
          : draft === null
            ? (activeThread?.project ?? "OpenCraft")
            : null
      }
      sidebarOpen={shellSidebarOpen}
      rightPanelOpen={conversationRightPanelAvailable && presentedRightPanelOpen}
      rightPanelFullWidth={conversationRightPanelAvailable && presentedRightPanelFullWidth}
      showRightPanelAction={!panelHost && conversationRightPanelAvailable && presentation.rightPanel}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      onToggleSidebar={() => setSidebarOpen((value) => !value)}
      onToggleRightPanel={toggleRightPanel}
      onHome={invokeHeaderHome}
      onBack={workbenchNavigation.back}
      onForward={workbenchNavigation.forward}
      navigationActions={presentedHeaderNavigationActions}
      routeHeaderActive={routeHeader.active}
      routeHeaderHostRef={routeHeader.hostRef}
    />
  );

  const composerChangeSummary = (
    <ComposerTurnChangeSummary
      timeline={timeline}
      turnId={snapshot.conversation?.activeTurn?.turnId ?? null}
      documentContext={{
        conversationId: activeThreadId,
        cwd: activeProtocolThread?.cwd ?? null,
        hostId: snapshot.hostId,
        onOpenResource: openChatResource,
        onReviewTurnDiff: openTurnDiffReview,
        theme: appearanceTheme.resolvedTheme,
      }}
    />
  );

  const sidebarCommands = useSidebarCommands({
    onSelectThread: (hostId, id) => {
      void hostCatalog.selectConversation(createWorkbenchThreadLocation(hostId, id)).catch((error) => {
        console.error("Failed to activate selected Thread", error);
      });
    },
    onNewTask: navigateToHome,
    onOpenSettings: openSettingsFromConversation,
    onRetryThreadCatalog: hostId => { void multiHostCatalog.retry(hostId); },
    onRetryThreadCatalogDiscovery: () => { void multiHostCatalog.retryDiscovery(); },
    threadActions: {
      onCopyReference: target => copyConversationReference(body=>hostCatalog.agentRuntimes.request(target.hostId,"opencraft/collaboration",body),window.location.href,target),
      onSetPinned: async (target, pinned) => {
        await threadPinWriter.set(target, pinned);
      },
      onRename: (target, title) => threadTitleWriter.rename(target, title),
      onFork: target => forkAndOpenThread({
        routeScopeId: () => workbenchNavigation.getSnapshot().routeScopeId,
        fork: () => hostCatalog.threadManagement.fork(target.hostId, target.threadId),
        refreshThreads: () => queryClient.invalidateQueries({ queryKey: ["appserver", target.hostId, "threads"] }),
        openThread: childId => hostCatalog.navigate(createWorkbenchThreadLocation(target.hostId, childId)),
      }),
      onArchive: target => archiveThread({
        archive: () => hostCatalog.threadManagement.archive(target.hostId, target.threadId),
        refreshThreads: () => queryClient.invalidateQueries({ queryKey: ["appserver", target.hostId, "threads"] }),
      }),
      onDelete: async target => {
        const routeScopeId = workbenchNavigation.getSnapshot().routeScopeId;
        await hostCatalog.threadManagement.delete(target.hostId, target.threadId);
        void queryClient.invalidateQueries({ queryKey: ["appserver", target.hostId, "threads"] }).catch(() => undefined);
        // Deleting the thread the workbench currently shows would
        // leave the route pointing at a missing thread; go home.
        if (workbenchNavigation.getSnapshot().routeScopeId === routeScopeId && snapshot.hostId === target.hostId && (draft === null ? activeThreadId ?? "" : "") === target.threadId) {
          navigateToHome();
        }
      },
    },
  });
  const sidebarThreadCapabilities = useCallback(
    (hostId: string, threadId?: string) => hostCatalog.threadManagement.capabilities(hostId, threadId),
    // Catalog readiness changes when a Host gains/loses its initialized capabilities.
    [hostCatalog.threadManagement, multiHostCatalog.threads],
  );
  const sidebarPendingTitle = useCallback(
    (hostId: string, threadId: string) => threadTitleWriter.pendingTitle({ hostId, threadId }),
    [threadTitleWriter, pendingTitleRevision],
  );
  const sidebarManagementNavigation = useMemo(() =>
    !presentation.shellNavigation && (conversationRouteOpen || standaloneManagementOpen) ? (
      <WorkbenchToolNavigation
        section={standaloneManagementOpen ? settingsSection : null}
        extensionContributions={hostCatalog.extensionContributions}
        onSectionChange={selectSettingsSection}
      />
    ) : null,
  [presentation.shellNavigation, conversationRouteOpen, standaloneManagementOpen, settingsSection,
    hostCatalog.extensionContributions, selectSettingsSection]);

  return (
    <ImageEditorContext.Provider value={imageEditor}>
    <IdentityAvatarContext.Provider value={identityAvatar}>
    <ScheduledTaskCatalogContext.Provider value={{ ...multiHostCatalog,
      openConversation: (hostId, threadId) => hostCatalog.selectConversation(createWorkbenchThreadLocation(hostId, threadId)),
    }}>
    <ConversationReferenceSurface catalog={hostCatalog} hostId={snapshot.hostId}>
      <InternalDeveloperModeGate />
      <AppShellRouteRegionsProvider
        controller={routeHeader.controller}
        target={routeHeader.target}
      >
        <AppShell
          surface={desktopBackdrop ? "application-desktop" : "default"}
          navigation={!presentation.shellNavigation ? undefined : {
            layout: "unified",
            settingsActive: routeSettingsOpen,
            updatesActive: routeSettingsOpen && workbenchNavigationSnapshot.applicationRoute.kind === 'settings' && workbenchNavigationSnapshot.applicationRoute.slug === 'updates',
            actions: [
              { id: "shell.home", title: intl.formatMessage({ id: "navigation.home", defaultMessage: "Home" }), icon: "home", active: conversationRouteOpen,
                onInvoke: workbenchNavigation.openChat },
              ...extensionProjection.primaryActions, ...extensionProjection.footerActions, ...workNavigationActions,
              { id: "shell.applications", title: intl.formatMessage({ id: "navigation.applications", defaultMessage: "Applications" }),
                icon: "grid", active: extensionViewOpen && workbenchNavigationSnapshot.applicationRoute.kind === "extension-view"
                  && workbenchNavigationSnapshot.applicationRoute.viewId === OVERHOME_VIEW_ID,
                onInvoke: () => workbenchNavigation.openExtensionView(OVERHOME_VIEW_ID) },
              { id: "shell.search", title: intl.formatMessage({ id: "sidebar.search", defaultMessage: "Search conversations" }) + ` (${shortcutLabel("search")})`, icon: "search", onInvoke: () => setConversationSearchOpen(true) },
            ],
            account: extensionProjection.account === null ? null : {
              providerId: extensionProjection.account.provider.id,
              snapshot: extensionProjection.account.snapshot,
              signIn: authenticationPresentation.signIn,
              onOpen: () => extensionProjection.account?.snapshot.phase === "anonymous" && extensionProjection.account.provider.signInViewId ? authenticationPresentation.open() : setAccountOpen(true),
              onRefresh: extensionProjection.account.provider.refresh,
              onSignOut: extensionProjection.account.provider.signOut ? async () => {
                await turnNotifications?.beforeSignOut();
                await extensionProjection.account?.provider.signOut?.();
              } : undefined,
            },
            onOpenSettings: () => openSettingsFromConversation(),
            onOpenUpdates: () => openSettingsFromConversation('updates'),
          }}
          layoutScope={`${managementSettingsOpen ? "conversation" : workbenchNavigationSnapshot.applicationRoute.kind}:${panelOwnerId}`}
          mainContentLayout={conversationSurfaceVisible ? "thread-edge-scroll" : "default"}
          sidebarOpen={shellSidebarOpen}
          sidebarSuppressed={applicationDesktopOpen}
          sidebarWidth={presentation.contextSidebar ? sidebarWidth : 0}
          sidebarCollapsible={presentation.contextSidebar}
          sidebarTransientEnabled={presentation.contextSidebar}
          sidebarResizable={presentation.contextSidebar}
          windowChrome={windowChrome}
          onSidebarCollapse={collapseSidebar}
          onSidebarExpand={expandSidebar}
          onSidebarResizeEnd={commitSidebarWidth}
          rightPanelOpen={!panelHost && conversationRightPanelAvailable && presentedRightPanelOpen}
          rightPanelKeepMounted={!panelHost && presentation.rightPanel && panelState.right.tabs.some(tab =>
            presentedPanelRenderers.some(renderer => renderer.kind === tab.kind && renderer.residency === "while-tab-open"))}
          rightPanelFullWidth={!panelHost && conversationRightPanelAvailable && presentedRightPanelFullWidth}
          rightPanelDefaultSize={embedded === undefined && extensionPlatform === "web" ? "compact" : presentation.rightPanelDefaultSize}
          onRightPanelOpenChange={(open) =>
            dispatchPanel({
              type: "set-region-open",
              region: "right",
              open,
              reason: "manual",
              allowEmpty: true,
            })
          }
          header={embedded !== undefined && draft !== null && draft.submission === null && !presentation.rightPanel ? null : header}
          floatingSidebarHeader={(onDock) => !presentation.contextSidebar ? null : (
            <AppShellNavigationControls
              brand={embedded === undefined && extensionPlatform === "web" ? <ApplicationBrand branding={branding} onHome={workbenchNavigation.openChat} /> : undefined}
              hostRole="transient"
              sidebarOpen={false}
              canGoBack={canGoBack}
              canGoForward={canGoForward}
              onToggleSidebar={onDock}
              onHome={invokeHeaderHome}
              onBack={workbenchNavigation.back}
              onForward={workbenchNavigation.forward}
              actions={presentedHeaderNavigationActions}
            />
          )}
          leftPanel={!presentation.contextSidebar ? null : (
            routeSettingsOpen ? settingsNavigation : (conversationSurfaceVisible || standaloneManagementOpen) ? <Sidebar
              searchInDialog={presentation.shellNavigation}
              threads={multiHostCatalog.threads}
              threadCatalogs={multiHostCatalog.catalogs}
              threadCatalogDiscovery={multiHostCatalog.discovery}
              {...sidebarCommands}
              managementNavigation={sidebarManagementNavigation}
              showFooter={false}
              showNewChat={presentation.shellNavigation}
              showStart={!presentation.shellNavigation}
              threadCapabilities={sidebarThreadCapabilities}
              threadBadge={threadBadge}
              threadListGrouping={threadListGrouping}
              pendingTitle={sidebarPendingTitle}

              catalogs={extensionProjection.catalogs}
              bots={extensionProjection.bots}
              sidebarLayout={hostCatalog.sidebarLayout}
              botCreation={extensionProjection.botCreation}
              activeHostId={snapshot.hostId}
              activeThreadId={draft === null ? activeThreadId ?? "" : ""}
              pendingHostId={
                hostCatalog.pendingLocation?.kind === "thread"
                  ? hostCatalog.pendingLocation.key.hostId
                  : null
              }
              pendingThreadId={
                hostCatalog.pendingLocation?.kind === "thread"
                  ? hostCatalog.pendingLocation.key.threadId
                  : null
              }

            /> : null
          )}
          rightPanel={panelHost ? null : rightPanelView}
        >
        {panelHost ? createPortal(rightPanelView, panelHost.target) : null}
        <div className="workbench-route-stage">
          <WorkbenchPresentationActivityProvider active={conversationRouteOpen}>
          <div
            aria-hidden={!conversationRouteOpen || undefined}
            className="workbench-conversation-route"
            hidden={!conversationSurfaceVisible}
            inert={!conversationRouteOpen || undefined}
          >
        {connectionInterventionNode !== null ? (
          <div className="hostless-workbench__empty-stage">
            {connectionInterventionNode}
          </div>
        ) : draft !== null && draft.submission === null ? (
          <NewThreadDraftPage
            key={draft.id}
            setupNotice={draftSetupNotice}
            setupBlocksSubmission={draftSetupKind === "models" || (draftSetupKind === "catalog-error" && composerCatalog.models.length === 0) || (supportsModelSetup && modelReadiness.isPending)}
            activeTabId={presentation.rightPanel ? panelState.right.activeTabId : null}
            composerPresentationEnabled={conversationRouteOpen}
            draft={draft}
            controller={composerController}
            modelSelectionPolicy={modelSelectionPolicy}
            showExecutionControls={presentation.executionSelection === "selectable"}
            heading={embedded ? intl.formatMessage({
              id: "chat.companionHeading",
              defaultMessage: "What would you like to do together today?",
            }) : undefined}
            placeholder={recoveryPlaceholder ?? (embedded ? intl.formatMessage({
              id: "chat.companionPlaceholder",
              defaultMessage: "Share your thoughts, or ask me to help with something",
            }) : undefined)}
            selectionCatalog={composerSelectionCatalog}
            catalog={composerSuggestionCatalog}
            effectiveSelections={modelSelectionPolicy === "session" ? undefined : composerCatalog.newThreadDefaults ?? undefined}
            personalDefaultsPending={composerCatalog.personalDefaultsPending}
            workspaceOptions={draftWorkspaceOptions}
            workspaceOptionsLoading={projectCatalog.isFetching}
            nativeWorkspacePicking={localProjectPicker !== null}
            activeHostId={snapshot.hostId}
            hostOptions={composerHostOptions}
            connectionPhase={activeHostConnectionPhase}
            onSelectHost={async (machineId) => {
              setWorkspacePickerOpen(false);
              const machine = newConversationMachines.find(machine => machine.id === machineId);
              if (!machine) return;
              const currentAgent = hostCatalog.profiles.find(host => host.hostId === snapshot.hostId)?.agent;
              const target = chooseWorkInHost(machine, currentAgent, snapshot.hostId);
              await hostCatalog.selectHost(target.hostId);
            }}
            onSelectWorkspace={(workspace) => {
              selectDraftWorkspace({
                cwd: workspace.cwd,
                runtimeWorkspaceRoots: workspace.runtimeWorkspaceRoots,
                projectId: workspace.projectId,
              });
            }}
            onBrowseWorkspace={browseWorkspace}
            onResolveAttachment={resolveActiveHostAttachment}
            onRemoveAttachment={removeActiveHostAttachment}
            goals={runtime.resources.goals}
            onCreateGoal={async objective => {
              const content = composerController.getSnapshot().draft;
              await hostCatalog.createGoal({
                commandId: crypto.randomUUID(),
                clientMessageId: crypto.randomUUID(),
                target: draft.target,
                document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: objective }] }] },
                attachments: [], context: [], selections: {
                  ...(composerCatalog.newThreadDefaults?.serviceTier === undefined ? {} : { serviceTier: composerCatalog.newThreadDefaults.serviceTier }),
                  ...(composerCatalog.newThreadDefaults?.model ? { model: composerCatalog.newThreadDefaults.model, ...(composerCatalog.newThreadDefaults.effort === null ? {} : { effort: composerCatalog.newThreadDefaults.effort }) } : {}),
                  ...content.selections,
                }, options: content.options,
                createdAt: Date.now(),
              }, objective);
            }}
            composerAddMenuContent={composerAddMenuContent}
            composerEndActions={composerEndActions}
            shortcutCommands={hostShortcutCommands}
            onSubmit={sendMessage}
          />
        ) : (
          <div className="local-conversation-page">
            <ConversationSummaryLayout controller={summary}>
            <div className="conversation-summary-reading">
                <Conversation
                  onVisibleContentReady={historyPaintReady ? onHistoryVisibleContentReady : undefined}
                  visibleContentReadyKey={historyPaintAttempt ?? undefined}
                  scrollPolicy="natural"
                  onAddSelectionToChat={conversationRouteOpen && activeThreadId !== null ? (text) => {
                    const target = composerController.getSnapshot().draft.target;
                    if (target.type === "new-thread" || target.key.hostId !== snapshot.hostId
                      || target.key.threadId !== activeThreadId) return false;
                    return composerController.appendQuote(text);
                  } : undefined}
                  onTerminalResultVisible={showingDisplayCache ? undefined : (turnId) => {
                    if (activeThreadId !== null) hostCatalog.threadAttention.acknowledge(
                      attentionScope, snapshot.hostId, activeThreadId, turnId);
                  }}
                  emptyState={draft !== null ? <PendingConversationPage
                      embedded
                      conversation={draft}
                      documentContext={{ conversationId: null, cwd: draft.target.execution.workspace.cwd,
                        hostId: draft.target.execution.hostId, theme: appearanceTheme.resolvedTheme,
                        loadMediaSource, onOpenResource: openChatResource }}
                      onRetry={(intent) => hostCatalog.submit(intent).then(() => undefined)}
                    /> : recoveryPresentation === "cold-loading" || recoveryPresentation === "cold-error"
                    ? <ConversationRecoveryEmptyState
                        failed={recoveryPresentation === "cold-error"}
                        requiresUpdate={recoveryRequiresUpdate}
                      />
                    : undefined}
                  key={activeConversationRestoreKey ?? "empty"}
                  documentContext={{
                    conversationId: activeThreadId,
                    mcpApps: mcpAppOwner ?? undefined,
                    cwd: activeProtocolThread?.cwd ?? null,
                    hostId: snapshot.hostId,
                    loadMediaSource,
                    onOpenResource: openChatResource,
                    onReviewTurnDiff: openTurnDiffReview,
                    composerChangeSummaryTurnId: snapshot.conversation?.activeTurn?.turnId ?? null,
                    onForkTurn: !showingDisplayCache && snapshot.conversation?.authoritative === true
                      && activeThreadId !== null && hostCatalog.threadManagement.capabilities(snapshot.hostId).fork
                      ? turnId => forkAndOpenThread({
                          routeScopeId: () => workbenchNavigation.getSnapshot().routeScopeId,
                          fork: () => hostCatalog.threadManagement.fork(snapshot.hostId, activeThreadId, turnId),
                          refreshThreads: refreshConversationCatalog,
                          openThread: childId => hostCatalog.navigate(createWorkbenchThreadLocation(snapshot.hostId, childId)),
                        }) : undefined,
                    theme: appearanceTheme.resolvedTheme,
                  }}
                  timeline={draft === null ? visibleTimeline : null}
                  consumePendingLatestTurnSubmitPlacement={consumeLatestTurnPlacement}
                  navigationSource={showingDisplayCache ? null : navigationSource}
                  searchTarget={conversationSearchTarget?.hostId === snapshot.hostId && conversationSearchTarget.threadId === snapshot.activeThreadId ? conversationSearchTarget : null}
                  initialRestoreSnapshot={
                    activeThreadId === null
                      ? null
                      : routeRestoreCheckpoints.get(activeConversationRestoreKey!)
                  }
                  onRestoreSnapshotChange={(restoreSnapshot) => {
                    if (activeConversationRestoreKey !== null)
                      routeRestoreCheckpoints.set(
                        activeConversationRestoreKey,
                        restoreSnapshot,
                      );
                  }}
                  onLoadItemDetails={loadItemDetails}
                  onLoadOlder={
                    !showingDisplayCache && snapshot.conversation?.history.hasOlder
                      ? loadOlderConversation
                      : undefined
                  }
                  loadingOlder={!showingDisplayCache && snapshot.conversation?.history.loading === true}
                  onOpenSubagent={showingDisplayCache ? undefined : (threadId) => {
                    void hostCatalog.navigate(
                      createWorkbenchThreadLocation(snapshot.hostId, threadId),
                    );
                  }}
                  continuableTurnId={showingDisplayCache ? null : snapshot.conversation?.continuation.turnId}
                  onContinueTurn={showingDisplayCache ? undefined : (turnId) => {
                    const placement = captureLatestTurnPlacement();
                    void activeThreadLease?.continueTurn(turnId).catch(() => {
                      clearLatestTurnPlacement(placement);
                    });
                  }}
                  onRespondInteraction={showingDisplayCache ? undefined : respondToInteraction}
                  onAnswerAsyncQuestion={!showingDisplayCache && snapshot.phase === "ready" ? answerAsyncQuestion : undefined}
                  queuedAsyncQuestionIds={queuedAsyncQuestionIds}
                  onConversationScrollApiChange={(api) => {
                    conversationScrollApiRef.current = api;
                  }}
                  surfaceCapabilities={timelineSurfaceCapabilities}
                  footer={
                    <ThreadComposerPresentation
                      key={panelOwnerId}
                      scopeId={panelOwnerId}
                      forceExpanded={pendingInteraction !== null}
                      controller={composerController}
                      activeTabId={presentation.rightPanel ? panelState.right.activeTabId : null}
                      enabled={conversationRouteOpen}
                      timeline={timeline}
                      documentContext={{ conversationId: activeThreadId, cwd: activeProtocolThread?.cwd ?? null, hostId: snapshot.hostId, loadMediaSource, onOpenResource: openChatResource, onReviewTurnDiff: openTurnDiffReview, composerChangeSummaryTurnId: snapshot.conversation?.activeTurn?.turnId ?? null, theme: appearanceTheme.resolvedTheme }}
                    >
                    <div
                      className="thread-composer-region"
                      data-thread-find-composer="true"
                    >
                    {draft === null && recoveryPresentation === "warm-error" ? <ConversationRecoveryNotice
                      failed requiresUpdate={recoveryRequiresUpdate}
                    /> : null}
                    {conversationContribution?.beforeComposer}
                    <ContinuationFailureNotice scope={JSON.stringify([snapshot.hostId, activeThreadId])}
                      error={snapshot.conversation?.continuation.error} />
                    {pendingInteraction === null ? (
                      <ThreadGoalSurface
                        threadId={snapshot.phase === "ready" ? activeThreadId : null}
                        goals={runtime.resources.goals}
                        portalContainer={portalContainer}
                      >{(goalMenuItem, _goalBusy, goalContent) => (
                      <ThreadRecoveryNotice threadId={snapshot.phase === "ready" ? activeThreadId : null} resource={runtime.resources.turnRecovery}>{recoveryContent => (
                      <OpenCraftComposer
                        attachedContent={goalContent || recoveryContent ? <>{goalContent}{recoveryContent}</> : null}
                        floatingContent={composerChangeSummary}
                        controller={composerController}
                        defaultFollowUpAction={embedded ? "queue" : defaultFollowUpAction}
                        availableFollowUpActions={followUpCapability?.queue === false && followUpCapability?.steer === false ? [] : snapshot.phase !== "ready" || snapshot.conversation?.authoritative !== true
                          || snapshot.conversation.queuedSubmissions.some(item => item.local && item.state === "unknown")
                          ? ["queue"]
                          : (["steer", "queue"] as const).filter(action => followUpCapability?.[action] !== false && runtime.resources.host.canRequest?.(action === "queue" ? "thread/queue/add" : "turn/steer") !== false)}
                        portalContainer={portalContainer}
                        isUnstable={activeThreadId !== null
                          && conversationRecoveryIsUnstable(recoveryPresentation, recoveryDiagnostic)}
                        isRecovering={conversationRecovering}
                        isStreaming={draft === null && isStreaming}
                        isStopping={snapshot.conversation?.activeTurn?.status === "interrupting"}
                        awaitSubmission
                        submissionDisabled={draft !== null || (activeThreadLease === null && localOutbox === null)}
                        queuedSubmissions={[
                          ...visibleQueuedSubmissions(snapshot.conversation?.queuedSubmissions ?? localQueuedSubmissions,
                            visibleTimeline).map((submission) =>
                            queuedSubmissionPresentation(submission, queueReorderable, identityAvatar, intl)),
                          ...(queueUnconfirmedSteerDiscard ? snapshot.conversation?.unconfirmedSteers ?? [] : []).map((claim) => ({
                            id: claim.id,
                            sender: queueSenderPresentation(claim.sender, identityAvatar),
                            preview: claim.input.find((input) => input.type === "text")?.text ?? "Unconfirmed steering message",
                            state: "queued" as const,
                            operation: "idle" as const,
                            actionable: false,
                            reorderable: false,
                            editableContent: restoreQueuedInput(claim.input),
                            pausedReason: "Delivery unconfirmed",
                            error: null,
                            unconfirmedTargetTurnId: claim.targetTurnId,
                          })),
                        ]}
                        onUpdateQueuedSubmission={updateQueuedSubmission}
                        onDeleteQueuedSubmission={deleteQueuedSubmission}
                        onDiscardUnconfirmedSteer={discardUnconfirmedSteer}
                        onReorderQueuedSubmissions={reorderQueuedSubmissions}
                        onSteerQueuedSubmission={steerQueuedSubmission}
                        supportsQueuedSteer={queueAtomicSteer}
                        onResumeQueuedSubmissions={resumeQueuedSubmissions}
                        onResolveAttachment={resolveActiveHostAttachment}
                        onRemoveAttachment={removeActiveHostAttachment}
                        addMenuContent={goalMenuItem === null ? composerAddMenuContent : (closeMenu) => <>
                          {typeof composerAddMenuContent === "function" ? composerAddMenuContent(closeMenu) : composerAddMenuContent}
                          {goalMenuItem(closeMenu)}
                        </>}
                        shortcutCommands={threadShortcutCommands}
                        entryActions={composerDesktopEntry}
                        endActions={composerEndActions}
                        modelSelectionPolicy={modelSelectionPolicy}
                        placeholder={recoveryPlaceholder ?? (embedded ? intl.formatMessage({
                          id: "chat.companionFollowupPlaceholder",
                          defaultMessage: "Tell me what you'd like to do next",
                        }) : undefined)}
                        selectionCatalog={composerSelectionCatalog}
                        catalog={composerSuggestionCatalog}
                        mentionSuggestionsEnabled={false}
                        effectiveSelections={{
                          model: snapshot.conversation?.execution.model,
                          effort: snapshot.conversation?.execution.effort,
                          serviceTier: snapshot.conversation?.execution.serviceTier,
                          permissionProfile:
                            snapshot.conversation?.execution.permissionProfile,
                        }}
                        onSubmit={sendMessage}
                        onCancel={cancelStream}
                      />
                      )}</ThreadRecoveryNotice>
                      )}</ThreadGoalSurface>
                    ) : (
                      <div className="opencraft-composer-stack">
                        {composerChangeSummary}
                        <ConversationPendingInteractionPanel
                          block={pendingInteraction}
                          draftStore={interactionDraftStore}
                          draftScope={activeThreadId === null ? undefined : JSON.stringify([snapshot.hostId, activeThreadId, activeConversationRestoreKey])}
                          requestTurnId={snapshot.conversation?.pendingInteractions.find(interaction => interaction.requestId === pendingInteraction?.requestId)?.turnId}
                          onRespondInteraction={respondToInteraction}
                        />
                      </div>
                        )}
                    {conversationContribution?.afterComposer}
                    </div>
                    </ThreadComposerPresentation>
                  }
                />
            </div>
            <ConversationSummarySurface controller={summary} context={{ scopeKey: summaryScopeKey, title: activeThread?.title ?? undefined, timeline: visibleTimeline, goal: summaryGoal, current: summaryCurrent,
              onOpenResource: path => { if (summaryCurrent) panelRuntime.panels.open(panelOwnerId, "resource", { resource: path }); },
              onOpenThread: threadId => { if (summaryCurrent && displayHostId) hostCatalog.navigate(createWorkbenchThreadLocation(displayHostId, threadId)); },
            }} />
            </ConversationSummaryLayout>
          </div>
        )}
          </div>
          </WorkbenchPresentationActivityProvider>
          <ApplicationRouteMotion route={workbenchNavigationSnapshot.applicationRoute}>
          {standaloneManagementOpen ? (
            <section className="workbench-tool-route" aria-label="Account management">
              {settingsContent}
            </section>
          ) : null}
          {settingsRoute}
          {extensionViewOpen ? (
            <section className="extension-view-route" aria-label={extensionProjection.activeView?.title}>
              {extensionProjection.activeViewNode}
            </section>
          ) : null}
          </ApplicationRouteMotion>
        </div>
        {shortcutHelpOpen ? <WorkbenchShortcutHelp onClose={() => setShortcutHelpOpen(false)} /> : null}
        <ConversationSearch enabled={presentation.shellNavigation} open={conversationSearchOpen} onOpenChange={setConversationSearchOpen}
          sources={multiHostCatalog.searchSources}
          incomplete={multiHostCatalog.discovery === "error" || multiHostCatalog.catalogs.some(catalog => catalog.phase === "error" || catalog.phase === "unavailable" || catalog.partial)}
          threads={multiHostCatalog.threads} loading={multiHostCatalog.discovery === "loading" || multiHostCatalog.catalogs.some(catalog => catalog.phase === "loading")}
          onSelectThread={selectSearchedThread} />
        </AppShell>
      </AppShellRouteRegionsProvider>
        <ModalHost requests={modalRequests} />
      {reviewedBlock === null ? null : <TurnDiffReviewDialog
        block={reviewedBlock}
        initialPath={turnDiffReview?.path ?? null}
        key={`${turnDiffReview?.threadId}:${reviewedBlock.id}:${turnDiffReview?.path ?? "all"}`}
        onClose={() => setTurnDiffReview(null)}
      />}
      <WorkspaceDirectoryPicker
          open={
            !settingsOpen &&
            workspacePickerOpen &&
            draft !== null
          }
          rootPath={workspaceBrowseRoot}
          initialPath={draft?.target.execution.workspace.cwd}
          title="Choose a folder"
          description={`Browse folders on ${activeHost.label}.`}
          confirmLabel="Use folder"
          onReadDirectory={readWorkspaceDirectory}
          onCancel={() => setWorkspacePickerOpen(false)}
          onChoose={chooseWorkspaceDirectory}
        />
    </ConversationReferenceSurface>
    </ScheduledTaskCatalogContext.Provider>
    </IdentityAvatarContext.Provider>
    </ImageEditorContext.Provider>
  );
}
