import React, { type ReactNode } from "react";
import { createRoot, type Container, type RootOptions } from "react-dom/client";
import { MemoryUiPreferenceStore, UiPreferencesRuntime } from "@opencraft/ui-preferences";
import { WorkbenchLocaleController, WorkbenchIntlProvider } from "../../apps/workbench-web/src/i18n/workbench-locale";
import { UiPreferencesProvider } from "../../apps/workbench-web/src/runtime/ui-preferences-runtime";

/** Isolated component fixtures have the same required Intl boundary as the app. */
export function createIntlTestRoot(container: Container, options?: RootOptions) {
  const root = createRoot(container, options);
  let closed = false;
  const ready = UiPreferencesRuntime.open({ installation: new MemoryUiPreferenceStore() }).then(async preferences => {
    const runtime = new WorkbenchLocaleController(preferences, { ideLocale: "en-US" });
    await runtime.initialize();
    return { preferences, runtime };
  });
  return {
    render(children: ReactNode) { void ready.then(({ preferences, runtime }) => {
      if (!closed) root.render(<UiPreferencesProvider runtime={preferences}><WorkbenchIntlProvider controller={runtime} target={document.documentElement}>{children}</WorkbenchIntlProvider></UiPreferencesProvider>);
    }); },
    unmount() { closed = true; root.unmount(); void ready.then(({ preferences, runtime }) => { runtime.dispose(); return preferences.close(); }); },
  };
}
