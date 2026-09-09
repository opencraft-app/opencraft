import { useQueryClient } from "@tanstack/react-query";
import { TargetConnectionStatus } from "./components/target-connection-status";
import {
  retargetSubmitIntentForFollowUp,
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
import type { ChatResourceDecision } from "@opencraft/chat-render-web";
import type { PlatformViewHost } from "@opencraft/extension-react";
import type {
  LatestTurnPlacementSnapshot,
  TimelineSurfaceCapabilities,
} from "@opencraft/timeline-virtualizer";
import { useStableEvent } from "@opencraft/react-runtime";
import {
  isRightPanelResponsiveBlocked,
  type PanelAction,
} from "@opencraft/workbench-panels";
import {
  createInteractionResponse,
  createWorkbenchDraftLocation,
  createWorkbenchThreadLocation,
  draftSubmissionOwnsNavigation,
  findHostConnectionInterventionError,
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
import { useSettingsPresentation } from "./components/use-settings-presentation";
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
  Conversation,
  type ConversationInteractionAction,
  type ConversationRestoreSnapshot,
  type ConversationScrollApi,
} from "./components/conversation";
import { ConversationPendingInteractionPanel } from "./components/conversation-renderers/interaction/interaction-renderers";
import { RightPanel } from "./components/right-panel";
import { NewThreadDraftPage } from "./components/new-thread-draft-page";
import { PendingConversationPage } from "./components/pending-conversation-page";
import { Sidebar } from "./components/sidebar";
import { WorkspaceDirectoryPicker } from "./components/workspace-directory-picker";
import { useResponsiveSidebarDock } from "./components/use-responsive-sidebar-dock";
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
import {
  getSidebarMaximumWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MINIMUM_WIDTH,
} from "./components/sidebar-resize-handle";
import { getWindowChromePolicy, useWindowChrome } from "./window-chrome";
import { useTimelineViewportHost } from "./timeline-viewport";
import { ComposerExtensionActions } from "./runtime/composer-action-renderers";
import { useExtensionWorkbenchProjection } from "./runtime/extension-workbench-projection";

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

function reasoningEffortLabel(value: string): string {
  switch (value.toLowerCase()) {
    case "none":
      return "None";
    case "minimal":
      return "Minimal";
    case "low":
      return "Light";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra High";
    case "max":
      return "Max";
    case "ultra":
      return "Ultra";
    default:
      return humanizeCatalogValue(value);
  }
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

export function App() {
  const appearanceTheme = useAppearanceTheme();
  const windowChrome = useWindowChrome();
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
  const extensionPlatform = (
    globalThis as typeof globalThis & {
      opencraftDesktop?: { readonly kind?: string };
    }
  ).opencraftDesktop?.kind === "electron"
    ? "electron"
    : "web";
  const composerEndActions = (
    <ComposerExtensionActions
      controller={composerController}
      disabled={draft !== null && draftSubmissionOwnsNavigation(draft.phase)}
      platform={extensionPlatform}
      registry={hostCatalog.composerActionRenderers}
    />
  );
  const conversationViewIdentity = useConversationViewIdentity();
  const conversationViewActivation = useConversationViewActivation();
  const snapshot = useAppServerSnapshot();
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
      hostCatalog.hosts.map((host) => ({
        id: host.hostId,
        label: host.label,
        kind: host.kind,
        transportEndpoint: host.transportEndpoint,
        executionLocation:
          host.executionLocation ?? hostKindDescription(host.kind),
        workspaceBrowseRoots: host.workspaceBrowseRoots,
      })),
    [hostCatalog.hosts],
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
      const initialize = runtime.resources.host.getInitializeResult();
      return resolveBrowserAttachment(file, pending, {
        directory:
          initialize === null
            ? null
            : `${initialize.codexHome.replace(/\/+$/u, "")}/opencraft-attachments`,
        writeFile:
          initialize === null
            ? null
            : (path, dataBase64) =>
                runtime.resources.fileSystem.writeFile(path, dataBase64),
      }, images, signal);
    },
    [runtime, images],
  );
  const catalog = useThreadCatalog();
  const multiHostCatalog = useMultiHostThreadCatalog();
  const projectCatalog = useProjectCatalog();
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const { sidebarOpen, setSidebarOpen } = useResponsiveSidebarDock();
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const storedWidth = Number.parseFloat(
      window.localStorage.getItem("sidebar-width") ?? "",
    );
    const initialWidth = Number.isFinite(storedWidth)
      ? storedWidth
      : SIDEBAR_DEFAULT_WIDTH;
    return Math.max(
      SIDEBAR_MINIMUM_WIDTH,
      Math.min(initialWidth, getSidebarMaximumWidth(window.innerWidth)),
    );
  });
  // Codex projects the single persisted sidebar-width signal into a root
  // layout token. Top-level routes consume the token instead of inventing
  // route-local widths, so switching routes cannot move the content boundary.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty(
      "--codex-sidebar-preferred-width",
      `${sidebarWidth}px`,
    );
    return () => {
      document.documentElement.style.removeProperty(
        "--codex-sidebar-preferred-width",
      );
    };
  }, [sidebarWidth]);
  const [rightPanelResponsiveBlocked, setRightPanelResponsiveBlocked] =
    useState(() =>
      isRightPanelResponsiveBlocked({
        viewportWidth: window.innerWidth,
        sidebarOpen,
      }),
    );
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
  const canGoBack = workbenchNavigationSnapshot.canGoBack;
  const canGoForward = workbenchNavigationSnapshot.canGoForward;
  const settingsOpen =
    workbenchNavigationSnapshot.applicationRoute.kind === "settings";
  const settingsPresentation = useSettingsPresentation(sidebarWidth);
  const shellSidebarOpen = settingsOpen ? settingsPresentation.showIndex : sidebarOpen;
  const extensionViewOpen =
    workbenchNavigationSnapshot.applicationRoute.kind === "extension-view";
  const conversationRouteOpen =
    workbenchNavigationSnapshot.applicationRoute.kind === "conversation";
  const settingsSection =
    workbenchNavigationSnapshot.applicationRoute.kind === "settings"
      ? workbenchNavigationSnapshot.applicationRoute.slug
      : "connections";
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
    platform: extensionPlatform,
    activeHostId: snapshot.hostId,
    profiles: hostCatalog.profiles,
    provisionHost: hostCatalog.provisionHost,
    removeHost: hostCatalog.removeHost,
    openView: workbenchNavigation.openExtensionView,
    replaceViewResource: workbenchNavigation.replaceExtensionViewResource,
  }), [extensionPlatform, hostCatalog, snapshot.hostId, workbenchNavigation]);
  const extensionProjection = useExtensionWorkbenchProjection({
    contributions: hostCatalog.extensionContributions,
    renderers: hostCatalog.platformViewRenderers,
    botDirectory: hostCatalog.botDirectory,
    host: extensionViewHost,
    applicationRoute: workbenchNavigationSnapshot.applicationRoute,
    openSettings: workbenchNavigation.openSettings,
    openView: workbenchNavigation.openExtensionView,
  });
  const connectionIntervention = findHostConnectionInterventionError(
    conversationViewActivation.error,
  );
  const activeHostProviderId = hostCatalog.profiles.find(
    (profile) => profile.hostId === activeHost.hostId,
  )?.providerId ?? null;
  const connectionInterventionNode = connectionIntervention === null
    || connectionIntervention.providerId !== activeHostProviderId
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
        selectedProjectStorageKey(snapshot.hostId),
        workspace.projectId,
      );
      if (draft === null) throw new Error("No active Draft can be retargeted");
      hostCatalog.retargetDraft(draft.id, {
        hostId: draft.target.execution.hostId,
        workspace,
      });
    },
    [draft, hostCatalog],
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
  const createTask = useCallback(() => {
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
    void hostCatalog
      .openDraft({
        execution: { hostId, workspace },
        entrypoint: "new-chat",
      })
      .catch((error) => {
        console.error("Failed to activate New chat Draft", error);
      });
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
    (initialUrl?: string) => {
      browserWorkbench.open(conversationResourceOwnerId, {
        panelOwnerId,
        ...(initialUrl === undefined ? {} : { initialUrl }),
      });
    },
    [browserWorkbench, conversationResourceOwnerId, panelOwnerId],
  );

  useLayoutEffect(() => {
    browserWorkbench.bindView(conversationResourceOwnerId, panelPresentationId);
  }, [browserWorkbench, conversationResourceOwnerId, panelPresentationId]);

  const openChatResource = useCallback(
    (target: string, decision: ChatResourceDecision) => {
      if (decision.kind === "mail") {
        window.open(target, "_blank", "noopener,noreferrer");
        return;
      }
      if (decision.kind === "external") {
        try {
          openBrowserTab(target);
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
        createTask();
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
  }, [composerController, createTask, toggleRightPanel]);

  useEffect(() => {
    const updateRightPanelLayout = () => {
      setRightPanelResponsiveBlocked(
        isRightPanelResponsiveBlocked({
          viewportWidth: window.innerWidth,
          sidebarOpen,
        }),
      );
    };
    updateRightPanelLayout();
    window.addEventListener("resize", updateRightPanelLayout);
    return () => window.removeEventListener("resize", updateRightPanelLayout);
  }, [sidebarOpen]);

  useEffect(() => {
    const clampSidebarToViewport = () => {
      setSidebarWidth((currentWidth) =>
        Math.min(currentWidth, getSidebarMaximumWidth(window.innerWidth)),
      );
    };
    window.addEventListener("resize", clampSidebarToViewport);
    return () => window.removeEventListener("resize", clampSidebarToViewport);
  }, []);

  const collapseSidebar = useCallback(() => setSidebarOpen(false), []);
  const expandSidebar = useCallback(() => setSidebarOpen(true), []);
  const commitSidebarWidth = useCallback((width: number, persist: boolean) => {
    setSidebarWidth(width);
    if (persist) window.localStorage.setItem("sidebar-width", String(width));
  }, []);

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
      agents: composerCatalog.agents.map((agent) => ({
        id: agent.id,
        label: agent.displayName,
        description: agent.description || null,
        engineKind: agent.engineKind,
        isDefault: agent.isDefault,
        defaultModel: agent.defaultModel,
        modelIds: agent.modelIds,
        available: agent.available,
        unavailableReason: agent.unavailableReason,
      })),
      models: composerCatalog.models
        .filter((model) => !model.hidden)
        .map((model) => ({
          id: model.id,
          value: model.model,
          label: model.displayName,
          description: model.description || null,
          isDefault: model.isDefault,
          defaultEffort: model.defaultReasoningEffort || null,
          efforts: model.supportedReasoningEfforts.map((effort) => ({
            value: effort.reasoningEffort,
            label: reasoningEffortLabel(effort.reasoningEffort),
            description: effort.description || null,
          })),
        })),
      permissionProfiles: composerCatalog.permissionProfiles.map((profile) => ({
        id: profile.id,
        value: profile.id,
        label: permissionProfileLabel(profile.id),
        description: profile.description,
        disabled: !profile.allowed,
      })),
      isFetching: composerCatalog.isFetching,
      modelError: composerCatalog.modelError?.message ?? null,
      permissionProfileError:
        composerCatalog.permissionProfileError?.message ?? null,
    }),
    [
      composerCatalog.isFetching,
      composerCatalog.agents,
      composerCatalog.modelError,
      composerCatalog.models,
      composerCatalog.permissionProfileError,
      composerCatalog.permissionProfiles,
    ],
  );
  const draftWorkspaceOptions = useMemo(() => {
    return buildDraftWorkspaceOptions(projectCatalog.projects);
  }, [projectCatalog.projects]);
  const readWorkspaceDirectory = useCallback(
    async (path: string) =>
      (await runtime.resources.fileSystem.readDirectory(path)).entries,
    [runtime],
  );
  const chooseWorkspaceDirectory = useCallback(
    async (path: string) => {
      let project = projectCatalog.projects.find((candidate) =>
        candidate.roots.some((root) => root.path === path),
      );
      if (project === undefined) {
        const name = path.split("/").filter(Boolean).at(-1) ?? "Project";
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
    ],
  );
  const workspaceBrowseRoot =
    activeHost.workspaceBrowseRoots[0] ??
    draft?.target.execution.workspace.runtimeWorkspaceRoots[0] ??
    null;
  const closeSettings = () => {
    settingsPresentation.openContent();
    workbenchNavigation.closeSettings();
  };
  const selectSettingsSection = (section: string) => {
    workbenchNavigation.openSettings(section);
    settingsPresentation.openContent();
  };
  const settingsNavigation = settingsOpen ? (
    <Suspense fallback={null}>
      <SettingsNavigation
        section={settingsSection}
        onSectionChange={selectSettingsSection}
        extensionContributions={hostCatalog.extensionContributions}
        profiles={hostCatalog.profiles}
        activeHostId={snapshot.hostId}
        onBack={closeSettings}
      />
    </Suspense>
  ) : null;
  const settingsRoute = settingsOpen ? (
    <section className="settings-page" aria-label="Settings" inert={settingsPresentation.indexOnly || undefined} aria-hidden={settingsPresentation.indexOnly || undefined}>
      {settingsPresentation.compact ? <nav className="settings-page__compact-navigation" aria-label="Settings navigation"><button className="settings-navigation-link" type="button" onClick={settingsPresentation.openIndex}><span aria-hidden="true">‹</span>Settings</button></nav> : null}
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
          onAdd={hostCatalog.addWebSocketHost}
          onRemove={hostCatalog.removeHost}
          onProvisionHost={hostCatalog.provisionHost}
          onOpenView={workbenchNavigation.openExtensionView}
          onReplaceViewResource={workbenchNavigation.replaceExtensionViewResource}
          extensionContributions={hostCatalog.extensionContributions}
          extensionManager={hostCatalog.extensionManager}
          platformViewRenderers={hostCatalog.platformViewRenderers}
          themes={appearanceTheme.availableThemes}
          themeId={appearanceTheme.themeId}
          themePreference={appearanceTheme.preference}
          onThemeChange={setAppearanceThemeId}
          onThemePreferenceChange={setThemePreference}
        />
      </Suspense>
    </section>
  ) : null;
  const presentedRightPanelOpen =
    panelState.right.open && !rightPanelResponsiveBlocked;
  const presentedRightPanelFullWidth =
    panelState.rightPanelFullWidth && !rightPanelResponsiveBlocked;
  // Settings is an application-level route with its own navigation and back
  // transaction. Workbench history controls do not exist in that route; an
  // empty action rail also leaves the native titlebar as one continuous drag
  // surface instead of mounting disabled conversation controls.
  const headerNavigationActions = settingsOpen
    ? []
    : chromePolicy.leadingNavigationActions;
  const header = (
    <AppShellHeader
      title={
        settingsOpen
          ? null
          : extensionViewOpen
            ? (extensionProjection.activeView?.title ?? null)
          : draft === null
            ? (activeThread?.title ?? "Untitled task")
            : null
      }
      project={
        settingsOpen || extensionViewOpen
          ? null
          : draft === null
            ? (activeThread?.project ?? "OpenCraft")
            : null
      }
      sidebarOpen={shellSidebarOpen}
      rightPanelOpen={conversationRouteOpen && presentedRightPanelOpen}
      rightPanelFullWidth={conversationRouteOpen && presentedRightPanelFullWidth}
      showRightPanelAction={conversationRouteOpen}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      onToggleSidebar={() => setSidebarOpen((value) => !value)}
      onToggleRightPanel={toggleRightPanel}
      onHome={createTask}
      onBack={workbenchNavigation.back}
      onForward={workbenchNavigation.forward}
      navigationActions={headerNavigationActions}
    />
  );

  return (
    <>
      <AppShell
          layoutScope={`${workbenchNavigationSnapshot.applicationRoute.kind}:${panelOwnerId}`}
          sidebarOpen={shellSidebarOpen}
          sidebarTransientEnabled={!settingsOpen}
          sidebarResizable={!settingsOpen}
          sidebarCollapsible={!settingsOpen}
          sidebarWidth={settingsOpen ? settingsPresentation.sidebarWidth : sidebarWidth}
          windowChrome={windowChrome}
          onSidebarCollapse={settingsOpen ? () => undefined : collapseSidebar}
          onSidebarExpand={expandSidebar}
          onSidebarResizeEnd={commitSidebarWidth}
          rightPanelOpen={conversationRouteOpen && presentedRightPanelOpen}
          rightPanelFullWidth={conversationRouteOpen && presentedRightPanelFullWidth}
          onRightPanelOpenChange={(open) =>
            dispatchPanel({
              type: "set-region-open",
              region: "right",
              open,
              reason: "manual",
            })
          }
          header={header}
          floatingSidebarHeader={(onDock) => (
            <AppShellNavigationControls
              hostRole="transient"
              sidebarOpen={false}
              canGoBack={canGoBack}
              canGoForward={canGoForward}
              onToggleSidebar={onDock}
              onHome={createTask}
              onBack={workbenchNavigation.back}
              onForward={workbenchNavigation.forward}
              actions={headerNavigationActions}
            />
          )}
          leftPanel={
            settingsOpen ? settingsNavigation : <Sidebar
              threads={multiHostCatalog.threads}
              renderTargetStatus={(hostId) => <TargetConnectionStatus hostId={hostId} />}
              onNewTaskForTarget={(hostId) => hostCatalog.openDraft({
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
                workbenchNavigation.openSettings(settingsPageId ?? "connections");
              }}
              primaryActions={extensionProjection.primaryActions}
              footerActions={extensionProjection.footerActions}
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
              onNewTask={createTask}
              // The route adapter consumes both the DOM event and the old
              // route's focus before issuing a semantic navigation command.
              onOpenSettings={openSettingsFromConversation}
            />
          }
          rightPanel={
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
              onCloseTab={(tab) => {
                panelRuntime.panels.close(panelOwnerId, tab.region, tab.id);
              }}
            />
          }
        >
        <div className="workbench-route-stage">
          <div
            aria-hidden={!conversationRouteOpen || undefined}
            className="workbench-conversation-route"
            hidden={!conversationRouteOpen}
            inert={!conversationRouteOpen || undefined}
          >
        {draft !== null && draft.submission === null ? (
          <NewThreadDraftPage
            key={draft.id}
            draft={draft}
            controller={composerController}
            selectionCatalog={composerSelectionCatalog}
            catalog={composerSuggestionCatalog}
            workspaceOptions={draftWorkspaceOptions}
            workspaceOptionsLoading={projectCatalog.isFetching}
            activeHostId={snapshot.hostId}
            hostOptions={composerHostOptions}
            connectionPhase={snapshot.phase}
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
            onBrowseWorkspace={() => {
              if (workspaceBrowseRoot !== null) setWorkspacePickerOpen(true);
            }}
            onResolveAttachment={resolveActiveHostAttachment}
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
              connectionInterventionNode !== null ? (
                <div className="hostless-workbench__empty-stage">
                  {connectionInterventionNode}
                </div>
              ) : <section className="conversation-hydration" role="status">
                <span
                  className="conversation-hydration__pulse"
                  aria-hidden="true"
                />
                <div>
                  <strong>
                    {conversationViewActivation.phase === "error"
                      ? "Could not restore this conversation"
                      : "Restoring conversation"}
                  </strong>
                  <p>
                    {conversationViewActivation.error?.message ??
                      `Connecting to ${activeHost.label}…`}
                  </p>
                </div>
                {conversationViewActivation.phase === "error" &&
                hostCatalog.currentLocation.kind === "thread" ? (
                  <button
                    type="button"
                    onClick={() => {
                      void hostCatalog.navigate(
                        hostCatalog.currentLocation,
                        "replace",
                      );
                    }}
                  >
                    Try again
                  </button>
                ) : null}
              </section>
            ) : (
              <Conversation
                scrollPolicy="response-placement"
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
                  <div
                    className="thread-composer-region"
                    data-thread-find-composer="true"
                  >
                    {!snapshot.conversation?.authoritative ? (
                      <section className="conversation-hydration" role={snapshot.conversation?.error ? "alert" : "status"}>
                        <div>
                          <strong>{snapshot.conversation?.error ? "Could not restore this conversation" : "Restoring conversation"}</strong>
                          <p>{snapshot.conversation?.error?.message ?? "Loading conversation history…"}</p>
                        </div>
                        {snapshot.conversation?.error ? (
                          <button type="button" onClick={() => { void activeThreadLease?.retryRestore().catch(() => undefined); }}>
                            Try again
                          </button>
                        ) : null}
                      </section>
                    ) : null}
                    {snapshot.conversation?.continuation.error ? (
                      <p role="alert">{snapshot.conversation.continuation.error.message}</p>
                    ) : null}
                    {pendingInteraction === null ? (
                      <CodexComposer
                        controller={composerController}
                        isStreaming={isStreaming}
                        submissionDisabled={snapshot.phase !== "ready" || snapshot.conversation?.authoritative !== true}
                        queuePausedReason={
                          snapshot.conversation?.queue.pausedReason ?? null
                        }
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
                          error: submission.error?.message ?? null,
                        }))}
                        onUpdateQueuedSubmission={updateQueuedSubmission}
                        onDeleteQueuedSubmission={deleteQueuedSubmission}
                        onReorderQueuedSubmissions={reorderQueuedSubmissions}
                        onSteerQueuedSubmission={steerQueuedSubmission}
                        onResumeQueuedSubmissions={resumeQueuedSubmissions}
                        onResolveAttachment={resolveActiveHostAttachment}
                        endActions={composerEndActions}
                        selectionCatalog={composerSelectionCatalog}
                        catalog={composerSuggestionCatalog}
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
                }
              />
            )}
          </div>
        )}
          </div>
          {settingsRoute}
          {extensionViewOpen ? (
            <section className="extension-view-route" aria-label={extensionProjection.activeView?.title}>
              {extensionProjection.activeViewNode}
            </section>
          ) : null}
        </div>
        </AppShell>
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
