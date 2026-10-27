import { AsyncNoticesProvider } from "../../apps/workbench-web/src/components/async-notices";
import React, { type ReactNode } from "react";
import { createRoot, type Container, type RootOptions } from "react-dom/client";
import { MemoryUiPreferenceStore, UiPreferencesRuntime } from "@opencraft/ui-preferences";
import type { LocaleCatalog } from "@opencraft/i18n";
import { WorkbenchLocaleController, WorkbenchIntlProvider } from "../../apps/workbench-web/src/i18n/workbench-locale";
import { localeCatalogs } from "../../apps/workbench-web/src/i18n/catalogs";
import { UiPreferencesProvider } from "../../apps/workbench-web/src/runtime/ui-preferences-runtime";

/** Isolated component fixtures have the same required Intl boundary as the app. */
export function createIntlTestRoot(container: Container, options?: RootOptions, locale = "en-US", catalogs: readonly LocaleCatalog[] = localeCatalogs) {
  const root = createRoot(container, options);
  let closed = false;
  const ready = UiPreferencesRuntime.open({ installation: new MemoryUiPreferenceStore() }).then(async preferences => {
    const runtime = new WorkbenchLocaleController(preferences, { ideLocale: locale }, catalogs);
    await runtime.initialize();
    return { preferences, runtime };
  });
  return {
    render(children: ReactNode) { void ready.then(({ preferences, runtime }) => {
      if (!closed) root.render(<UiPreferencesProvider runtime={preferences}><WorkbenchIntlProvider controller={runtime} target={document.documentElement}><AsyncNoticesProvider>{children}</AsyncNoticesProvider></WorkbenchIntlProvider></UiPreferencesProvider>);
    }); },
    unmount() { closed = true; root.unmount(); void ready.then(({ preferences, runtime }) => { runtime.dispose(); return preferences.close(); }); },
  };
}
