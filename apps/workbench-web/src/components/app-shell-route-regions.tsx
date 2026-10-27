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
import type { PlatformViewRegions } from "@opencraft/extension-react";
import { WorkbenchConnectorLibrary } from "./connectors/connector-library";
import { ExtensionLibrary } from "./extensions/extension-library";
import { useAppServerHosts } from "../runtime/appserver-runtime-context";
import { createPortal } from "react-dom";

import { AppShellToolbarSelect } from "./app-shell-toolbar-select";

interface RouteHeaderEntry {
  readonly owner: symbol;
  readonly scopeKey: string;
}

export interface AppShellRouteHeaderController {
  register(owner: symbol): () => void;
}

interface AppShellRouteHeaderContextValue {
  readonly controller: AppShellRouteHeaderController;
  readonly target: HTMLElement | null;
}

const AppShellRouteHeaderContext = createContext<AppShellRouteHeaderContextValue | null>(null);

export function useAppShellRouteHeader(scopeKey: string): {
  readonly active: boolean;
  readonly controller: AppShellRouteHeaderController;
  readonly hostRef: (element: HTMLDivElement | null) => void;
  readonly target: HTMLElement | null;
} {
  const [entry, setEntry] = useState<RouteHeaderEntry | null>(null);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const controller = useMemo<AppShellRouteHeaderController>(() => ({
    register(owner) {
      setEntry({ owner, scopeKey });
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
export function AppShellRouteHeaderRegion({ children }: { readonly children: ReactNode }) {
  const context = useContext(AppShellRouteHeaderContext);
  const owner = useRef(Symbol("app-shell-route-header"));
  useLayoutEffect(() => {
    if (context === null) return;
    return context.controller.register(owner.current);
  }, [context]);
  if (context === null || context.target === null) return null;
  return createPortal(children, context.target);
}

function WorkbenchExtensionLibrary() {
  const { extensionRuntime, extensionManager } = useAppServerHosts();
  return <ExtensionLibrary supervisor={extensionRuntime} manager={extensionManager} />;
}

export const appShellPlatformViewRegions: PlatformViewRegions = Object.freeze({
  Header: AppShellRouteHeaderRegion,
  ToolbarSelect: AppShellToolbarSelect,
  ConnectorLibrary: WorkbenchConnectorLibrary,
  ExtensionLibrary: WorkbenchExtensionLibrary,
});
