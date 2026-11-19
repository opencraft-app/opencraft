import type { Context } from "@deepseek-ai/cordis";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectComposerModelChoices, type AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { composerCapabilitiesOptions } from "../runtime/composer-capabilities-query";
import { WorkbenchComposer } from "../components/workbench-composer";
import { createInteractionResponse, type ConversationBindingStore, type ConversationScopeId, type SideChatService, type SideChatSession } from "@opencraft/workbench-runtime";
import type { PanelRendererProps } from "@opencraft/workbench-panels-react";
import { Conversation } from "../components/conversation";
import { useAppearanceTheme } from "../appearance-theme";
import { useIntl } from "@opencraft/i18n/react";
import { IconButton } from "@opencraft/design-system-web/button";
import { ChevronLeftIcon } from "@opencraft/design-system-web/action-icons";
import { ControlSurface } from "@opencraft/design-system-web/control-surface";
import { useShellPresentation } from "../components/shell-presentation";
import { useThreadCatalog } from "../runtime/appserver-runtime-context";

export function SideChatContent({ session, service, runtime, active = true, operationError }: { session: SideChatSession; service: SideChatService; runtime: AppServerWorkbenchRuntime; active?: boolean; operationError?: string | null }) {
  const catalog = useQuery(composerCapabilitiesOptions(session.key.hostId, session.key.threadId, runtime.resources.composerCatalog));
  const displayModels = projectComposerModelChoices(catalog.data?.metadataReader === runtime.resources.composerCatalog ? catalog.data.models : []);
  const theme = useAppearanceTheme().resolvedTheme;
  const snapshot = useSyncExternalStore(session.lease.subscribe, session.lease.getSnapshot, session.lease.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const initiallyFocused = useRef(false);
  useEffect(() => {
    if (!active || initiallyFocused.current) return;
    // The pending fork has no editor. Transfer input only after its active
    // panel and Composer have mounted; cancelling the frame retires old owners.
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel?.isConnected || panel.closest("[inert], [hidden]") || panel.getClientRects().length === 0) return;
      initiallyFocused.current = true;
      session.composer.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, session.composer]);
  return <div ref={panelRef} className="side-chat-panel">
    <SideChatHeader parentThreadId={session.parent.threadId} />
    {operationError ? <p role="alert">Side chat close failed: {operationError}. Try closing again.</p> : null}
    {snapshot.error ? <p role="alert">{snapshot.error.message}</p> : null}
    <Conversation active={active} scrollPolicy="natural" timeline={snapshot.timeline}
      documentContext={{ conversationId: session.key.threadId, hostId: session.key.hostId, cwd: snapshot.execution.cwd, theme }}
      onRespondInteraction={async (requestId, action) => {
        const pending = session.lease.getSnapshot().pendingInteractions.find(item => item.requestId === requestId);
        if (!pending) throw new Error("This request is no longer pending");
        await session.lease.respond(createInteractionResponse(pending, action));
      }}
      onLoadItemDetails={(ids, signal) => session.lease.loadItemDetails(ids, signal)}
      onLoadOlder={snapshot.history.hasOlder ? () => session.lease.loadOlder() : undefined}
      history={snapshot.history}
      footer={<div className="thread-composer-region">
        {error ? <p role="alert">{error}</p> : null}
        <WorkbenchComposer modelDisplayOnly controller={session.composer}
          navigationForeground="tools" actionsDisabled={!active || !snapshot.authoritative}
          defaultFollowUpAction="steer" availableFollowUpActions={["steer"]}
          isStreaming={snapshot.activeTurn !== null} isStopping={snapshot.activeTurn?.status === "interrupting"}
          submissionDisabled={!active || !snapshot.authoritative}
          selectionCatalog={{ models: [], displayModels, permissionProfiles: [] }}
          effectiveSelections={{ model: snapshot.execution.model, effort: snapshot.execution.effort, serviceTier: snapshot.execution.serviceTier, permissionProfile: snapshot.execution.permissionProfile }}
          onSubmit={(intent, context) => {
            if (!active || !session.lease.getSnapshot().authoritative) return false;
            setError(null);
            // Rejection must be synchronous: the shared editor consumes an
            // accepted follow-up immediately, before transport acknowledgement.
            if (context.followUpAction === "queue" && session.lease.getSnapshot().activeTurn !== null) {
              setError("Side chats do not support queued follow-ups. Use steer or wait for the response.");
              return false;
            }
            return service.submit(session.id, intent, context.followUpAction).catch(cause => {
              setError(cause instanceof Error ? cause.message : String(cause));
              throw cause;
            });
          }}
          onCancel={(context) => { if (!active) return; const turn = session.lease.getSnapshot().activeTurn; if (turn) void session.lease.interrupt(turn.turnId, { source: "side-chat-stop", ...context }).catch(cause => setError(String(cause))); }} />
      </div>} />
  </div>;
}

export function createSideChatPanelPlugin(service: SideChatService, bindings: ConversationBindingStore, resolveRuntime: (hostId: string) => AppServerWorkbenchRuntime | null) {
  function SideChatPanel({ tab, active, ownerId }: PanelRendererProps) {
    useSyncExternalStore(listener => service.subscribe(listener), service.getRevision, service.getRevision);
    const session = tab.resource ? service.get(tab.resource) : null;
    const parent = bindings.resolve(ownerId as ConversationScopeId)?.conversationKey;
    const creationError = tab.resource ? service.getCreationError(tab.resource) : null;
    const failure = creationError ?? (tab.resource ? service.getRecoveryError(tab.resource) : null);
    const runtime = session ? resolveRuntime(session.key.hostId) : null;
    return session && runtime ? <SideChatContent key={session.id} session={session} service={service} runtime={runtime} active={active} operationError={failure?.message} />
      : <div className="right-panel-empty" role={failure ? "alert" : "status"}>
        {failure ? `${creationError ? "Side chat creation failed" : "Side chat recovery failed"}: ${failure.message}` : "Restoring side chat…"}
        {failure && parent ? <button onClick={() => void (creationError && tab.resource ? service.retryCreation(tab.resource) : service.restore(parent)).catch(() => {})}>Retry</button> : null}
      </div>;
  }
  return Object.assign(function SideChatPanelPlugin(ctx: Context) {
    const removes = [
      ctx.workbenchPanels.register<{ id: string; resource: string; title: string; pending: boolean }>({
        kind: "sidechat",
        tabDirectory: {
          read: ownerId => {
            const parent = bindings.resolve(ownerId as ConversationScopeId)?.conversationKey;
            return parent ? [...service.pendingIds(parent).map(id => ({ id: `sidechat-loading:${id}`, resource: id, kind: "sidechat", region: "right" as const, title: service.getCreationError(id) ? "Side chat failed" : "Starting side chat…", icon: "chat", showTabIcon: true, preview: false, closable: Boolean(service.getCreationError(id)) })), ...service.records(parent).map(session => ({ id: `sidechat:${session.key.threadId}`, resource: session.id, kind: "sidechat", region: "right" as const, title: "Side chat", icon: "chat", showTabIcon: true, preview: false, closable: true }))] : [];
          },
          subscribe: (ownerId, changed) => {
            const releaseSessions = service.subscribe(changed);
            const releaseBindings = bindings.subscribe(() => {
              changed();
              const parent = bindings.resolve(ownerId as ConversationScopeId)?.conversationKey;
              if (parent) void service.restore(parent).catch(() => console.warn("Side chat directory recovery failed"));
            });
            return () => { releaseSessions(); releaseBindings(); };
          },
        },
        hydrateTabs: async ownerId => {
          const binding = bindings.resolve(ownerId as ConversationScopeId);
          if (binding?.conversationKey) await service.restore(binding.conversationKey);
          return [];
        },
        restoreTabs: ownerId => {
          const parent = bindings.resolve(ownerId as ConversationScopeId)?.conversationKey;
          return parent ? service.list(parent).map(session => ({ id: `sidechat:${session.key.threadId}`, resource: session.id, kind: "sidechat", region: "right", title: "Side chat", icon: "chat", showTabIcon: true, preview: false, closable: true })) : [];
        },
        createTab: params => ({ id: params.id, resource: params.resource, kind: "sidechat", region: "right", title: params.title, icon: "chat", showTabIcon: true, preview: false, closable: !params.pending }),
        disposeTab: (tab, _owner, reason) => {
          if (!tab.resource) return;
          if (reason !== "close") return;
          if (tab.id.startsWith("sidechat-loading:") && !service.getCreationError(tab.resource)) { service.cancel(tab.resource); return; }
          // Only explicit user close retires a persistent resource.
          void service.close(tab.resource).catch(() => {
            // A failed remote commit did not close the resource. Restore its
            // presentation so the original session and close retry stay reachable.
            const parent = bindings.resolve(_owner as ConversationScopeId)?.conversationKey;
            const retained = service.get(tab.resource!) || (parent && service.records(parent).some(record => record.id === tab.resource));
            if (retained) ctx.workbenchPanels.open(_owner, "sidechat", { id: tab.id, resource: tab.resource!, title: "Side chat", pending: false });
          });
        },
      }),
      ctx.workbenchPanelRenderers.register({ kind: "sidechat", Component: SideChatPanel,
        residency: "while-tab-open", previewPresentation: "retained-view", previewAnchor: "end" }),
      ctx.workbenchPanels.registerToolbarAction({
        id: "sidechat.new", region: "right", order: 30, label: "New side chat", creationLabel: "Side chat", icon: "chat",
        isAvailable: context => bindings.resolve(context.resourceOwnerId as ConversationScopeId)?.conversationKey != null,
        async run(context) {
          const binding = bindings.resolve(context.resourceOwnerId as ConversationScopeId);
          if (!binding?.conversationKey) throw new Error("Select a conversation before opening a side chat");
          const id = crypto.randomUUID();
          const pendingId = `sidechat-loading:${id}`;
          ctx.workbenchPanels.open(context.ownerId, "sidechat", { id: pendingId, resource: id, title: "Starting side chat…", pending: true });
          try {
            const session = await service.open(id, binding.conversationKey, context.cwd);
            const state = ctx.workbenchPanels.getOwnerSnapshot(context.ownerId);
            const pending = [...state.right.tabs, ...state.bottom.tabs].find(tab => tab.id === pendingId);
            const finalId = `sidechat:${session.key.threadId}`;
            // A published directory can already have replaced the loading tab.
            const restored = [...state.right.tabs, ...state.bottom.tabs].some(tab => tab.id === finalId && tab.resource === id);
            if (!pending && !restored) { await service.close(id); return; }
            ctx.workbenchPanels.open(context.ownerId, "sidechat", { id: finalId, resource: id, title: "Side chat", pending: false });
            ctx.workbenchPanels.dispatch(context.ownerId, { type: "force-close-tab", region: pending?.region ?? "right", tabId: pendingId });
          } catch (error) {
            // The service retains the failed attempt and original child. Keep
            // its panel visible so Retry never allocates a duplicate fork.
            if (!service.getCreationError(id)) throw error;
          }
        },
      }),
    ];
    ctx.effect(() => () => removes.reverse().forEach(dispose => dispose()));
  }, { inject: ["workbenchPanels", "workbenchPanelRenderers"] });
}

/**
 * Touch presentation reuses the conversation's floating chrome. The only
 * difference from the main chat is this header hint naming the side chat.
 */
export function SideChatHeader({ parentThreadId }: { parentThreadId?: string }) {
  const intl = useIntl();
  const shell = useShellPresentation();
  const catalog = useThreadCatalog();
  const parentTitle = parentThreadId ? catalog.threads.find(thread => thread.id === parentThreadId)?.title : undefined;
  const back = intl.formatMessage({ id: "sideChat.header.back", defaultMessage: "Back to conversation" });
  return <header className="side-chat-header" data-retained-preview-chrome>
    <ControlSurface surface="floating" className="side-chat-header__group">
      <IconButton className="chrome-button" type="button" aria-label={back} title={back}
        onClick={() => { if (shell?.selectPrimary) shell.selectPrimary(); else shell?.toggleRightPanel(); }}>
        <ChevronLeftIcon size={20} />
      </IconButton>
    </ControlSurface>
    <span className="side-chat-header__copy">
      {parentTitle ? <strong>{parentTitle}</strong> : null}
      <span className="side-chat-header__badge">{intl.formatMessage({ id: "sideChat.header.title", defaultMessage: "Side chat" })}</span>
    </span>
  </header>;
}
