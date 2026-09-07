import {
  retargetSubmitIntentForFollowUp,
  type ComposerFollowUpAction,
  type SubmitIntent,
} from "@opencraft/composer-core";
import { findPendingInteraction } from "@opencraft/chat-core";
import { useStableEvent } from "@opencraft/react-runtime";
import type { TurnConversationScrollApi } from "@opencraft/timeline-virtualizer";
import {
  createInteractionResponse,
  createWorkbenchThreadLocation,
  encodeWorkbenchLocation,
  type WorkbenchInteractionAction,
} from "@opencraft/workbench-runtime";
import { demoChangedFiles } from "@opencraft/workbench-runtime/demo";
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
  useThreadCatalog,
  useConversationScopeRegistry,
  useConversationScopeRegistrySnapshot,
  useRootComposerController,
  useActiveWorkbenchThread,
  useWorkbenchRuntime,
  useWorkbenchController,
  useWorkbenchSnapshot,
} from "../runtime/runtime-context";
import { WorkbenchComposer } from "./workbench-composer";
import {
  WorkbenchConversation,
  WorkbenchPendingInteractionPanel,
  type WorkbenchConversationRestoreSnapshot,
} from "./workbench-conversation";
import { WorkbenchHeader } from "./workbench-header";
import { WorkbenchRightPanel } from "./workbench-right-panel";
import { WorkbenchSidebar } from "./workbench-sidebar";

interface WorkbenchFrameSharedProps {
  platformLayout: "native" | "web";
}

export function WorkbenchFrameShared({ platformLayout }: WorkbenchFrameSharedProps) {
  const runtime = useWorkbenchRuntime();
  const activeThreadLease = useActiveWorkbenchThread();
  const workbench = useWorkbenchController();
  const snapshot = useWorkbenchSnapshot();
  const conversationScopes = useConversationScopeRegistry();
  const draftSnapshot = useConversationScopeRegistrySnapshot();
  const draft = draftSnapshot.activeDraftId === null
    ? null
    : draftSnapshot.drafts.find((candidate) => candidate.id === draftSnapshot.activeDraftId) ?? null;
  const composerController = useRootComposerController();
  const catalog = useThreadCatalog();
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const metrics = theme.metrics;
  const split = width >= metrics.layout.splitBreakpoint;
  const phone = width < metrics.layout.phoneBreakpoint;
  const roomy = width >= metrics.layout.roomyBreakpoint;
  const previousSplit = useRef(split);
  const conversationRestoreSnapshots = useRef(new Map<string, WorkbenchConversationRestoreSnapshot>());
  const conversationScrollApiRef = useRef<TurnConversationScrollApi | null>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(split);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const activeThread = catalog.threads.find((thread) => thread.id === snapshot.activeThreadId);
  const activeConversationRestoreKey = snapshot.activeThreadId === null
    ? null
    : encodeWorkbenchLocation(
        createWorkbenchThreadLocation(snapshot.hostId, snapshot.activeThreadId),
      );
  const timeline = snapshot.conversation?.timeline ?? null;
  const pendingInteraction = findPendingInteraction(timeline);
  const isStreaming = snapshot.conversation?.activeTurn !== null && snapshot.conversation?.activeTurn !== undefined;
  const loadOlderConversation = useStableEvent(() => activeThreadLease?.loadOlder() ?? Promise.resolve());
  const dockedSidebar = split && sidebarOpen;
  const overlaySidebar = !split && sidebarOpen;
  const topInset = platformLayout === "native" ? insets.top : 0;
  const bottomInset = platformLayout === "native" ? insets.bottom : 0;

  useEffect(() => {
    if (previousSplit.current === split) return;
    previousSplit.current = split;
    setSidebarOpen(split);
  }, [split]);

  const selectThread = (id: string) => {
    void workbench.activateThread(id);
    if (!split) setSidebarOpen(false);
  };

  const submitIntent = useCallback(async (
    intent: SubmitIntent,
    context: { readonly followUpAction: ComposerFollowUpAction | null } = { followUpAction: null },
  ) => {
    const currentConversation = activeThreadLease?.getSnapshot() ?? null;
    let submittedIntent = intent;
    const followsActiveTurn = context.followUpAction !== null
      && currentConversation?.activeTurn !== null
      && currentConversation?.activeTurn !== undefined;
    if (followsActiveTurn) {
      submittedIntent = retargetSubmitIntentForFollowUp(
        intent,
        currentConversation.key,
        currentConversation.activeTurn.turnId,
        context.followUpAction!,
      );
    } else if (intent.target.type !== "new-thread") {
      conversationScrollApiRef.current?.prepareLatestTurnSubmitPlacement();
    }
    try {
      await workbench.submit(submittedIntent);
      return true;
    } catch (error) {
      if (!followsActiveTurn) {
        conversationScrollApiRef.current?.clearPendingLatestTurnSubmitPlacement();
      }
      throw error;
    }
  }, [activeThreadLease, runtime, workbench]);

  const submitSuggestion = useCallback((text: string) => {
    if (text.trim().length === 0) return;
    composerController.dispatch({
      type: "set-document",
      document: {
        version: 1,
        blocks: [{ type: "paragraph", children: [{ type: "text", text }] }],
      },
    });
    let intent: SubmitIntent;
    try {
      intent = composerController.createSubmitIntent();
    } catch {
      return;
    }
    composerController.dispatch({ type: "set-lifecycle", phase: "submitting" });
    void submitIntent(intent).then(() => {
      composerController.dispatch({ type: "clear" });
    }, (error: unknown) => {
      composerController.dispatch({
        type: "set-lifecycle",
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, [composerController, submitIntent]);

  const respondToInteraction = useCallback(async (requestId: string, action: WorkbenchInteractionAction) => {
    const interaction = activeThreadLease?.getSnapshot().pendingInteractions.find((candidate) => candidate.requestId === requestId);
    if (interaction === undefined) throw new Error(`Interaction ${requestId} is no longer pending`);
    if (activeThreadLease === null) throw new Error("No active Thread is available");
    await activeThreadLease.respond(createInteractionResponse(interaction, action));
  }, [activeThreadLease]);

  const createTask = () => {
    const activeProtocolThread = catalog.protocolThreads.find((thread) => thread.id === snapshot.activeThreadId);
    const cwd = activeProtocolThread?.cwd;
    void workbench.openDraft(cwd);
    if (!split) setSidebarOpen(false);
  };

  const sidebar = (
    <WorkbenchSidebar
      activeThreadId={snapshot.activeThreadId ?? ""}
      onClose={() => setSidebarOpen(false)}
      onNewTask={createTask}
      onSelectThread={selectThread}
      threads={catalog.threads}
      topInset={topInset}
    />
  );

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
      style={styles.root}
    >
      <View style={styles.shell}>
        {dockedSidebar ? <View style={styles.sidebarDock}>{sidebar}</View> : null}

        <View style={[styles.mainSurface, dockedSidebar && styles.mainSurfaceDocked, phone && styles.mainSurfacePhone]}>
          <WorkbenchHeader
            onToggleRightPanel={() => setDetailsOpen((value) => !value)}
            onToggleSidebar={() => setSidebarOpen((value) => !value)}
            rightPanelOpen={detailsOpen}
            roomy={roomy}
            sidebarOpen={dockedSidebar}
            thread={activeThread}
            topInset={topInset}
          />

          <View style={styles.threadSurface}>
            <WorkbenchConversation
              bottomScrollPaddingPx={composerHeight + 16}
              key={activeConversationRestoreKey ?? "empty"}
              initialRestoreSnapshot={activeConversationRestoreKey === null ? null : conversationRestoreSnapshots.current.get(activeConversationRestoreKey)}
              onLoadOlder={snapshot.conversation?.history.hasOlder ? loadOlderConversation : undefined}
              onRespondInteraction={respondToInteraction}
              onConversationScrollApiChange={(api) => {
                conversationScrollApiRef.current = api;
              }}
              onSuggestion={submitSuggestion}
              onRestoreSnapshotChange={(restoreSnapshot) => {
                if (activeConversationRestoreKey !== null) conversationRestoreSnapshots.current.set(activeConversationRestoreKey, restoreSnapshot);
              }}
              timeline={timeline}
            />
            <View onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)} style={styles.composerOverlay}>
              {pendingInteraction === null ? (
                <WorkbenchComposer
                  bottomInset={bottomInset}
                  controller={composerController}
                  isStreaming={isStreaming}
                  onCancel={() => {
                    const turnId = activeThreadLease?.getSnapshot().activeTurn?.turnId;
                    if (turnId !== undefined) void activeThreadLease?.interrupt(turnId);
                  }}
                  onSubmit={submitIntent}
                />
              ) : (
                <WorkbenchPendingInteractionPanel
                  block={pendingInteraction}
                  bottomInset={bottomInset}
                  onRespondInteraction={respondToInteraction}
                />
              )}
            </View>
          </View>
        </View>

        {overlaySidebar ? (
          <View style={styles.overlay}>
            <Pressable accessibilityLabel="Close sidebar" onPress={() => setSidebarOpen(false)} style={styles.scrim} />
            <View style={[styles.sidebarSheet, phone && styles.sidebarSheetPhone]}>{sidebar}</View>
          </View>
        ) : null}

        {detailsOpen ? (
          <View style={styles.overlay}>
            <Pressable accessibilityLabel="Close task details" onPress={() => setDetailsOpen(false)} style={styles.scrim} />
            <View style={styles.detailsSheet}>
              <WorkbenchRightPanel files={demoChangedFiles} onClose={() => setDetailsOpen(false)} topInset={topInset} />
            </View>
          </View>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.material.canvas },
  shell: { flex: 1, minWidth: 0, flexDirection: "row", backgroundColor: theme.material.canvas },
  sidebarDock: { width: theme.metrics.sidebar.width, flexShrink: 0 },
  mainSurface: {
    minWidth: 0,
    flex: 1,
    overflow: "hidden",
    margin: theme.metrics.layout.canvasInset,
    borderRadius: theme.metrics.layout.surfaceRadius,
    backgroundColor: theme.material.content,
    shadowColor: theme.shadow.prominent.color,
    shadowOpacity: theme.shadow.prominent.opacity,
    shadowRadius: theme.shadow.prominent.radius,
    shadowOffset: { width: 0, height: theme.shadow.prominent.offsetY },
    elevation: theme.shadow.prominent.elevation,
  },
  mainSurfaceDocked: { marginLeft: 0 },
  mainSurfacePhone: { margin: 0, borderRadius: 0 },
  threadSurface: { minHeight: 0, flex: 1, backgroundColor: theme.material.content },
  composerOverlay: { position: "absolute", right: 0, bottom: 0, left: 0, zIndex: 20 },
  overlay: { position: "absolute", inset: 0, zIndex: 100, flexDirection: "row" },
  scrim: { position: "absolute", inset: 0, backgroundColor: theme.material.scrim },
  sidebarSheet: {
    width: theme.metrics.sidebar.width,
    overflow: "hidden",
    margin: theme.metrics.layout.canvasInset,
    borderRadius: theme.metrics.layout.surfaceRadius,
    backgroundColor: theme.material.sidebar,
    shadowColor: theme.shadow.prominent.color,
    shadowOpacity: theme.shadow.prominent.opacity,
    shadowRadius: theme.shadow.prominent.radius,
    shadowOffset: { width: 0, height: theme.shadow.prominent.offsetY },
    elevation: theme.shadow.prominent.elevation,
  },
  sidebarSheetPhone: { margin: 0, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 },
  detailsSheet: {
    width: theme.metrics.details.width,
    margin: theme.metrics.layout.canvasInset,
    marginLeft: "auto",
    borderRadius: theme.metrics.details.surfaceRadius,
    shadowColor: theme.shadow.prominent.color,
    shadowOpacity: theme.shadow.prominent.opacity,
    shadowRadius: theme.shadow.prominent.radius,
    shadowOffset: { width: 0, height: theme.shadow.prominent.offsetY },
    elevation: theme.shadow.prominent.elevation,
  },
}));
