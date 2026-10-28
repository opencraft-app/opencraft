import type { Context } from "@deepseek-ai/cordis";
import { useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectComposerModelChoices, type AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { composerCapabilitiesOptions } from "../runtime/composer-capabilities-query";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { createInteractionResponse, type ConversationBindingStore, type ConversationScopeId, type SideChatService, type SideChatSession } from "@opencraft/workbench-runtime";
import type { PanelRendererProps } from "@opencraft/workbench-panels-react";
import { Conversation } from "../components/conversation";
import { useAppearanceTheme } from "../appearance-theme";

export function SideChatContent({ session, service, runtime }: { session: SideChatSession; service: SideChatService; runtime: AppServerWorkbenchRuntime }) {
  const catalog = useQuery(composerCapabilitiesOptions(session.key.hostId, session.key.threadId, runtime.resources.composerCatalog));
  const displayModels = projectComposerModelChoices(catalog.data?.metadataReader === runtime.resources.composerCatalog ? catalog.data.models : []);
  const theme = useAppearanceTheme().resolvedTheme;
  const snapshot = useSyncExternalStore(session.lease.subscribe, session.lease.getSnapshot, session.lease.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  return <div className="side-chat-panel">
    <p className="side-chat-panel__notice">Side chat · temporary</p>
    {snapshot.error ? <p role="alert">{snapshot.error.message}</p> : null}
    <Conversation scrollPolicy="natural" timeline={snapshot.timeline}
      documentContext={{ conversationId: session.key.threadId, hostId: session.key.hostId, cwd: snapshot.execution.cwd, theme }}
      onRespondInteraction={async (requestId, action) => {
        const pending = session.lease.getSnapshot().pendingInteractions.find(item => item.requestId === requestId);
        if (!pending) throw new Error("This request is no longer pending");
        await session.lease.respond(createInteractionResponse(pending, action));
      }}
      onLoadItemDetails={(ids, signal) => session.lease.loadItemDetails(ids, signal)}
      onLoadOlder={snapshot.history.hasOlder ? () => session.lease.loadOlder() : undefined}
      loadingOlder={snapshot.history.loading}
      footer={<div className="thread-composer-region">
        {error ? <p role="alert">{error}</p> : null}
        <OpenCraftComposer modelDisplayOnly controller={session.composer} defaultFollowUpAction="steer" isStreaming={snapshot.activeTurn !== null} isStopping={snapshot.activeTurn?.status === "interrupting"} submissionDisabled={!snapshot.authoritative}
          selectionCatalog={{ models: [], displayModels, permissionProfiles: [] }}
          effectiveSelections={{ model: snapshot.execution.model, effort: snapshot.execution.effort, serviceTier: snapshot.execution.serviceTier, permissionProfile: snapshot.execution.permissionProfile }}
          onSubmit={(intent, context) => {
            setError(null);
            // Rejection must be synchronous: the shared editor consumes an
            // accepted follow-up immediately, before transport acknowledgement.
            if (context.followUpAction === "queue" && session.lease.getSnapshot().activeTurn !== null) {
              setError("Temporary side chats do not support persistent queues. Use steer or wait for the response.");
              return false;
            }
            return service.submit(session.id, intent, context.followUpAction).catch(cause => {
              setError(cause instanceof Error ? cause.message : String(cause));
              throw cause;
            });
          }}
          onCancel={(context) => { const active = session.lease.getSnapshot().activeTurn; if (active) void session.lease.interrupt(active.turnId, { source: "side-chat-stop", ...context }).catch(cause => setError(String(cause))); }} />
      </div>} />
  </div>;
}

export function createSideChatPanelPlugin(service: SideChatService, bindings: ConversationBindingStore, resolveRuntime: (hostId: string) => AppServerWorkbenchRuntime | null) {
  function SideChatPanel({ tab }: PanelRendererProps) {
    const session = tab.resource ? service.get(tab.resource) : null;
    const runtime = session ? resolveRuntime(session.key.hostId) : null;
    return session && runtime ? <SideChatContent key={session.id} session={session} service={service} runtime={runtime} />
      : <div className="right-panel-empty" role="status">{tab.title}</div>;
  }
  return Object.assign(function SideChatPanelPlugin(ctx: Context) {
    const removes = [
      ctx.workbenchPanels.register<{ id: string; resource: string; title: string; pending: boolean }>({
        kind: "sidechat",
        restoreTabs: ownerId => {
          const parent = bindings.resolve(ownerId as ConversationScopeId)?.conversationKey;
          return parent ? service.list(parent).map(session => ({ id: `sidechat:${session.key.threadId}`, resource: session.id, kind: "sidechat", region: "right", title: "Side chat", icon: "chat", showTabIcon: true, preview: false, closable: true })) : [];
        },
        createTab: params => ({ id: params.id, resource: params.resource, kind: "sidechat", region: "right", title: params.title, icon: "chat", showTabIcon: true, preview: false, closable: !params.pending }),
        disposeTab: (tab, _owner, reason) => {
          if (!tab.resource) return;
          if (tab.id.startsWith("sidechat-loading:")) { service.cancel(tab.resource); return; }
          // Scope cache eviction is not a user close. Service lifetime owns final cleanup.
          if (reason === "owner-release") return;
          void service.close(tab.resource).catch(error => console.warn("Side chat cleanup failed", error instanceof Error ? error.name : "unknown"));
        },
      }),
      ctx.workbenchPanelRenderers.register({ kind: "sidechat", Component: SideChatPanel }),
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
            if (!pending) { await service.close(id); return; }
            const finalId = `sidechat:${session.key.threadId}`;
            ctx.workbenchPanels.open(context.ownerId, "sidechat", { id: finalId, resource: id, title: "Side chat", pending: false });
            ctx.workbenchPanels.dispatch(context.ownerId, { type: "force-close-tab", region: pending.region, tabId: pendingId });
          } catch (error) {
            const state = ctx.workbenchPanels.getOwnerSnapshot(context.ownerId);
            for (const region of ["right", "bottom"] as const) if (state[region].tabs.some(tab => tab.id === pendingId)) ctx.workbenchPanels.dispatch(context.ownerId, { type: "force-close-tab", region, tabId: pendingId });
            throw error;
          }
        },
      }),
    ];
    ctx.effect(() => () => removes.reverse().forEach(dispose => dispose()));
  }, { inject: ["workbenchPanels", "workbenchPanelRenderers"] });
}
