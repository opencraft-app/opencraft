import {
  retargetSubmitIntentForFollowUp,
  type ComposerAttachment,
  type ComposerFollowUpAction,
  type SubmitIntent,
} from "@opencraft/composer-core";
import { findPendingInteraction, type TimelineSnapshot } from "@opencraft/chat-core";
import type { ChatResourceDecision } from "@opencraft/chat-render-react";
import { useStableEvent } from "@opencraft/react-runtime";
import type {
  LatestTurnPlacementSnapshot,
  TurnConversationScrollApi,
} from "@opencraft/timeline-virtualizer";
import {
  createInteractionResponse,
  createWorkbenchThreadLocation,
  encodeWorkbenchLocation,
  type WorkbenchInteractionAction,
} from "@opencraft/workbench-runtime";
import { setStringAsync } from "expo-clipboard";
import { Button } from "heroui-native";
import { HistoryIcon as History, AddIcon as Plus } from "@opencraft/design-system-native/action-icons";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Animated, KeyboardAvoidingView, Linking, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useWorkbenchTheme } from "../styles/workbench-styles";
import type { ScreenRect } from "../runtime/mobile-chat-keyboard-geometry";
import { mobileDeveloperLog } from "../runtime/mobile-developer-log";
import { resolveNativeAttachment, type NativeAttachmentSource } from "../runtime/native-attachment-resolver";
import { nativeAttachmentSession } from "../runtime/native-attachment-session";
import { useMobileChatKeyboardLayout } from "../runtime/mobile-chat-keyboard-layout";
import { nativeChatResourceAction, type NativeChatResourceAction } from "../runtime/native-chat-resource";
import { createNativeChatMediaSourceLoader } from "../runtime/native-chat-media";

import {
  useThreadCatalog,
  useComposerModelCatalog,
  useComposerPermissionProfiles,
  useProjectCatalog,
  useActiveHostDescriptor,
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
import { WorkbenchSidebar } from "./workbench-sidebar";
import { NativeChatResourcePreview } from "./native-chat-resource-preview";

interface WorkbenchFrameSharedProps {
  platformLayout: "native" | "web";
  embedded?: boolean;
  keyboardActive?: boolean;
  language?: "zh-CN" | "en";
}

// Clipboard ownership stays in the platform host; ChatUI only requests a copy.
async function copyConversationText(text: string): Promise<void> {
  if (!await setStringAsync(text)) throw new Error("Clipboard write was not accepted");
}

export function WorkbenchFrameShared({ platformLayout, embedded = false, keyboardActive = true, language = "en" }: WorkbenchFrameSharedProps) {
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
  const modelCatalog = useComposerModelCatalog();
  const canSelectWorkspace = draft?.target.type === "new-thread"
    && (draft.phase === "editing" || draft.phase === "submit-failed");
  const projects = useProjectCatalog(canSelectWorkspace);
  const permissionProfiles = useComposerPermissionProfiles(
    draft?.target.type === "new-thread"
      ? draft.target.execution.workspace.cwd
      : snapshot.conversation?.execution.cwd ?? null,
  );
  const resolveAttachment = useCallback((source: NativeAttachmentSource, pending: ComposerAttachment, signal?: AbortSignal) => {
    const capability = runtime.resources.attachments.capabilities();
    return resolveNativeAttachment(source, pending, capability?.sources.includes("client-bytes") ? {
      maxBytes: capability.maxBytes,
      chunkBytes: capability.chunkBytes,
      uploadChunk: params => runtime.resources.attachments.uploadChunk(params),
      uploadCancel: id => runtime.resources.attachments.uploadCancel(id),
      stage: request => runtime.resources.attachments.stage(request),
    } : null, signal);
  }, [runtime]);
  const removeAttachment = useCallback(async (attachment: ComposerAttachment) => {
    const ref = attachment.metadata?.attachmentRef;
    if (typeof ref !== "object" || ref === null || !("id" in ref) || typeof ref.id !== "string") return;
    await runtime.resources.attachments.remove(ref.id);
  }, [runtime]);
  const selectWorkspace = useCallback((projectId: string, cwd: string) => {
    if (draft === null || draft.target.type !== "new-thread"
      || (draft.phase !== "editing" && draft.phase !== "submit-failed")) return;
    const project = projects.find(candidate => candidate.id === projectId);
    if (!project || !project.roots.some(root => root.path === cwd)) return;
    const updated = conversationScopes.retargetDraft(draft.id, {
      hostId: draft.target.execution.hostId,
      workspace: {
        cwd,
        runtimeWorkspaceRoots: project.roots.map(root => root.path),
        projectId,
      },
    });
    composerController.dispatch({ type: "switch-target", target: updated.target });
  }, [composerController, conversationScopes, draft, projects]);
  const activeHost = useActiveHostDescriptor();
  const { theme } = useWorkbenchTheme();
  const insets = useSafeAreaInsets();
  const [width, setWidth] = useState(0);
  const metrics = theme.metrics;
  const split = width >= metrics.layout.splitBreakpoint;
  const phone = width < metrics.layout.phoneBreakpoint;
  const previousSplit = useRef(split);
  const conversationRestoreSnapshots = useRef(new Map<string, WorkbenchConversationRestoreSnapshot>());
  const conversationScrollApiRef = useRef<TurnConversationScrollApi | null>(null);
  const pendingLatestTurnPlacementRef = useRef<LatestTurnPlacementSnapshot | null>(null);
  const consumeLatestTurnPlacement = useCallback(() => {
    const placement = pendingLatestTurnPlacementRef.current;
    pendingLatestTurnPlacementRef.current = null;
    return placement;
  }, []);
  const [composerHeight, setComposerHeight] = useState(0);
  const chatViewportRef = useRef<View>(null);
  const viewportMeasureRevision = useRef(0);
  const [chatViewport, setChatViewport] = useState<ScreenRect | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(split);
  const activeThread = catalog.threads.find((thread) => thread.id === snapshot.activeThreadId);
  const activeProtocolThread = catalog.protocolThreads.find((thread) => thread.id === snapshot.activeThreadId);
  const [resourcePreview, setResourcePreview] = useState<Extract<NativeChatResourceAction, { kind: "file" }> | null>(null);
  const canOpenResource = useCallback((target: string, decision: ChatResourceDecision) =>
    nativeChatResourceAction(target, decision).kind !== "unavailable", []);
  const openResource = useCallback((target: string, decision: ChatResourceDecision) => {
    const action = nativeChatResourceAction(target, decision);
    if (action.kind === "file") setResourcePreview(action);
    else if (action.kind === "external") void Linking.openURL(action.url).catch(() => mobileDeveloperLog.log("chat.resource.open.failed"));
  }, []);
  const readResourceFile = useCallback((path: string, signal: AbortSignal) =>
    runtime.resources.fileSystem.readFile(path, signal), [runtime]);
  const loadMediaSource = useMemo(() => createNativeChatMediaSourceLoader(runtime, snapshot.hostId), [runtime, snapshot.hostId]);
  const activeConversationRestoreKey = snapshot.activeThreadId === null
    ? null
    : encodeWorkbenchLocation(
        createWorkbenchThreadLocation(snapshot.hostId, snapshot.activeThreadId),
      );
  useEffect(() => () => {
    pendingLatestTurnPlacementRef.current = null;
    conversationScrollApiRef.current?.releaseLatestTurnSubmitPlacementCapture();
  }, [activeConversationRestoreKey]);
  useEffect(() => setResourcePreview(null), [snapshot.hostId, snapshot.activeThreadId]);
  const timeline = snapshot.conversation?.timeline ?? null;
  const [cachedTimeline, setCachedTimeline] = useState<TimelineSnapshot | null>(null);
  useEffect(() => {
    let current = true;
    setCachedTimeline(null);
    if (snapshot.activeThreadId !== null && workbench.displayContinuity !== null) {
      void workbench.displayContinuity.load(snapshot.hostId, snapshot.activeThreadId).then(value => {
        if (current) setCachedTimeline(value);
      });
    }
    return () => { current = false; };
  }, [snapshot.activeThreadId, snapshot.hostId, workbench.displayContinuity]);
  useEffect(() => {
    if (timeline?.authoritative && workbench.displayContinuity !== null) {
      void workbench.displayContinuity.observe(timeline).catch(() => undefined);
    }
  }, [timeline, workbench.displayContinuity]);
  const memoryTimeline = snapshot.activeThreadId === null ? null
    : workbench.displayContinuity?.peek(snapshot.hostId, snapshot.activeThreadId) ?? null;
  const visibleTimeline = timeline?.authoritative || (timeline?.frames.length ?? 0) > 0
    ? timeline
    : memoryTimeline !== null ? memoryTimeline
    : cachedTimeline?.key.hostId === snapshot.hostId && cachedTimeline.key.threadId === snapshot.activeThreadId
      ? cachedTimeline
      : timeline;
  const showingDisplayCache = visibleTimeline !== null && visibleTimeline !== timeline;
  const pendingInteraction = findPendingInteraction(timeline);
  const isStreaming = snapshot.conversation?.activeTurn !== null && snapshot.conversation?.activeTurn !== undefined;
  const loadOlderConversation = useStableEvent(() => activeThreadLease?.loadOlder() ?? Promise.resolve());
  const dockedSidebar = split && sidebarOpen;
  const overlaySidebar = !split && sidebarOpen;
  const topInset = platformLayout === "native" && !embedded ? insets.top : 0;
  // The composer owns the Home Indicator spacing even when the Bot shell supplies the toolbar.
  const bottomInset = platformLayout === "native" ? insets.bottom : 0;
  const embeddedKeyboardActive = platformLayout === "native" && embedded && keyboardActive && Platform.OS === "ios";
  const composerWidth = Math.min(Math.max(0, (chatViewport?.width ?? 0) - theme.spacing[6] * 2), metrics.composer.maximumWidth);
  const keyboardLayout = useMobileChatKeyboardLayout({
    active: embeddedKeyboardActive,
    viewport: chatViewport,
    composerHeight,
    composerWidth,
    bottomClearance: Math.max(bottomInset, metrics.composer.outerBottomInset),
    keyboardGap: theme.spacing[3],
    controlsHeight: metrics.composer.actionRowHeight,
    normalInputMaximumHeight: metrics.composer.inputMaximumHeight,
  });

  const measureChatViewport = useCallback(() => {
    const view = chatViewportRef.current;
    const revision = ++viewportMeasureRevision.current;
    view?.measureInWindow((x, y, width, height) => {
      if (viewportMeasureRevision.current !== revision || chatViewportRef.current !== view) return;
      setChatViewport(current => current?.x === x && current.y === y && current.width === width && current.height === height
        ? current : { x, y, width, height });
    });
  }, []);
  useLayoutEffect(measureChatViewport, [measureChatViewport, width, dockedSidebar]);

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
    let submittedPlacement: LatestTurnPlacementSnapshot | null = null;
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
    }
    if (
      intent.target.type !== "new-thread"
      && (!followsActiveTurn || context.followUpAction === "steer")
    ) {
      submittedPlacement = conversationScrollApiRef.current?.captureLatestTurnSubmitPlacement() ?? null;
      pendingLatestTurnPlacementRef.current = submittedPlacement;
    }
    try {
      await workbench.submit(submittedIntent);
      return true;
    } catch (error) {
      if (submittedPlacement !== null && pendingLatestTurnPlacementRef.current === submittedPlacement) {
        pendingLatestTurnPlacementRef.current = null;
        conversationScrollApiRef.current?.releaseLatestTurnSubmitPlacementCapture();
      }
      throw error;
    }
  }, [activeThreadLease, runtime, workbench]);

  const submitSuggestion = useCallback((text: string) => {
    if (text.trim().length === 0 || composerController.getSnapshot().draft.lifecycle.phase === "submitting") return;
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
    const originDraftId = composerController.getSnapshot().draft.id;
    const submissionAssets = nativeAttachmentSession(composerController);
    composerController.dispatch({ type: "set-lifecycle", phase: "submitting" });
    void submitIntent(intent).then(() => {
      composerController.settleSubmission(originDraftId, intent, { status: "accepted" });
      submissionAssets.settleSubmission(originDraftId, "accepted");
    }, () => {
      mobileDeveloperLog.log("chat.submit.failed");
      composerController.settleSubmission(originDraftId, intent, {
        status: "failed",
        error: language === "zh-CN" ? "消息发送失败，请重试。" : "Could not send this message. Please try again.",
      });
      submissionAssets.settleSubmission(originDraftId, "failed");
    });
  }, [composerController, language, submitIntent]);

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
      behavior={Platform.OS === "ios" && !embedded ? "padding" : undefined}
      keyboardVerticalOffset={0}
      style={styles.root}
      onLayout={event => {
        const measuredWidth = event.nativeEvent.layout.width;
        if (measuredWidth > 0) setWidth(current => current === measuredWidth ? current : measuredWidth);
      }}
    >
      <View style={styles.shell}>
        {dockedSidebar ? <View style={styles.sidebarDock}>{sidebar}</View> : null}

        <View style={[styles.mainSurface, dockedSidebar && styles.mainSurfaceDocked, phone && styles.mainSurfacePhone]}>
          {embedded ? <View style={styles.embeddedToolbar}>
            <Button variant="ghost" onPress={() => setSidebarOpen((value) => !value)} accessibilityLabel={language === "zh-CN" ? "会话列表" : "Conversations"}>
              <History size={19} color={theme.color.text.primary} />
              <Button.Label>{language === "zh-CN" ? "会话" : "Conversations"}</Button.Label>
            </Button>
            <Button variant="ghost" onPress={createTask} accessibilityLabel={language === "zh-CN" ? "新对话" : "New chat"}>
              <Plus size={19} color={theme.color.text.primary} />
            </Button>
            {snapshot.phase === "error" ? <Button variant="ghost" onPress={() => { void runtime.reconnect().catch(() => undefined); }} accessibilityLabel={language === "zh-CN" ? "重试连接" : "Retry connection"}>
              <Button.Label>{language === "zh-CN" ? "重试" : "Retry"}</Button.Label>
            </Button> : null}
          </View> : <WorkbenchHeader
            hostLabel={activeHost.label}
            hostPhase={snapshot.phase}
            onToggleSidebar={() => setSidebarOpen((value) => !value)}
            sidebarOpen={dockedSidebar}
            thread={activeThread}
            topInset={topInset}
          />}

          <View ref={chatViewportRef} collapsable={false} onLayout={measureChatViewport} style={styles.threadSurface}>
            <WorkbenchConversation
              language={language}
              conversationId={snapshot.activeThreadId}
              hostId={snapshot.hostId}
              cwd={activeProtocolThread?.cwd ?? null}
              onOpenResource={openResource}
              canOpenResource={canOpenResource}
              loadMediaSource={loadMediaSource}
              onCopyText={copyConversationText}
              footerScrollPaddingPx={composerHeight + 16 + keyboardLayout.reservedShift}
              key={activeConversationRestoreKey ?? "empty"}
              initialRestoreSnapshot={activeConversationRestoreKey === null ? null : conversationRestoreSnapshots.current.get(activeConversationRestoreKey)}
              onLoadOlder={!showingDisplayCache && snapshot.conversation?.history.hasOlder ? loadOlderConversation : undefined}
              onOpenSubagent={showingDisplayCache ? undefined : (threadId) => selectThread(threadId)}
              onRespondInteraction={showingDisplayCache ? undefined : respondToInteraction}
              onConversationScrollApiChange={(api) => {
                conversationScrollApiRef.current = api;
              }}
              consumePendingLatestTurnSubmitPlacement={consumeLatestTurnPlacement}
              onSuggestion={showingDisplayCache ? () => undefined : submitSuggestion}
              emptyCopy={embedded ? {
                title: snapshot.phase === "error"
                  ? language === "zh-CN" ? "暂时无法连接" : "Could not connect"
                  : language === "zh-CN" ? `和 ${activeHost.label} 对话` : `Chat with ${activeHost.label}`,
                description: snapshot.phase === "error"
                  ? language === "zh-CN" ? "请点击上方的重试按钮。" : "Tap Retry above to reconnect."
                  : snapshot.phase !== "ready"
                    ? language === "zh-CN" ? "正在连接智能体…" : "Connecting to your agent…"
                    : language === "zh-CN" ? "发送消息，开始新的对话。" : "Send a message to start a conversation.",
              } : undefined}
              onRestoreSnapshotChange={(restoreSnapshot) => {
                if (activeConversationRestoreKey !== null) conversationRestoreSnapshots.current.set(activeConversationRestoreKey, restoreSnapshot);
              }}
              timeline={visibleTimeline}
            />
            <Animated.View onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)} style={[styles.composerOverlay, keyboardLayout.composerStyle, keyboardLayout.composerMaximumHeight === undefined ? null : { maxHeight: keyboardLayout.composerMaximumHeight }]}>
              {pendingInteraction === null ? (
                <WorkbenchComposer
                  bottomInset={bottomInset}
                  controller={composerController}
                  language={language}
                  inputMaximumHeight={embeddedKeyboardActive ? keyboardLayout.inputMaximumHeight : undefined}
                  maximumHeight={embeddedKeyboardActive ? keyboardLayout.composerMaximumHeight : undefined}
                  isStreaming={isStreaming}
                  models={modelCatalog.models}
                  modelsLoading={modelCatalog.isFetching}
                  modelCatalogFailed={modelCatalog.error !== null && !modelCatalog.isFetching}
                  onRetryModelCatalog={() => { void modelCatalog.refetch(); }}
                  canAttachFiles={runtime.resources.attachments.capabilities()?.sources.includes("client-bytes") === true}
                  permissionProfiles={permissionProfiles}
                  projects={canSelectWorkspace ? projects : []}
                  selectedWorkspace={draft?.target.type === "new-thread" ? draft.target.execution.workspace.cwd : null}
                  onSelectWorkspace={selectWorkspace}
                  onCancel={() => {
                    const turnId = activeThreadLease?.getSnapshot().activeTurn?.turnId;
                    if (turnId !== undefined) void activeThreadLease?.interrupt(turnId);
                  }}
                  onSubmit={submitIntent}
                  onResolveAttachment={resolveAttachment}
                  onRemoveAttachment={removeAttachment}
                />
              ) : (
                <WorkbenchPendingInteractionPanel
                  block={pendingInteraction}
                  bottomInset={bottomInset}
                  onRespondInteraction={respondToInteraction}
                />
              )}
            </Animated.View>
          </View>
        </View>

        {overlaySidebar ? (
          <View style={styles.overlay}>
            <Pressable accessibilityLabel="Close sidebar" onPress={() => setSidebarOpen(false)} style={styles.scrim} />
            <View style={[styles.sidebarSheet, phone && styles.sidebarSheetPhone]}>{sidebar}</View>
          </View>
        ) : null}

        {resourcePreview === null ? null : <NativeChatResourcePreview
          key={resourcePreview.path}
          path={resourcePreview.path}
          title={resourcePreview.title}
          language={language}
          onClose={() => setResourcePreview(null)}
          readFile={readResourceFile}
        />}

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
  embeddedToolbar: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.color.border.default },
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
}));
