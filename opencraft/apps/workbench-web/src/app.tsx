import { useQueryClient } from "@tanstack/react-query";
import { FormattedMessage } from "@opencraft/i18n/react";
import {
  retargetSubmitIntentForFollowUp,
  type ComposerAttachment,
  type ComposerFollowUpAction,
  type SubmitIntent,
} from "@opencraft/composer-core";
import {
  compileSubmitIntent,
  restoreQueuedInput,
} from "@opencraft/composer-appserver";
import {
  CodexComposer,
  type ComposerSelectionCatalog,
} from "@opencraft/codex-composer";
import { asHostId, findPendingInteraction } from "@opencraft/chat-core";
import type { ChatResourceDecision, ChatResourceOpenIntent } from "@opencraft/chat-render-web";
import type { PlatformViewHost } from "@opencraft/extension-react";
import type {
  LatestTurnPlacementSnapshot,
  TimelineSurfaceCapabilities,
} from "@opencraft/timeline-virtualizer";
import { useStableEvent } from "@opencraft/react-runtime";
import { nativeProjectPicker } from "./runtime/project-folder-picker";
import { ThreadTitleWriter } from "@opencraft/workbench-runtime";
import { readCachedThreadName, writeCachedThreadName } from "./runtime/thread-title-cache";
import {
  type PanelAction,
  type PanelTabDescriptor,
} from "@opencraft/workbench-panels";
import {
  createInteractionResponse,
  createWorkbenchDraftLocation,
  createWorkbenchThreadLocation,
  draftSubmissionOwnsNavigation,
  findHostConnectionInterventionError,
  projectComposerModelChoices,
} from "@opencraft/workbench-runtime";
import { OPENCRAFT_THREAD_QUEUE_EXTENSION } from "@opencraft/appserver-protocol";
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

import { withBrowserAmbientContext } from "./browser/browser-ambient-context";
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
import { ConversationPendingInteractionPanel } from "./components/conversation-renderers/interaction/interaction-renderers";
import { RightPanel } from "./components/right-panel";
import { ThreadComposerPresentation } from "./components/thread-composer-presentation";
import { Button } from "./components/ui/button";
import { NewThreadDraftPage } from "./components/new-thread-draft-page";
import { isLightVelaStandaloneManagementSection } from "./components/lightvela-management-route";
import { LightVelaWorkNavigation } from "./components/lightvela-work-navigation";
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
import { WorkspaceDirectoryPicker } from "./components/workspace-directory-picker";
import { useWorkbenchPresentationRoot } from "./components/workbench-presentation-root";
import { useResponsiveSidebarDock } from "./components/use-responsive-sidebar-dock";
import { usePersistedSidebarWidth } from "./components/use-persisted-sidebar-width";
import {
  selectedProjectStorageKey,
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
  useConversationViewIdentity,
  useHostConnectionPhase,
  useRootComposerController,
  useThreadCatalog,
  useMultiHostThreadCatalog,
} from "./runtime/appserver-runtime-context";
import {
  setAppearanceThemeId,
  setThemePreference,
  useAppearanceTheme,
} from "./appearance-theme";
import { resolveBrowserAttachment } from "./runtime/browser-attachment-resolver";
import { createAppServerMediaSourceLoader } from "./runtime/appserver-media-loader";
import { useBlobResources, useImageProcessing } from "./runtime/appserver-runtime-context";
import {
  buildDraftWorkspaceOptions,
  resolveProjectCwd,
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

function permissionProfileLabel(id: string): string {
  switch (id) {
    case ":read-only":
      return "Read only";
    case ":workspace":
    case ":workspace_roots":
      return "Workspace";
    case ":danger-full-access":
      return "Full access";
    default:
      return humanizeCatalogValue(id);
  }
}

function hostKindDescription(kind: string): string {
  switch (kind) {
    case "remote-ssh":
      return "SSH AppServer";
    case "durable":
      return "Durable AppServer";
    case "remote-control":
      return "Remote control AppServer";
    case "wsl":
      return "WSL AppServer";
    default:
      return "Local AppServer";
  }
}

function ConversationHydration({
  detail,
  errorMessage,
  onRetry,
  state,
}: {
  readonly detail: import("react").ReactNode;
  readonly errorMessage?: string | null;
  readonly onRetry?: (() => void) | null;
  readonly state: "loading" | "error";
}) {
  const failed = state === "error";
  return (
    <div className="conversation-hydration-stage">
      <section
        aria-busy={!failed}
        aria-live="polite"
        className="conversation-hydration"
        data-state={state}
        role={failed ? "alert" : "status"}
      >
        <span className="conversation-hydration__indicator" aria-hidden="true">
          <span />
        </span>
        <div className="conversation-hydration__copy">
          <strong>{failed ? <FormattedMessage id="chat.restore.failed" defaultMessage="Could not restore this conversation" /> : <FormattedMessage id="chat.restore" defaultMessage="Restoring conversation" />}</strong>
          <p>{failed ? errorMessage ?? <FormattedMessage id="chat.restore.error" defaultMessage="The conversation could not be loaded." /> : detail}</p>
        </div>
        {failed && onRetry != null ? (
          <button type="button" onClick={onRetry}><FormattedMessage id="common.retry" defaultMessage="Try again" /></button>
        ) : null}
      </section>
    </div>
  );
}

export interface EmbeddedWorkbenchAppSession {
  readonly chatId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly readOnly: boolean;
}

export interface EmbeddedWorkbenchAppActions {
  selectThread(threadId: string): Promise<void>;
  createThread(): Promise<void>;
  renameThread(threadId: string, title: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
}

export interface EmbeddedWorkbenchAppPresentation {
  readonly hostId: string;
  readonly onReady: (threadId: string | null) => void;
  readonly onError: (error: Error) => void;
  readonly onSessionsChange: (detail: {
    readonly sessions: readonly EmbeddedWorkbenchAppSession[];
    readonly loading: boolean;
    readonly selectedChatId: string | null;
  }) => void;
  readonly bindActions: (actions: EmbeddedWorkbenchAppActions) => (() => void);
}

export function App({
  embedded,
  presentation = FULL_WORKBENCH_PRESENTATION,
}: {
  readonly embedded?: EmbeddedWorkbenchAppPresentation;
  readonly presentation?: WorkbenchPresentationPolicy;
} = {}) {
  const internalDeveloperMode = useInternalDeveloperMode();
  const [accountOpen, setAccountOpen] = useState(false);
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
  const hostCatalog = useAppServerHosts();
  const conversationViewIdentity = useConversationViewIdentity();
  const connectorPresentation = useConnectorPresentation(hostCatalog.connectorManager, hostCatalog.connectorApprovals,
    { hostId: hostCatalog.selectedHostId, scopeId: conversationViewIdentity.scopeId }, () => hostCatalog.navigation.openSettings("lightvela.hermes.skills"));
  const extensionPlatform = (
    globalThis as typeof globalThis & {
      opencraftDesktop?: { readonly kind?: string };
    }
  ).opencraftDesktop?.kind === "electron"
    ? "electron"
    : "web";
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
  const conversationViewActivation = useConversationViewActivation();
  const snapshot = useAppServerSnapshot();
  const activeHostConnectionPhase = useHostConnectionPhase(snapshot.hostId);
  const environmentSnapshot = useSyncExternalStore(
    hostCatalog.environmentDirectory.subscribe,
    hostCatalog.environmentDirectory.getSnapshot,
    hostCatalog.environmentDirectory.getSnapshot,
  );
  const queueExtension = runtime.resources.host.getInitializeResult()
    ?.capabilities?.extensions?.[OPENCRAFT_THREAD_QUEUE_EXTENSION];
  const queueReorderable = !(
    typeof queueExtension === "object" &&
    queueExtension !== null &&
    "reorder" in queueExtension &&
    queueExtension.reorder === false
  );
  const activeHost =
    hostCatalog.hosts.find((host) => host.hostId === snapshot.hostId) ??
    hostCatalog.hosts[0]!;
  const composerHostOptions = useMemo(
    () =>
      hostCatalog.hosts.filter(host => hostCatalog.profiles.some(profile => profile.hostId === host.hostId && profile.enabled)).map((host) => ({
        id: host.hostId,
        label: host.label,
        kind: host.kind,
        transportEndpoint: host.transportEndpoint,
        executionLocation:
          host.executionLocation ?? hostKindDescription(host.kind),
        workspaceBrowseRoots: host.workspaceBrowseRoots,
        resource: environmentSnapshot.entries.find((entry) => entry.profile.hostId === host.hostId)?.resource ?? null,
      })),
    [environmentSnapshot.entries, hostCatalog.hosts, hostCatalog.profiles],
  );
  const queryClient = useQueryClient();
  const blobs = useBlobResources();
  const images = useImageProcessing();
  const loadMediaSource = useMemo(
    () =>
      createAppServerMediaSourceLoader(runtime, blobs, snapshot.hostId),
    [blobs, runtime, snapshot.hostId],
  );
  const resolveActiveHostAttachment = useCallback(
    (file: File, pending: Parameters<typeof resolveBrowserAttachment>[1], signal?: AbortSignal) => {
      return resolveBrowserAttachment(file, pending, {
        stage:
          runtime.resources.attachments.capabilities()?.sources.includes("client-bytes") === true
            ? (request, requestSignal) =>
                runtime.resources.attachments.stage(request, requestSignal)
            : null,
      }, images, signal);
    },
    [runtime, images],
  );
  const removeActiveHostAttachment = useCallback(
    async (attachment: ComposerAttachment) => {
      const ref = attachment.metadata?.attachmentRef;
      if (typeof ref !== "object" || ref === null || !("id" in ref) || typeof ref.id !== "string") return;
      await runtime.resources.attachments.remove(ref.id);
    },
    [runtime],
  );
  const catalog = useThreadCatalog();
  const multiHostCatalog = useMultiHostThreadCatalog();
  const projectCatalog = useProjectCatalog();
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const { sidebarOpen, setSidebarOpen } = useResponsiveSidebarDock();
  const { width: sidebarWidth, commit: commitSidebarWidth } = usePersistedSidebarWidth();
  // Codex projects the single persisted sidebar-width signal into a root
  // layout token. Top-level routes consume the token instead of inventing
  // route-local widths, so switching routes cannot move the content boundary.
  useLayoutEffect(() => {
    if (!presentation.contextSidebar) return;
    document.documentElement.style.setProperty(
      "--codex-sidebar-preferred-width",
      `${sidebarWidth}px`,
    );
    return () => {
      document.documentElement.style.removeProperty(
        "--codex-sidebar-preferred-width",
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
  const workbenchNavigation = hostCatalog.navigation;
  const workbenchNavigationSnapshot = useSyncExternalStore(
    workbenchNavigation.subscribe,
    workbenchNavigation.getSnapshot,
    workbenchNavigation.getSnapshot,
  );
  const routeHeader = useAppShellRouteHeader(
    workbenchNavigationSnapshot.routeScopeId,
  );
  const canGoBack = workbenchNavigationSnapshot.canGoBack;
  const canGoForward = workbenchNavigationSnapshot.canGoForward;
  const settingsOpen =
    workbenchNavigationSnapshot.applicationRoute.kind === "settings";
  const extensionViewOpen =
    workbenchNavigationSnapshot.applicationRoute.kind === "extension-view";
  const conversationRouteOpen =
    workbenchNavigationSnapshot.applicationRoute.kind === "conversation";
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
    && isLightVelaStandaloneManagementSection(settingsSection);
  const routeSettingsOpen = settingsOpen && !managementSettingsOpen;
  // A target-management route is a modal semantic surface. The underlying
  // conversation keeps its physical shell and geometry, but is inert while
  // the dialog owns interaction and focus.
  const conversationSurfaceVisible = conversationRouteOpen
    || (managementSettingsOpen && !standaloneManagementOpen);
  const shellSidebarOpen = presentation.contextSidebar ? sidebarOpen : false;
  const openSettingsFromConversation = useCallback(() => {
    const focusedElement = document.activeElement;
    if (
      focusedElement instanceof HTMLElement &&
      focusedElement.closest(".workbench-conversation-route") !== null
    ) {
      focusedElement.blur();
    }
    workbenchNavigation.openSettings();
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
    openSettings: (section: string) => { setAccountOpen(false); workbenchNavigation.openSettings(section); },
    pushViewResource: workbenchNavigation.pushExtensionViewResource,
    replaceViewResource: workbenchNavigation.replaceExtensionViewResource,
    prepareImageUpload: async (blob) => (await images.compress(blob)).blob,
  }), [extensionPlatform, hostCatalog, images, snapshot.hostId, workbenchNavigation]);
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
  useEffect(() => {
    if (extensionProjection.account?.snapshot.phase === "anonymous") setAccountOpen(false);
  }, [extensionProjection.account?.snapshot.phase]);
  const authenticationPresentation = useAuthenticationPresentation(hostCatalog.authenticationFlows, extensionProjection.account,
    JSON.stringify([hostCatalog.currentLocation, workbenchNavigationSnapshot.applicationRoute]));
  const hostConnectionIntervention = findHostConnectionInterventionError(
    conversationViewActivation.error,
  );
  const activeHostProviderId = hostCatalog.profiles.find(
    (profile) => profile.hostId === activeHost.hostId,
  )?.providerId ?? null;
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
      readonly projectId: string;
    }) => {
      lastDraftWorkspaceRef.current = workspace;
      window.localStorage.setItem(
        selectedProjectStorageKey(draft?.target.execution.hostId ?? snapshot.hostId),
        workspace.projectId,
      );
      if (draft === null) throw new Error("No active Draft can be retargeted");
      hostCatalog.retargetDraft(draft.id, {
        hostId: draft.target.execution.hostId,
        workspace,
      });
    },
    [draft, hostCatalog, snapshot.hostId],
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
  const panelToolbarActions = usePanelToolbarActions();
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
    // Codex keeps the AppShell control plane alive independently from route
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
  const navigationSource = activeThreadLease?.getNavigation() ?? null;
  const pendingInteraction = useMemo(
    () => findPendingInteraction(timeline),
    [timeline],
  );
  const isStreaming =
    snapshot.conversation?.activeTurn !== null &&
    snapshot.conversation?.activeTurn !== undefined;
  const cancelStream = useCallback(() => {
    const turnId = activeThreadLease?.getSnapshot().activeTurn?.turnId;
    if (turnId !== undefined) void activeThreadLease?.interrupt(turnId);
  }, [activeThreadLease]);
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
      if (activeThreadLease === null)
        throw new Error("No active Thread owns this queue");
      await activeThreadLease.deleteQueuedSubmission(id);
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
  const sendMessage = useCallback(
    (
      intent: SubmitIntent,
      context: { readonly followUpAction: ComposerFollowUpAction | null },
    ): boolean | Promise<boolean> => {
      // Host connectivity gates command admission, never Draft editability.
      // Re-check at the semantic boundary as the status can change between a
      // rendered enabled button and its click handler.
      if (snapshot.phase !== "ready") return false;
      const currentConversation = activeThreadLease?.getSnapshot() ?? null;
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
        submittedIntent = withBrowserAmbientContext(
          submittedIntent,
          browserWorkbench.listForOwner(conversationResourceOwnerId),
        );
        submission = hostCatalog.submit(submittedIntent);
      } catch (error) {
        clearLatestTurnPlacement(submittedPlacement);
        throw error;
      }

      if (intent.target.type !== "new-thread") {
        // The active Conversation Runtime synchronously publishes an optimistic
        // item before its transport command begins. At that point it owns the
        // immutable submission and the Composer draft has been consumed. Do
        // not retain the same text in the EditorView while a remote Host (for
        // example Hermes over TAT) is still acknowledging the command.
        void submission.catch(() => {
          clearLatestTurnPlacement(submittedPlacement);
          // Failure presentation belongs to the Conversation Runtime's
          // optimistic item. A later Composer draft must remain untouched.
        });
        return true;
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
      browserWorkbench,
      conversationScopes,
      hostCatalog,
      conversationResourceOwnerId,
      queryClient,
      activeThreadLease,
      captureLatestTurnPlacement,
      clearLatestTurnPlacement,
      snapshot.hostId,
      snapshot.phase,
    ],
  );
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
    const persistedProjectId = window.localStorage.getItem(
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
  const loadOlderConversation = useStableEvent(
    () => activeThreadLease?.loadOlder() ?? Promise.resolve(),
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarOpen((value) => !value);
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "i"
      ) {
        event.preventDefault();
        toggleRightPanel();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        navigateToHome();
        return;
      }
      // Match Codex's global type-to-compose behavior. Printable keys only
      // transfer to Composer when no editable surface, menu or dialog owns
      // the event; browser shortcuts and IME composition remain untouched.
      const target = event.target;
      const targetElement = target instanceof Element ? target : null;
      const ownsTextInput =
        targetElement?.closest(
          "input, textarea, select, button, a, summary, [contenteditable='true'], [role='textbox'], [role='button'], [role='dialog'], [role='menu'], [data-disable-type-to-compose='true']",
        ) !== null;
      if (
        !event.defaultPrevented &&
        !event.isComposing &&
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !ownsTextInput
      ) {
        event.preventDefault();
        composerController.insertText(event.key);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [composerController, navigateToHome, toggleRightPanel]);


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
  );
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
      models: projectComposerModelChoices(composerCatalog.models),
      permissionProfiles: composerCatalog.permissionProfiles.map((profile) => ({
        id: profile.id,
        value: profile.id,
        label: permissionProfileLabel(profile.id),
        description: profile.description,
        disabled: !profile.allowed,
      })),
      isFetching: composerCatalog.isFetching,
      modelError: composerCatalog.modelError?.message ?? null,
      onModelMenuOpen: composerCatalog.onModelMenuOpen,
      retryModels: composerCatalog.retryModels,
      permissionProfileError:
        composerCatalog.permissionProfileError?.message ?? null,
    }),
    [
      composerCatalog.isFetching,
      composerCatalog.modelError,
      composerCatalog.onModelMenuOpen,
      composerCatalog.retryModels,
      composerCatalog.models,
      composerCatalog.permissionProfileError,
      composerCatalog.permissionProfiles,
    ],
  );
  const draftWorkspaceOptions = useMemo(() => {
    return buildDraftWorkspaceOptions(projectCatalog.projects);
  }, [projectCatalog.projects]);
  const [threadActionError, setThreadActionError] = useState<string | null>(null);
  const threadTitleWriter = useMemo(() => new ThreadTitleWriter({
    read: key => readCachedThreadName(queryClient, key),
    write: (key, value) => writeCachedThreadName(queryClient, key, value),
    persist: async (key, value) => {
      await hostCatalog.threadManagement.rename(key.hostId, key.threadId, value);
      await queryClient.invalidateQueries({ queryKey: ["appserver", key.hostId, "threads"] });
    },
  }), [hostCatalog.threadManagement, queryClient]);
  useSyncExternalStore(threadTitleWriter.subscribe, threadTitleWriter.getSnapshot, threadTitleWriter.getSnapshot);
  const restoreArchivedThread = useCallback(async (hostId: string, threadId: string) => {
    await hostCatalog.threadManagement.unarchive(hostId, threadId);
    await queryClient.invalidateQueries({ queryKey: ["appserver", hostId, "threads"] });
  }, [hostCatalog.threadManagement, queryClient]);
  const loadArchivedThreads = useCallback(async (hostId: string) => {
    return hostCatalog.threadManagement.listArchived(hostId);
  }, [hostCatalog.threadManagement]);
  const archivedConversationsAvailable = hostCatalog.threadManagement.capabilities(snapshot.hostId).archive;
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
      };
    });
  }, [catalog.protocolThreads, catalog.threads, embedded]);
  useEffect(() => {
    if (embedded === undefined) return;
    embedded.onSessionsChange({
      sessions: embeddedSessions,
      loading: catalog.isFetching,
      selectedChatId: snapshot.hostId === embedded.hostId ? activeThreadId : null,
    });
  }, [activeThreadId, catalog.isFetching, embedded, embeddedSessions, snapshot.hostId]);
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
      selectThread: async (threadId) => {
        await hostCatalog.navigate(createWorkbenchThreadLocation(embedded.hostId, threadId));
      },
      createThread: async () => { navigateToHome(); },
      renameThread: async (threadId, title) => {
        await hostCatalog.threadManagement.rename(embedded.hostId, threadId, title);
        await queryClient.invalidateQueries({ queryKey: ["appserver", embedded.hostId, "threads"] });
      },
      deleteThread: async (threadId) => {
        await hostCatalog.threadManagement.delete(embedded.hostId, threadId);
        await queryClient.invalidateQueries({ queryKey: ["appserver", embedded.hostId, "threads"] });
        if (activeThreadId === threadId) navigateToHome();
      },
    });
  }, [activeThreadId, embedded, hostCatalog, navigateToHome, queryClient]);
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
      let project = projectCatalog.projects.find((candidate) =>
        candidate.roots.some((root) => root.path === path),
      );
      if (project === undefined) {
        const name = path.split(/[\\/]+/u).filter(Boolean).at(-1) ?? "Project";
        const created = await runtime.resources.projects.create({
          name,
          roots: [{ path }],
          idempotencyKey: `opencraft-web:add-project:${path}`,
          metadata: { origin: "opencraft-web-directory-picker" },
        });
        project = created.project;
        await queryClient.invalidateQueries({
          queryKey: ["appserver", snapshot.hostId, "projects"],
        });
      }
      if (epoch !== workspaceSelectionEpoch.current) return;
      const projectRoots = project.roots.map((root) => root.path);
      const cwd = resolveProjectCwd(project, path);
      selectDraftWorkspace({
        cwd,
        runtimeWorkspaceRoots: projectRoots,
        projectId: project.id,
      });
      setWorkspacePickerOpen(false);
    },
    [
      projectCatalog.projects,
      queryClient,
      runtime,
      selectDraftWorkspace,
      snapshot.hostId,
      draft,
      conversationRouteOpen,
      settingsOpen,
    ],
  );
  const workspaceBrowseRoot =
    activeHost.workspaceBrowseRoots[0] ??
    draft?.target.execution.workspace.runtimeWorkspaceRoots[0] ??
    null;
  const localProjectPicker = nativeProjectPicker(activeHost);
  const browseWorkspace = useCallback(async () => {
    if (localProjectPicker === null) {
      if (workspaceBrowseRoot !== null) setWorkspacePickerOpen(true);
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
  const settingsNavigation = settingsOpen ? (
    <Suspense fallback={null}>
      <SettingsNavigation
        section={settingsSection}
        onSectionChange={selectSettingsSection}
        extensionContributions={hostCatalog.extensionContributions}
        profiles={hostCatalog.profiles}
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
        activeHostId={snapshot.hostId}
        onRemove={hostCatalog.removeHost}
        onProvisionHost={hostCatalog.provisionHost}
        onOpenView={workbenchNavigation.openExtensionView}
        onPushViewResource={workbenchNavigation.pushExtensionViewResource}
        onReplaceViewResource={workbenchNavigation.replaceExtensionViewResource}
        extensionContributions={hostCatalog.extensionContributions}
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
  // Applications replace context/content, never the Shell control plane.
  // Target management remains an independent modal semantic surface.
  const headerNavigationActions = chromePolicy.leadingNavigationActions;
  const presentedHeaderNavigationActions = presentation.shellNavigation ? headerNavigationActions : [];
  const header = (
    <AppShellHeader
      title={
        routeSettingsOpen
          ? null
          : extensionViewOpen
            ? (extensionProjection.activeView?.title ?? null)
          : draft === null
            ? (activeThread?.title ?? "Untitled task")
            : null
      }
      project={
        routeSettingsOpen || extensionViewOpen
          ? null
          : draft === null
            ? (activeThread?.project ?? "OpenCraft")
            : null
      }
      sidebarOpen={shellSidebarOpen}
      rightPanelOpen={conversationSurfaceVisible && presentedRightPanelOpen}
      rightPanelFullWidth={conversationSurfaceVisible && presentedRightPanelFullWidth}
      showRightPanelAction={conversationSurfaceVisible && presentation.rightPanel}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      onToggleSidebar={() => setSidebarOpen((value) => !value)}
      onToggleRightPanel={toggleRightPanel}
      onHome={navigateToHome}
      onBack={workbenchNavigation.back}
      onForward={workbenchNavigation.forward}
      navigationActions={presentedHeaderNavigationActions}
      routeHeaderActive={routeHeader.active}
      routeHeaderHostRef={routeHeader.hostRef}
    />
  );

  return (
    <>
      <InternalDeveloperModeGate />
      <AppShellRouteRegionsProvider
        controller={routeHeader.controller}
        target={routeHeader.target}
      >
      <AppShell
          navigation={!presentation.shellNavigation ? undefined : {
            settingsActive: routeSettingsOpen,
            actions: [
              { id: "shell.chat", title: "Chat", icon: "chat", active: conversationRouteOpen,
                onInvoke: () => { void workbenchNavigation.openChat()
                  .then(changed => { if (!changed) setThreadActionError("当前请求提交中，暂时无法切换页面。"); })
                  .catch(error => setThreadActionError(error instanceof Error ? error.message : String(error))); } },
              ...extensionProjection.primaryActions, ...extensionProjection.footerActions,
            ],
            account: extensionProjection.account === null ? null : {
              snapshot: extensionProjection.account.snapshot,
              signIn: authenticationPresentation.signIn,
            onOpen: () => extensionProjection.account?.snapshot.phase === "anonymous" ? authenticationPresentation.open() : setAccountOpen(true),
              onRefresh: extensionProjection.account.provider.refresh,
              onSignOut: extensionProjection.account.provider.signOut,
            },
            onOpenSettings: openSettingsFromConversation,
          }}
          layoutScope={`${managementSettingsOpen ? "conversation" : workbenchNavigationSnapshot.applicationRoute.kind}:${panelOwnerId}`}
          mainContentLayout={conversationSurfaceVisible ? "thread-edge-scroll" : "default"}
          sidebarOpen={shellSidebarOpen}
          sidebarWidth={presentation.contextSidebar ? sidebarWidth : 0}
          sidebarCollapsible={presentation.contextSidebar}
          sidebarTransientEnabled={presentation.contextSidebar}
          sidebarResizable={presentation.contextSidebar}
          windowChrome={windowChrome}
          onSidebarCollapse={collapseSidebar}
          onSidebarExpand={expandSidebar}
          onSidebarResizeEnd={commitSidebarWidth}
          rightPanelOpen={conversationSurfaceVisible && presentedRightPanelOpen}
          rightPanelFullWidth={conversationSurfaceVisible && presentedRightPanelFullWidth}
          onRightPanelOpenChange={(open) =>
            dispatchPanel({
              type: "set-region-open",
              region: "right",
              open,
              reason: "manual",
              allowEmpty: true,
            })
          }
          header={header}
          floatingSidebarHeader={(onDock) => !presentation.contextSidebar ? null : (
            <AppShellNavigationControls
              hostRole="transient"
              sidebarOpen={false}
              canGoBack={canGoBack}
              canGoForward={canGoForward}
              onToggleSidebar={onDock}
              onHome={navigateToHome}
              onBack={workbenchNavigation.back}
              onForward={workbenchNavigation.forward}
              actions={presentedHeaderNavigationActions}
            />
          )}
          leftPanel={!presentation.contextSidebar ? null : (
            routeSettingsOpen ? settingsNavigation : (conversationSurfaceVisible || standaloneManagementOpen) ? <Sidebar
              threads={multiHostCatalog.threads}
              onNewTaskForTarget={async (hostId) => hostCatalog.navigateToHome({
                  execution: {
                    hostId: asHostId(hostId),
                    workspace: { cwd: null, runtimeWorkspaceRoots: [] },
                  },
                  entrypoint: "new-chat",
                })}
              onOpenTargetSettings={(hostId) => {
                const providerId = hostCatalog.profiles.find(
                  (profile) => profile.hostId === hostId,
                )?.providerId;
                const settingsPageId = hostCatalog.connectionProviders.find(
                  (provider) => provider.id === providerId,
                )?.settingsPageId;
                workbenchNavigation.openSettings(settingsPageId ?? "appearance");
              }}
              managementNavigation={conversationRouteOpen || standaloneManagementOpen ? (
                <LightVelaWorkNavigation
                  section={standaloneManagementOpen ? settingsSection : null}
                  extensionContributions={hostCatalog.extensionContributions}
                  onSectionChange={selectSettingsSection}
                />
              ) : null}
              showFooter={false}
              threadCapabilities={hostId => hostCatalog.threadManagement.capabilities(hostId)}
              pendingTitle={(hostId, threadId) => threadTitleWriter.pendingTitle({ hostId, threadId })}
              threadActions={{
                onRename: (target, title) => threadTitleWriter.rename(target, title),
                onFork: async target => {
                  const origin = workbenchNavigation.getSnapshot().routeScopeId;
                  const childId = await hostCatalog.threadManagement.fork(target.hostId, target.threadId);
                  await queryClient.invalidateQueries({ queryKey: ["appserver", target.hostId, "threads"] });
                  if (workbenchNavigation.getSnapshot().routeScopeId === origin) await hostCatalog.navigate(createWorkbenchThreadLocation(target.hostId, childId));
                },
                onArchive: async target => {
                  await hostCatalog.threadManagement.archive(target.hostId, target.threadId);
                  await queryClient.invalidateQueries({ queryKey: ["appserver", target.hostId, "threads"] });
                },
              }}
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
              onSelectThread={(hostId, id) => {
                if (
                  hostId === snapshot.hostId &&
                  id === activeThreadId &&
                  hostCatalog.pendingLocation === null
                )
                  return;
                if (
                  hostCatalog.pendingLocation?.kind === "thread" &&
                  hostCatalog.pendingLocation.key.hostId === hostId &&
                  hostCatalog.pendingLocation.key.threadId === id
                )
                  return;
                const location = createWorkbenchThreadLocation(hostId, id);
                void hostCatalog.navigate(location).catch((error) => {
                  console.error("Failed to activate selected Thread", error);
                });
              }}
              onNewTask={navigateToHome}
              // The route adapter consumes both the DOM event and the old
              // route's focus before issuing a semantic navigation command.
              onOpenSettings={openSettingsFromConversation}
            /> : null
          )}
          rightPanel={!presentation.rightPanel ? null : (
            <RightPanel
              state={panelState}
              presentationId={panelPresentationId}
              renderers={panelRenderers}
              // Route ownership gates launchers even while the panel's exit
              // animation keeps its physical surface mounted. Do not unregister
              // plugins or close their resources when entering Settings.
              toolbarActions={conversationRouteOpen ? panelToolbarActions : []}
              toolbarActionContext={{
                ownerId: panelOwnerId,
                resourceOwnerId: conversationResourceOwnerId,
                hostId: snapshot.hostId,
                cwd:
                  snapshot.conversation?.execution.cwd
                  ?? activeProtocolThread?.cwd
                  ?? draft?.target.execution.workspace.cwd
                  ?? activeHost.workspaceBrowseRoots[0]
                  ?? null,
              }}
              onAction={dispatchPanel}
              onCloseTab={requestClosePanel}
              portalContainer={portalContainer}
            />
          )}
        >
        <div className="workbench-route-stage">
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
            activeTabId={presentation.rightPanel ? panelState.right.activeTabId : null}
            composerPresentationEnabled={conversationRouteOpen}
            draft={draft}
            controller={composerController}
            selectionCatalog={composerSelectionCatalog}
            catalog={composerSuggestionCatalog}
            workspaceOptions={draftWorkspaceOptions}
            workspaceOptionsLoading={projectCatalog.isFetching}
            nativeWorkspacePicking={localProjectPicker !== null}
            activeHostId={snapshot.hostId}
            hostOptions={composerHostOptions}
            connectionPhase={activeHostConnectionPhase}
            onSelectHost={async (hostId) => {
              setWorkspacePickerOpen(false);
              await hostCatalog.selectHost(hostId);
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
            composerAddMenuContent={composerAddMenuContent}
            composerEndActions={composerEndActions}
            onSubmit={sendMessage}
          />
        ) : draft !== null ? (
          <PendingConversationPage
            conversation={draft}
            onRetry={(intent) => hostCatalog.submit(intent).then(() => undefined)}
          />
        ) : (
          <div className="local-conversation-page">
            {activeThreadLease === null ? (
                <ConversationHydration
                  detail={`Connecting to ${activeHost.label}…`}
                  errorMessage={conversationViewActivation.error?.message}
                  onRetry={conversationViewActivation.phase === "error" && hostCatalog.currentLocation.kind === "thread"
                    ? () => {
                        void hostCatalog.navigate(
                          hostCatalog.currentLocation,
                          "replace",
                        );
                      }
                    : null}
                  state={conversationViewActivation.phase === "error" ? "error" : "loading"}
                />
            ) : (
              <>
                <Conversation
                  scrollPolicy="natural"
                  key={activeConversationRestoreKey ?? "empty"}
                  documentContext={{
                    conversationId: activeThreadId,
                    cwd: activeProtocolThread?.cwd ?? null,
                    hostId: snapshot.hostId,
                    loadMediaSource,
                    onOpenResource: openChatResource,
                    theme: appearanceTheme.resolvedTheme,
                  }}
                  timeline={timeline}
                  consumePendingLatestTurnSubmitPlacement={consumeLatestTurnPlacement}
                  navigationSource={navigationSource}
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
                  onLoadOlder={
                    snapshot.conversation?.history.hasOlder
                      ? loadOlderConversation
                      : undefined
                  }
                  onOpenSubagent={(threadId) => {
                    void hostCatalog.navigate(
                      createWorkbenchThreadLocation(snapshot.hostId, threadId),
                    );
                  }}
                  continuableTurnId={snapshot.conversation?.continuation.turnId}
                  onContinueTurn={(turnId) => {
                    const placement = captureLatestTurnPlacement();
                    void activeThreadLease?.continueTurn(turnId).catch(() => {
                      clearLatestTurnPlacement(placement);
                    });
                  }}
                  onRespondInteraction={respondToInteraction}
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
                      documentContext={{ conversationId: activeThreadId, cwd: activeProtocolThread?.cwd ?? null, hostId: snapshot.hostId, loadMediaSource, onOpenResource: openChatResource, theme: appearanceTheme.resolvedTheme }}
                    >
                    <div
                      className="thread-composer-region"
                      data-thread-find-composer="true"
                    >
                    {snapshot.conversation?.continuation.error ? (
                      <p role="alert">{snapshot.conversation.continuation.error.message}</p>
                    ) : null}
                    {pendingInteraction === null ? (
                      <CodexComposer
                        controller={composerController}
                        portalContainer={portalContainer}
                        isStreaming={isStreaming}
                        submissionDisabled={snapshot.phase !== "ready" || snapshot.conversation?.authoritative !== true}
                        queuedSubmissions={(
                          snapshot.conversation?.queuedSubmissions ?? []
                        ).map((submission) => ({
                          id:
                            submission.serverSubmissionId ??
                            submission.commandId,
                          preview: submission.preview,
                          state: submission.state,
                          operation: submission.operation,
                          actionable: submission.serverSubmissionId !== null,
                          reorderable: queueReorderable,
                          editableContent: restoreQueuedInput(submission.input),
                          pausedReason: submission.pausedReason,
                          error: submission.error?.message ?? null,
                        }))}
                        onUpdateQueuedSubmission={updateQueuedSubmission}
                        onDeleteQueuedSubmission={deleteQueuedSubmission}
                        onReorderQueuedSubmissions={reorderQueuedSubmissions}
                        onSteerQueuedSubmission={steerQueuedSubmission}
                        onResumeQueuedSubmissions={resumeQueuedSubmissions}
                        onResolveAttachment={resolveActiveHostAttachment}
                        onRemoveAttachment={removeActiveHostAttachment}
                        addMenuContent={composerAddMenuContent}
                        endActions={composerEndActions}
                        selectionCatalog={composerSelectionCatalog}
                        catalog={composerSuggestionCatalog}
                        mentionSuggestionsEnabled={false}
                        effectiveSelections={{
                          model: snapshot.conversation?.execution.model,
                          effort: snapshot.conversation?.execution.effort,
                          permissionProfile:
                            snapshot.conversation?.execution.permissionProfile,
                        }}
                        onSubmit={sendMessage}
                        onCancel={cancelStream}
                      />
                    ) : (
                      <ConversationPendingInteractionPanel
                        block={pendingInteraction}
                        onRespondInteraction={respondToInteraction}
                      />
                    )}
                    </div>
                    </ThreadComposerPresentation>
                  }
                />
                {!snapshot.conversation?.authoritative ? (
                  <ConversationHydration
                    detail={<FormattedMessage id="chat.restore.loading" defaultMessage="Loading conversation history…" />}
                    errorMessage={snapshot.conversation?.error?.message}
                    onRetry={() => {
                      void activeThreadLease.retryRestore().catch(() => undefined);
                    }}
                    state={snapshot.conversation?.error ? "error" : "loading"}
                  />
                ) : null}
              </>
            )}
          </div>
        )}
          </div>
          {standaloneManagementOpen ? (
            <section className="lightvela-management-route" aria-label="LightVela management">
              {settingsContent}
            </section>
          ) : null}
          {settingsRoute}
          {extensionViewOpen ? (
            <section className="extension-view-route" aria-label={extensionProjection.activeView?.title}>
              {extensionProjection.activeViewNode}
            </section>
          ) : null}
        </div>
        </AppShell>
      </AppShellRouteRegionsProvider>
        <ModalHost requests={modalRequests} />
      {threadActionError ? <div role="alert" className="settings-control-notice">{threadActionError}<button type="button" onClick={() => setThreadActionError(null)}>关闭提示</button></div> : null}
      <WorkspaceDirectoryPicker
          open={
            !settingsOpen &&
            workspacePickerOpen &&
            draft !== null &&
            workspaceBrowseRoot !== null
          }
          rootPath={workspaceBrowseRoot ?? "/"}
          initialPath={draft?.target.execution.workspace.cwd}
          title="Choose a folder"
          description={`Browse folders on ${activeHost.label}.`}
          confirmLabel="Use folder"
          onReadDirectory={readWorkspaceDirectory}
          onCancel={() => setWorkspacePickerOpen(false)}
          onChoose={chooseWorkspaceDirectory}
        />
    </>
  );
}
