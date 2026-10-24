import { serverStorageKey } from "./server-context";
import { createContext, useContext, type ReactNode } from "react";
import { UiPreferencesRuntime } from "@opencraft/ui-preferences";

import { workbenchProductId } from "../workbench-product";
import { DesktopUiPreferenceStore, desktopUiPreferencesPort } from "./desktop-ui-preference-store";
import { IndexedDbUiPreferenceStore } from "./indexeddb-ui-preference-store";

const UiPreferencesContext = createContext<UiPreferencesRuntime | null>(null);
const LEGACY_NAVIGATION_KEY = "opencraft.shell-navigation.v2";
const LEGACY_WIDTH_KEY = "opencraft.shell-navigation.width.v3";
const LEGACY_CONTEXT_SIDEBAR_WIDTH_KEY = "sidebar-width";

interface LegacyNavigationPreferences {
  readonly account?: unknown;
  readonly railDetent?: unknown;
  readonly lastVisibleRailDetent?: unknown;
}

async function migrateLegacyShellPreferences(
  runtime: UiPreferencesRuntime,
  storage: Pick<Storage, "getItem" | "removeItem">,
): Promise<void> {
  const navigationText = storage.getItem(LEGACY_NAVIGATION_KEY);
  const widthText = storage.getItem(LEGACY_WIDTH_KEY);
  const contextSidebarWidthText = storage.getItem(LEGACY_CONTEXT_SIDEBAR_WIDTH_KEY);
  if (navigationText === null && widthText === null && contextSidebarWidthText === null) return;

  let navigation: LegacyNavigationPreferences | null = null;
  try {
    const candidate: unknown = navigationText === null ? null : JSON.parse(navigationText);
    if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
      navigation = candidate as LegacyNavigationPreferences;
    }
  } catch { /* Invalid legacy state is discarded. */ }

  const writes: Promise<void>[] = [];
  // applications=true was the old product default and cannot prove user intent.
  // The new contract deliberately starts unpinned.
  if (runtime.storedRevision("shell.accountPinned") === 0 && typeof navigation?.account === "boolean") {
    writes.push(runtime.set("shell.accountPinned", navigation.account));
  }
  if (
    runtime.storedRevision("shell.navigationDetent") === 0
    && (navigation?.railDetent === "expanded" || navigation?.railDetent === "compact" || navigation?.railDetent === "hidden")
  ) {
    writes.push(runtime.set("shell.navigationDetent", navigation.railDetent));
  }
  if (
    runtime.storedRevision("shell.lastVisibleNavigationDetent") === 0
    && (navigation?.lastVisibleRailDetent === "expanded" || navigation?.lastVisibleRailDetent === "compact")
  ) {
    writes.push(runtime.set("shell.lastVisibleNavigationDetent", navigation.lastVisibleRailDetent));
  }
  if (runtime.storedRevision("shell.navigationWidth") === 0 && widthText !== null) {
    try {
      const width: unknown = JSON.parse(widthText);
      if (typeof width === "number" && Number.isFinite(width)) {
        writes.push(runtime.set("shell.navigationWidth", width));
      }
    } catch { /* Invalid legacy width is discarded. */ }
  }
  if (runtime.storedRevision("shell.contextSidebarWidth") === 0 && contextSidebarWidthText !== null) {
    const width = Number.parseFloat(contextSidebarWidthText);
    if (Number.isFinite(width)) writes.push(runtime.set("shell.contextSidebarWidth", width));
  }
  await Promise.all(writes);
  storage.removeItem(LEGACY_NAVIGATION_KEY);
  storage.removeItem(LEGACY_WIDTH_KEY);
  storage.removeItem(LEGACY_CONTEXT_SIDEBAR_WIDTH_KEY);
}

export async function openWorkbenchUiPreferences(options: {
  readonly presentation?: "standalone" | "embedded";
  readonly factory?: IDBFactory;
  readonly storage?: Pick<Storage, "getItem" | "removeItem">;
  readonly createChannel?: (name: string) => BroadcastChannel;
} = {}): Promise<UiPreferencesRuntime> {
  const databaseName = workbenchProductId === "opencraft"
    ? "opencraft-ui-preferences"
    : `opencraft-ui-preferences-${workbenchProductId}`;
  const desktopPort = desktopUiPreferencesPort();
  const installation = desktopPort === null
    ? await IndexedDbUiPreferenceStore.open({
      databaseName: serverStorageKey(databaseName),
      ...(options.factory === undefined ? {} : { factory: options.factory }),
      ...(options.createChannel === undefined ? {} : { createChannel: options.createChannel }),
    })
    : new DesktopUiPreferenceStore(desktopPort);
  const runtime = await UiPreferencesRuntime.open({ installation }, {
    defaults: { "chat.touchNewera": options.presentation !== "embedded" },
  });
  await migrateLegacyShellPreferences(runtime, options.storage ?? window.localStorage);
  return runtime;
}

export function UiPreferencesProvider({ runtime, children }: {
  readonly runtime: UiPreferencesRuntime;
  readonly children: ReactNode;
}) {
  return <UiPreferencesContext.Provider value={runtime}>{children}</UiPreferencesContext.Provider>;
}

export function useUiPreferencesRuntime(): UiPreferencesRuntime {
  const runtime = useContext(UiPreferencesContext);
  if (runtime === null) throw new Error("UI preferences runtime is unavailable");
  return runtime;
}
