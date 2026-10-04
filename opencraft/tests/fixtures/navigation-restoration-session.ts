import {
  HostRuntimeRegistry, asRouteScopeId, createWorkbenchCoordinator, createWorkbenchDraftLocation,
  createConversationBindingStore, createConversationScopeLeaseRegistry,
  createConversationScopeRegistry, createConversationViewRegistry,
  createConversationActivationCoordinator, type WorkbenchLocation,
} from "../../packages/workbench-runtime/src/index";
import { createRouteScopeId, type ApplicationRouterOptions } from "../../apps/workbench-web/src/runtime/workbench-navigation";
import { createWorkbenchNavigationTransaction } from "../../apps/workbench-web/src/runtime/workbench-navigation-transaction";
import { createWorkbenchEntryResolver } from "../../apps/workbench-web/src/runtime/workbench-location-restoration";

/** Actual route/resource owners; only physical Host readiness is substituted. */
export function createNavigationRestorationSession(options: {
  initialThread?: WorkbenchLocation;
  connect?: () => Promise<void>;
  router?: ApplicationRouterOptions;
} = {}) {
  let connectCalls = 0;
  const runtime = {
    async connect() { connectCalls++; await options.connect?.(); },
    async dispose() {},
    async acquireThread(threadId: string) { return { threadId, release() {} }; },
  };
  const registry = new HostRuntimeRegistry([{ descriptor: {
    hostId: "local", label: "Fixture", kind: "local", transportEndpoint: null,
    executionLocation: null, workspaceBrowseRoots: [],
  }, createRuntime: () => runtime }]);
  const scopes = createConversationScopeRegistry({ initialDraft: options.initialThread ? null : {
    execution: { hostId: "local", workspace: { cwd: null, runtimeWorkspaceRoots: [] } },
  } });
  const draft = scopes.getActiveDraft();
  const initial = options.initialThread ?? createWorkbenchDraftLocation("local", draft!.id);
  const coordinator = createWorkbenchCoordinator(registry, initial);
  const bindings = createConversationBindingStore();
  const leases = createConversationScopeLeaseRegistry({});
  const views = createConversationViewRegistry({ scopeLeases: leases,
    composerServices: { now: Date.now, createId: () => crypto.randomUUID() } });
  const activation = createConversationActivationCoordinator(coordinator, bindings, scopes, leases, views);
  const resolveRestoredEntry = createWorkbenchEntryResolver({ hasHost: id => registry.has(id), bindings, scopes, views,
    fallback: () => ({ location: coordinator.getSnapshot().location,
      routeScopeId: coordinator.getSnapshot().viewId === null ? createRouteScopeId() : asRouteScopeId(coordinator.getSnapshot().viewId!) }) });
  const navigation = createWorkbenchNavigationTransaction(initial, activation, scopes,
    { mode: "memory", ...options.router, resolveRestoredEntry });
  activation.mountInitial(initial, navigation.getSnapshot().routeScopeId);
  return { navigation, initial, scopes, bindings, views, activation, coordinator, resolveRestoredEntry,
    get connectCalls() { return connectCalls; },
    async dispose() {
      navigation.dispose(); activation.dispose(); views.dispose(); leases.dispose();
      coordinator.dispose(); scopes.dispose(); bindings.dispose(); await registry.dispose();
    },
  };
}
