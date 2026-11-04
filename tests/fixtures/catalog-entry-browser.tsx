import React, { useState } from "react";
import { QueryClient, QueryClientProvider, useQueries } from "@tanstack/react-query";
import { createIntlTestRoot } from "./intl-root";
import { Sidebar } from "../../apps/workbench-web/src/components/sidebar";
import { useHostThreadCatalogQueries } from "../../apps/workbench-web/src/runtime/use-host-thread-catalog-queries";
import { bindThreadCatalogNotifications } from "../../apps/workbench-web/src/runtime/thread-catalog-notifications";
import { readHostThreadCatalog } from "../../apps/workbench-web/src/runtime/host-thread-catalog";
import { sidebarThreadCatalogQueryKey, threadCatalogPhase } from "../../apps/workbench-web/src/runtime/thread-catalog-query";
import { projectAppServerThread, legacyDirectServerProjectionFromHost } from "@opencraft/workbench-runtime";
import { SidebarLayoutStore } from "@opencraft/sidebar-layout";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";
import { ClientResources } from "@opencraft/document-storage/client-resources";
import { openIndexedDbClientResources } from "../../apps/workbench-web/src/runtime/indexeddb-client-resources";
import { catalogReplicaResource, restoreCatalogReplica, saveCatalogReplica } from "../../apps/workbench-web/src/runtime/thread-catalog-replica-cache";
const params = new URL(location.href).searchParams;
initializeAppearanceTheme(); setThemePreference(params.get("theme") === "dark" ? "dark" : "light");
const layout = await SidebarLayoutStore.open({ load: async () => null, save: async () => {} });
const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 5, refetchOnWindowFocus: false } } });
let notify: (notification: any) => void = () => {};
const initialization = { capabilities: { extensions: params.has("versioned") ? {
  "opencraft/thread-directory-snapshots": { version: 1 }, "opencraft/thread-directory-updates": { version: 1 },
} : {} } };
bindThreadCatalogNotifications({ initializeResult: initialization as any, subscribeNotification: listener => { notify = listener; return () => {}; } }, "fixture", client);
const profile = { hostId: "fixture", hostKind: "local", enabled: true, includeInSidebar: true, autoConnect: true, revision: 1 } as any;
let current = profile;
let phase = "ready";
const calls: unknown[] = [];
if (params.has("merkle")) Object.assign(initialization.capabilities.extensions, { "opencraft/thread-directory-merkle": { version: 1 } });
const replicaOwner = params.has("merkle") ? new ClientResources(openIndexedDbClientResources("catalog-merkle-browser", indexedDB), "fixture/account") : null;
const replicaParts = replicaOwner ? Array.from({ length: 8 }, (_, part) => replicaOwner.remote(catalogReplicaResource, `fixture:${part}`)) : [];
let persisted = Promise.resolve();
const runtime = { getSnapshot: () => ({ phase }), resources: { host: { getInitializeResult: () => initialization }, threads: { async list(options: unknown) {
  calls.push(options);
  const response = await fetch('/catalog-page?' + new URLSearchParams({ scenario: params.get('scenario') ?? 'success', host: 'fixture' }), { method: 'POST', body: JSON.stringify(options) });
  if (!response.ok) throw Object.assign(new Error('Catalog unavailable'), { status: response.status });
  const value = await response.json();
  if (value.error) throw Object.assign(new Error(value.error.message), { code: value.error.code });
  return value;
} } } } as any;
const registry = { peekRuntime: () => runtime, ensureConnected: async () => runtime } as any;
function useLegacy(inputs: any[]) { return useQueries({ queries: inputs.map(input => ({ queryKey: input.queryKey, enabled: input.enabled, queryFn: () => readHostThreadCatalog(input), staleTime: 30_000 })) }); }
const useCatalog = params.get('legacy') === '1' ? useLegacy : useHostThreadCatalogQueries;
const started = performance.now();
const observations: any[] = [];
const actions: string[] = [];
const metrics: { firstPaintMs?: number; completePaintMs?: number } = {};
function App() {
  const [revision, setRevision] = useState(1);
  const [enabled, setEnabled] = useState(true);
  const key = sidebarThreadCatalogQueryKey('fixture', { revision, authorizationEpoch: null });
  const [query] = useCatalog([{ profile: { ...profile, revision }, currentProfile: () => current, management: null, registry, enabled, queryKey: key,
    loadRecoveryBase: async () => { await Promise.all(replicaParts.map(r => r.ready)); return restoreCatalogReplica(replicaParts); } }]);
  React.useEffect(() => {
    const data = query!.data as any;
    if (replicaParts.length && query!.isSuccess && !query!.isFetching && !query!.hasNextPage && data?.__opencraftCatalogRawRows) {
      persisted = saveCatalogReplica(replicaParts, { ...data, data: data.__opencraftCatalogRawRows }, { isCurrent: () => enabled && current.enabled });
    }
  }, [query!.data, query!.isFetching, query!.hasNextPage]);
  const rows = enabled ? query!.data?.data ?? [] : [];
  const threads = rows.map((thread: any) => ({ ...projectAppServerThread(thread), ...legacyDirectServerProjectionFromHost({ hostId: 'fixture', hostKind: 'local', label: 'Fixture' }), connectionHostId: 'fixture', connectionHostLabel: 'Fixture', interactionAvailable: enabled && phase === 'ready' }));
  const catalog = { hostId: 'fixture', label: 'Fixture', phase: threadCatalogPhase({ admitted: enabled, status: query!.status, isFetching: query!.isFetching, partial: "hasNextPage" in query! ? query!.hasNextPage : query!.isPlaceholderData }), partial: "hasNextPage" in query! ? query!.hasNextPage : query!.isPlaceholderData };
  observations.push({ ms: performance.now() - started, rows: rows.length, status: query!.status, fetching: query!.isFetching, partial: "hasNextPage" in query! ? query!.hasNextPage : query!.isPlaceholderData, cached: client.getQueryData(key) !== undefined, revision, enabled });
  React.useLayoutEffect(() => {
    if (!rows.length) return;
    const complete = !query!.isFetching && !("hasNextPage" in query! ? query!.hasNextPage : query!.isPlaceholderData) && query!.status === 'success';
    requestAnimationFrame(() => {
      metrics.firstPaintMs ??= performance.now() - started;
      if (complete) metrics.completePaintMs ??= performance.now() - started;
    });
  }, [rows.length, query!.isFetching, query!.isPlaceholderData, query!.status]);
  (window as any).catalogEntry = { observations, calls, actions, started, metrics, snapshot: () => observations.at(-1),
    persisted: () => persisted,
    replica: () => replicaParts.map(r => ({ rows: r.getSnapshot().value?.rows.length, error: String(r.getSnapshot().error), loading: r.getSnapshot().loading })),
    event: notify, displayed: () => rows,
    notify: () => notify({ method: "turn/started", params: { threadId: "t0" } }),
    refresh: () => client.invalidateQueries({ queryKey: key }),
    cached: () => { const value = client.getQueryData<any>(key); return value?.pages ? { ...value.pages[0], data: [...new Map(value.pages.flatMap((page: any) => page.data).map((row: any) => [row.id, row])).values()] } : value; },
    revoke: () => { current = { ...current, enabled: false }; setEnabled(false); },
    replace: () => { current = { ...profile, revision: revision + 1 }; setRevision(revision + 1); },
    disconnect: () => { phase = 'reconnecting'; setEnabled(false); },
  };
  return <div style={{ width: 320, height: '100vh', display: 'flex' }}><Sidebar threads={threads} activeHostId="fixture" activeThreadId=""
    sidebarLayout={layout} threadCatalogs={[catalog]} showFooter={false}
    onRetryThreadCatalog={() => { void client.refetchQueries({ queryKey: key }); }}
    onSelectThread={(_, id) => actions.push(id)} onNewTask={() => {}} onOpenSettings={() => {}} /></div>;
}
createIntlTestRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
