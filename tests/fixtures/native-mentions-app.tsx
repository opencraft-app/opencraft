import React, { useState, useEffect, useSyncExternalStore } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createDeferredView } from "@opencraft/extension-react";
import { createImExtension } from "/plugins/im/src/index.tsx";
import { createApplicationNavigation } from "/apps/workbench-web/src/runtime/workbench-navigation.ts";
import { bindMobileContainer } from "/apps/workbench-web/src/runtime/mobile-container.ts";
import { createIntlTestRoot } from "/tests/fixtures/intl-root.tsx";
import { AppShell } from "/apps/workbench-web/src/components/app-shell.tsx";
import { AppShellHeader } from "/apps/workbench-web/src/components/app-shell-header.tsx";
import { RouteViewStack } from "/apps/workbench-web/src/components/route-view-stack.tsx";
import {
  AppShellRouteRegionsProvider,
  useAppShellRouteHeader,
  appShellPlatformViewRegions,
} from "/apps/workbench-web/src/components/app-shell-route-regions.tsx";
import { routeStackPresentation } from "/apps/workbench-web/src/components/route-stack-motion.tsx";
import { WorkbenchPresentationRootProvider } from "/apps/workbench-web/src/components/workbench-presentation-root.tsx";
import { useUiPreferencesRuntime } from "/apps/workbench-web/src/runtime/ui-preferences-runtime";
import { bindInteractionDensity } from "/apps/workbench-web/src/runtime/interaction-density";
import { createClientRuntime } from "/apps/workbench-web/src/runtime/client-runtime";
import { initializeAppearanceTheme, setThemePreference } from "/apps/workbench-web/src/appearance-theme.ts";
import "/apps/workbench-web/src/styles/app.scss";
const params = new URLSearchParams(location.search);
initializeAppearanceTheme();
setThemePreference(params.get("theme") || "light");
const inputRuntime = createClientRuntime(document);
inputRuntime.start();
const renderers = new Map(),
  views = new Map(),
  lifetime = new AbortController(),
  noop = () => {},
  _subs = () => () => {};

const groups = [
  {
    id: "group:g",
    title: "Release room",
    kind: "group",
    canSend: true,
    canManageMembers: true,
    mentionUnreadCount: 1,
    firstUnreadMentionSequence: 1,
    unreadCount: 1,
    latestMessage: { text: "Hi @Alice **bold**", at: 1700000000000 },
  },
];
const members = [
  {
    actorId: "alice",
    displayName: "Alice",
    actorKind: "human",
    canWake: false,
  },
  {
    actorId: "bob",
    displayName: "Bob",
    actorKind: "human",
    canWake: false,
    mentionDelivery: "native-only",
  },
  {
    actorId: "bot",
    displayName: "Build Bot",
    actorKind: "session",
    canWake: true,
  },
];
members.push({
  actorId: "quiet",
  displayName: "Quiet Bot",
  actorKind: "session",
  canWake: false,
});
const messages = [
  {
    sequence: 1,
    messageId: "m1",
    author: "Bob",
    sender: { id: "bob", displayName: "Bob", actorKind: "human" },
    text: "Hi\r\n**@Alice** **bold**",
    mentions: [
      {
        actorId: "alice",
        start: 6,
        end: 12,
        displayName: "Alice",
        actorKind: "human",
        isSelf: true,
        isUnread: true,
      },
    ],
    at: 1700000000000,
    status: "received",
  },
];
for (let i = 2; i <= 56; i++)
  messages.push({
    sequence: i,
    messageId: "m" + i,
    author: "Bob",
    sender: { id: "bob", displayName: "Bob", actorKind: "human" },
    text: "Later message " + i,
    at: 1700000000000 + i,
    status: "received",
  });
const subscriptions = new Set<string>();
const sent = [],
  changes = new Set();
window.control = {
  sent,
  reads: 0,
  failSend: false,
  acks: [],
  ackAttempts: 0,
  failAckOnce: true,
};
const rpc = {
  draftScope: "native-mentions",
  supportsRead: true,
  connect: async () => {},
  close: async () => {},
  onChanged: (fn) => {
    changes.add(fn);
    return () => changes.delete(fn);
  },
  onDisconnect: () => () => {},
  request: async (method, p) => {
    if (method === "opencraft/channels/subscribe") {
      subscriptions.add(p.subscriptionId);
      return {};
    }
    if (method === "opencraft/channels/unsubscribe") {
      subscriptions.delete(p.subscriptionId);
      return {};
    }
    if (method === "opencraft/channels/list") return { groups };
    if (method === "opencraft/channels/group/members/list") return { members };
    if (method === "opencraft/channels/people/list") return { people: [], next: null };
    if (method === "opencraft/personal-assistant/get") return { assistant: null, runtime: { phase: "stopped" } };
    if (method === "opencraft/channels/mentions/ack") {
      window.control.ackAttempts++;
      if (window.control.failAckOnce) {
        window.control.failAckOnce = false;
        throw Error("temporary_network_failure");
      }
      window.control.acks.push(p.messageId);
      for (const m of messages)
        if (m.messageId === p.messageId)
          m.mentions?.forEach((n) => {
            if (n.isSelf) n.isUnread = false;
          });
      groups[0].mentionUnreadCount = 0;
      delete groups[0].firstUnreadMentionSequence;
      queueMicrotask(() => subscriptions.forEach((id) => changes.forEach((fn) => fn(id))));
      return { acknowledged: true };
    }
    if (method === "opencraft/channels/messages/around") return { messages: messages.slice(0, 20), hasEarlier: false };
    if (method === "opencraft/channels/sync")
      return {
        kind: "snapshot",
        messages: messages.slice(-50),
        cursor: "snapshot",
        hasEarlier: false,
      };
    if (method === "opencraft/channels/read") {
      window.control.reads++;
      return {};
    }
    if (method === "opencraft/channels/messages/send") {
      if (window.control.failSend) throw Error("channel_mention_unavailable");
      sent.push(p);
      const receipt = {
        sequence: messages.length + 1,
        messageId: p.clientMessageId,
        author: "Alice",
        sender: {
          id: "alice",
          displayName: "Alice",
          actorKind: "human",
          isSelf: true,
        },
        text: p.parts.map((x) => x.text).join(""),
        mentions: p.mentions?.map((m) => ({
          ...m,
          displayName: members.find((x) => x.actorId === m.actorId).displayName,
          actorKind: members.find((x) => x.actorId === m.actorId).actorKind,
          isSelf: m.actorId === "alice",
        })),
        at: Date.now(),
        status: "delivered",
      };
      messages.push(receipt);
      return { receipt };
    }
    throw Error("Unhandled fixture RPC " + method);
  },
};
await createImExtension(
  async () =>
    new Response(JSON.stringify({ nativeChannels: true }), {
      headers: { "content-type": "application/json" },
    }),
  () => rpc,
  true,
).activate({
  signal: lifetime.signal,
  views: { register: (v) => views.set(v.id, v) },
  sidebar: { registerCatalog() {} },
  internal: {
    register: (type, v) => {
      if (type === "platformViewRenderer") {
        const Actual = v.Component;
        renderers.set(
          v.viewType,
          v.viewType === "opencraft.im.channel-chat"
            ? createDeferredView(async () => {
                await new Promise((r) => setTimeout(r, 650));
                return Actual;
              })
            : Actual,
        );
      }
    },
  },
  subscriptions: { add() {} },
  storage: {},
});
const navigation = createApplicationNavigation(null, {
  mode: "browser",
  resolveParentRoute: (route) => {
    const p = route.kind === "extension-view" ? views.get(route.viewId)?.navigationParent : null;
    return p
      ? {
          kind: "extension-view",
          viewId: p.viewId,
          resourceUri: p.resourceUri ?? null,
        }
      : null;
  },
});
window.navigationProbe = navigation;
const query = new QueryClient();
let _bridge;
window.installNativeBridge = () => {
  window.opencraftMobile = { version: 1, runtimeId: "navigation-probe" };
  window.mobileMessages = [];
  window.ReactNativeWebView = {
    postMessage: (raw) => window.mobileMessages.push(JSON.parse(raw)),
  };
  _bridge = bindMobileContainer(navigation);
};
function App() {
  const preferences = useUiPreferencesRuntime();
  useEffect(() => bindInteractionDensity(document, preferences), [preferences]);
  const state = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot),
    route = state.applicationRoute;
  const [open, setOpen] = useState(false);
  window.sidebarProbe = () => open;
  const active = route.kind === "extension-view" ? views.get(route.viewId) : undefined,
    Component = active ? renderers.get(active.viewType) : undefined;
  const host = {
    platform: "web",
    activeHostId: "fixture",
    profiles: [],
    activeView: route.kind === "extension-view" ? route : undefined,
    openView: navigation.openExtensionView,
    provisionHost: async () => {},
    removeHost: async () => false,
    pushViewResource: navigation.pushExtensionViewResource,
    replaceViewResource: navigation.replaceExtensionViewResource,
  };
  const routeHeader = useAppShellRouteHeader(state.routeScopeId);
  const returning = state.canReturn === true,
    back = returning ? navigation.returnToParent : navigation.back;
  return (
    <QueryClientProvider client={query}>
      <AppShellRouteRegionsProvider controller={routeHeader.controller} target={routeHeader.target}>
        <AppShell
          routeStack={routeStackPresentation(state, "synthetic-account")}
          navigation={{
            layout: "unified",
            account: {
              snapshot: {
                phase: "authenticated",
                name: "Synthetic employee",
                avatarUrl: null,
              },
              onOpen: noop,
              onRefresh: async () => {},
            },
            actions: [
              {
                id: "inbox",
                title: "Inbox",
                icon: "messages",
                onInvoke: () => navigation.openExtensionView("opencraft.im.people"),
              },
            ],
            onOpenSettings: () => navigation.openSettings(),
          }}
          navigationReturn={
            returning
              ? {
                  key: state.navigationPath.at(-1).historyKey ?? state.url,
                  invoke: navigation.returnToParent,
                }
              : undefined
          }
          layoutScope="nav-probe"
          mainContentLayout="default"
          windowChrome={{
            kind: "browser",
            platform: "linux",
            safeArea: { left: 0, right: 0 },
          }}
          sidebarOpen={open}
          sidebarWidth={335}
          onSidebarCollapse={() => setOpen(false)}
          onSidebarExpand={() => setOpen(true)}
          onSidebarResizeEnd={noop}
          rightPanel={null}
          rightPanelOpen={false}
          rightPanelFullWidth={false}
          onRightPanelOpenChange={noop}
          header={
            <AppShellHeader
              routeHeaderActive={routeHeader.active}
              routeHeaderHostRef={routeHeader.hostRef}
              title={active?.title ?? "Navigation"}
              project={null}
              sidebarOpen={open}
              rightPanelOpen={false}
              rightPanelFullWidth={false}
              showRightPanelAction={false}
              onToggleSidebar={() => setOpen((v) => !v)}
              onToggleRightPanel={noop}
              onHome={() => navigation.openChat()}
              canReturn={returning}
              canGoBack={returning || state.canGoBack}
              canGoForward={state.canGoForward}
              onBack={back}
              onForward={navigation.forward}
              navigationActions={["sidebar-toggle"]}
            />
          }
          floatingSidebarHeader={() => null}
          leftPanel={
            <button
              onClick={() => {
                setOpen(false);
                navigation.openExtensionView("opencraft.im.people");
              }}
            >
              Inbox destination
            </button>
          }
        >
          {Component ? (
            <RouteViewStack navigation={state}>
              <Component
                activation={{
                  viewId: active.id,
                  resourceUri: route.resourceUri,
                }}
                contribution={active}
                host={host}
                regions={appShellPlatformViewRegions}
              />
            </RouteViewStack>
          ) : (
            <div style={{ padding: 24 }}>
              <button onClick={() => navigation.openExtensionView("opencraft.im.people")}>Open Inbox</button>
            </div>
          )}
          <dialog id="gesture-dialog">
            <p>Modal owns this gesture</p>
            <button onClick={() => document.getElementById("gesture-dialog").close()}>Close modal</button>
          </dialog>
        </AppShell>
      </AppShellRouteRegionsProvider>
    </QueryClientProvider>
  );
}
const target = document.getElementById("root");
createIntlTestRoot(target, undefined, "en-US").render(
  <WorkbenchPresentationRootProvider target={target}>
    <App />
  </WorkbenchPresentationRootProvider>,
);
