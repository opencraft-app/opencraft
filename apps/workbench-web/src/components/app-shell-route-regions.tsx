import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createDeferredView, type PlatformViewRegions, type PlatformViewHost } from "@opencraft/extension-react";

// Registration is part of the Shell; management presentation loads on entry.
const WorkbenchConnectorLibrary = createDeferredView(async () =>
  (await import("./connectors/connector-library")).WorkbenchConnectorLibrary);
const ExtensionLibrary = createDeferredView(async () =>
  (await import("./extensions/extension-library")).ExtensionLibrary);
import { useAppServerHosts } from "../runtime/appserver-runtime-context";
import { useOptionalAsyncNotices } from "./async-notices";
import { createPortal } from "react-dom";

import { ComposerExtensionActions } from "../runtime/composer-action-renderers";
import type { ComponentProps } from "react";

import { AppShellToolbarSelect } from "./app-shell-toolbar-select";
import { AppShellNestedNavigation } from "./app-shell-nested-navigation";
import { AppShellMasterDetailRegion } from "./app-shell-master-detail";

interface RouteHeaderEntry {
  readonly owner: symbol;
  readonly scopeKey: string;
  readonly suppressReturn: boolean;
}

export interface AppShellRouteHeaderController {
  register(owner: symbol, suppressReturn?: boolean): () => void;
}

interface AppShellRouteHeaderContextValue {
  readonly controller: AppShellRouteHeaderController;
  readonly target: HTMLElement | null;
}

const AppShellRouteHeaderContext = createContext<AppShellRouteHeaderContextValue | null>(null);

export function useAppShellRouteHeader(scopeKey: string): {
  readonly active: boolean;
  readonly suppressReturn: boolean;
  readonly controller: AppShellRouteHeaderController;
  readonly hostRef: (element: HTMLDivElement | null) => void;
  readonly target: HTMLElement | null;
} {
  const [entry, setEntry] = useState<RouteHeaderEntry | null>(null);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const controller = useMemo<AppShellRouteHeaderController>(() => ({
    register(owner, suppressReturn = false) {
      setEntry({ owner, scopeKey, suppressReturn });
      return () => {
        setEntry((current) => (
          current?.scopeKey === scopeKey && current.owner === owner ? null : current
        ));
      };
    },
  }), [scopeKey]);
  const hostRef = useCallback((element: HTMLDivElement | null) => {
    setTarget(element);
  }, []);

  return {
    active: entry?.scopeKey === scopeKey,
    suppressReturn: entry?.scopeKey === scopeKey && entry.suppressReturn,
    controller,
    hostRef,
    target,
  };
}

export function AppShellRouteRegionsProvider({
  children,
  controller,
  target,
}: {
  readonly children: ReactNode;
  readonly controller: AppShellRouteHeaderController;
  readonly target: HTMLElement | null;
}) {
  const value = useMemo<AppShellRouteHeaderContextValue>(
    () => ({ controller, target }),
    [controller, target],
  );
  return (
    <AppShellRouteHeaderContext.Provider value={value}>
      {children}
    </AppShellRouteHeaderContext.Provider>
  );
}

/** Registers route-owned toolbar content into the persistent AppShell Header. */
export function AppShellRouteHeaderRegion({ children, suppressReturn = false }: { readonly children: ReactNode; readonly suppressReturn?: boolean }) {
  const context = useContext(AppShellRouteHeaderContext);
  const owner = useRef(Symbol("app-shell-route-header"));
  useLayoutEffect(() => {
    if (context === null) return;
    return context.controller.register(owner.current, suppressReturn);
  }, [context, suppressReturn]);
  if (context === null || context.target === null) return null;
  return createPortal(children, context.target);
}

function WorkbenchExtensionLibrary({ host }: { host?: PlatformViewHost }) {
  const { extensionRuntime, extensionManager, platformViewRenderers } = useAppServerHosts();
  const notices = useOptionalAsyncNotices();
  return <ExtensionLibrary supervisor={extensionRuntime} manager={extensionManager} settingsHost={host} renderers={platformViewRenderers} reportError={notices?.error} />;
}

/** Hostless and connected Shells supply the same capability owner explicitly. */
export function useAppShellViewRegions(registry: ComponentProps<typeof ComposerExtensionActions>["registry"], actionIds: ComponentProps<typeof ComposerExtensionActions>["actionIds"] = "all", settingsHost?: PlatformViewHost) {
  const settingsHostRef = useRef(settingsHost);
  settingsHostRef.current = settingsHost;
  return useMemo<PlatformViewRegions>(() => ({ ...appShellPlatformViewRegions,
    ExtensionLibrary: () => <WorkbenchExtensionLibrary host={settingsHostRef.current} />,
    ComposerActions: props => <ComposerExtensionActions {...props} actionIds={actionIds} registry={registry} />,
  }), [registry, actionIds]);
}

export const appShellPlatformViewRegions: PlatformViewRegions = Object.freeze({
  Header: AppShellRouteHeaderRegion,
  MasterDetail: AppShellMasterDetailRegion,
  NavigationStack: AppShellNestedNavigation,
  ToolbarSelect: AppShellToolbarSelect,
  ConnectorLibrary: WorkbenchConnectorLibrary,
  ExtensionLibrary: WorkbenchExtensionLibrary,
});
