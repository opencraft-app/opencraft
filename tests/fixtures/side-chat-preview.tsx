import { WorkbenchComposerProvider } from "../../apps/workbench-web/src/components/workbench-composer";
import { ComposerActionRendererRegistry } from "@opencraft/extension-react";
import React, { useEffect } from "react";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline } from "@opencraft/chat-core";
import { createComposerController, composerDocumentToPlainText } from "@opencraft/composer-core";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { createSideChatPanelPlugin } from "../../apps/workbench-web/src/panels/side-chat-panel-plugin";
import { WorkbenchPanelRendererRegistryService } from "@opencraft/workbench-panels-react";

export async function installSideChatPreviewFixture(ctx: any) {
  await ctx.plugin(WorkbenchPanelRendererRegistryService);
  await ctx.plugin(TimelineBlockRendererRegistryService);
  await ctx.plugin(BuiltinTimelineRendererPlugin);
  const key = createConversationKey("fixture", "side-preview");
  const composer = createComposerController(
    { type: "existing-thread", key },
    { now: Date.now, createId: () => crypto.randomUUID() },
  );
  composer.dispatch({
    type: "set-document",
    document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "Keep side draft" }] }] },
  });
  const registry = createDefaultTimelineProjectorRegistry();
  const listeners = new Set<() => void>();
  let count = 5,
    mounts = 0,
    unmounts = 0,
    historyReads = 0,
    submits = 0;
  const snapshot = () => ({
    timeline: projectTimeline(
      {
        key,
        revision: count,
        authoritative: true,
        phase: "live",
        turns: Array.from({ length: count }, (_, i) => ({
          id: "side-turn-" + i,
          status: "completed" as const,
          items: [
            {
              id: "prompt-" + i,
              type: "userMessage" as const,
              payload: { content: [{ type: "inputText", text: "Side question " + i }] },
            },
            {
              id: "reply-" + i,
              type: "agentMessage" as const,
              payload: {
                text:
                  "**Side answer " +
                  i +
                  "**\n\n" +
                  "Original conversation paragraph. ".repeat(10) +
                  "\n\n```ts\nconst side = " +
                  i +
                  ";\n```\n\nVisible tail " +
                  i,
                phase: "final_answer",
                completed: true,
              },
            },
          ],
        })),
      },
      registry,
    ),
    error: null,
    activeTurn: null,
    authoritative: true,
    execution: { cwd: "/fixture", model: null, effort: null, serviceTier: null, permissionProfile: null },
    history: { hasOlder: true, loading: false },
    pendingInteractions: [],
  });
  let current = snapshot();
  const session = {
    id: "side-preview",
    key,
    parent: createConversationKey("fixture", "parent"),
    composer,
    lease: {
      subscribe(f: () => void) {
        listeners.add(f);
        return () => listeners.delete(f);
      },
      getSnapshot: () => current,
      loadItemDetails: async () => {},
      loadOlder: async () => {
        historyReads++;
        return "stop";
      },
    },
  };
  const service: any = {
    records: () => [],
    subscribe: () => () => {},
    getRevision: () => 0,
    getRecoveryError: () => null,
    getCreationError: () => null,
    pendingIds: () => [],
    get: (id: string) => (id === session.id ? session : null),
    list: () => [],
    close: async () => {},
    cancel() {},
    submit: async () => {
      submits++;
    },
  };
  await ctx.plugin(
    createSideChatPanelPlugin(
      service,
      { resolve: () => null, subscribe: () => () => {} } as any,
      () => ({ resources: { composerCatalog: { listModels: async () => ({ data: [] }) } } }) as any,
    ),
  );
  const registration = ctx.workbenchPanelRenderers.getSnapshot().find((r: any) => r.kind === "sidechat");
  const Component = registration.Component,
    query = new QueryClient();
  const composerEnvironment = {
    navigationEnabled: true,
    actionIds: [],
    registry: new ComposerActionRendererRegistry(),
    platform: "web" as const,
  };
  const probe = {
    inspect: () => ({
      mounts,
      unmounts,
      historyReads,
      submits,
      subscriptions: listeners.size,
      draft: composerDocumentToPlainText(composer.getSnapshot().draft.document),
    }),
    append() {
      count++;
      current = snapshot();
      for (const f of listeners) f();
    },
  };
  Object.assign(window, { sidePreview: probe });
  function SideChatFixture(props: any) {
    useEffect(() => {
      mounts++;
      return () => {
        unmounts++;
      };
    }, []);
    return (
      <QueryClientProvider client={query}>
        <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
          <WorkbenchComposerProvider value={composerEnvironment}>
            <Component {...props} />
          </WorkbenchComposerProvider>
        </TimelineBlockRendererProvider>
      </QueryClientProvider>
    );
  }
  return { ...registration, Component: SideChatFixture };
}
