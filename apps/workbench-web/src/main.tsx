import { startAfterWorkbenchPaint } from "./runtime/optional-feature-startup";
import { serverWorkbenchExtensions } from "./runtime/server-product-extensions";
import "./runtime/web-crypto-compat";
import ReactDOM from "react-dom/client";
import { useEffect, useState } from "react";

import { initializeAppearanceTheme, bindWindowAppearanceProjector } from "./appearance-theme";
import { RuntimeErrorBoundary } from "./components/runtime-error-boundary";
import { HostProfileStorageNotice } from "./components/host-profile-storage-notice";
import { LoadingSpinner } from "./components/ui/loading-spinner";
import { startRuntimeDiagnosticCollection } from "./runtime-diagnostics";
import { reportRuntimeError } from "./runtime-error-reporting";
import { clientProductOptions } from "./runtime/client-product-entry";
import { createClientRuntime } from "./runtime/client-runtime";
import { bindPageLifecycle } from "./runtime/page-lifecycle";
import { bindMobileContainer, mobileContainer } from "./runtime/mobile-container";
import { bindInteractionDensity } from "./runtime/interaction-density";
import {
  openWorkbenchUiPreferences,
  UiPreferencesProvider,
} from "./runtime/ui-preferences-runtime";
import type { UiPreferencesRuntime } from "@opencraft/ui-preferences";
import { WorkbenchLocaleController, WorkbenchIntlProvider } from "./i18n/workbench-locale";
import "./fonts";
import "./styles/app.scss";

type WorkbenchModule = typeof import("./workbench-entry");
type WebWorkbenchApplication = Awaited<ReturnType<WorkbenchModule["a"]>>;

type BootstrapState =
  | { readonly phase: "loading" }
  | {
      readonly phase: "ready";
      readonly module: WorkbenchModule;
      readonly application: WebWorkbenchApplication;
      readonly preferences: UiPreferencesRuntime;
      readonly locale: WorkbenchLocaleController;
    }
  | { readonly phase: "error"; readonly error: Error };

const clientRuntime = createClientRuntime(document);
let releaseAppearanceProjector = () => {};
try {
  clientRuntime.start();
  releaseAppearanceProjector = bindWindowAppearanceProjector(clientRuntime);
  initializeAppearanceTheme();
} catch (error) {
  releaseAppearanceProjector();
  try { clientRuntime.dispose(); } catch (cleanup) { reportRuntimeError(cleanup, "application-disposal"); }
  throw error;
}
startRuntimeDiagnosticCollection();

window.addEventListener("error", (event) => {
  reportRuntimeError(
    event.error ?? event.message,
    "window-error",
    undefined,
    event.filename || undefined,
  );
});

window.addEventListener("unhandledrejection", (event) => {
  reportRuntimeError(event.reason, "unhandled-rejection");
});

const rootElementCandidate = document.getElementById("root");
if (rootElementCandidate == null) throw new Error("Missing #root application mount");
const rootElement: HTMLElement = rootElementCandidate;

function StartupShell() {
  return (
    <main className="startup-shell" role="status" aria-label="正在加载">
      <LoadingSpinner />
    </main>
  );
}

function ApplicationBootstrap() {
  const [state, setState] = useState<BootstrapState>({ phase: "loading" });

  useEffect(() => {
    let disposed = false;
    let application: WebWorkbenchApplication | null = null;
    let preferences: UiPreferencesRuntime | null = null;
    let disposeDensity: (() => void) | undefined;
    let locale: WorkbenchLocaleController | null = null;
    let mobileBinding: ReturnType<typeof bindMobileContainer> | null = null;
    // The query gives the bootstrap boundary its own module identity after a
    // dev-server allowlist or dependency-graph restart. Vite strips it into
    // the normal hashed production chunk; TypeScript does not model Vite
    // resource queries.
    // @ts-expect-error Vite resource query
    void import("./workbench-entry?opencraft-entry=1")
      .then(async (module) => {
        preferences = await openWorkbenchUiPreferences();
        if (!disposed) disposeDensity = bindInteractionDensity(document, preferences);
        locale = new WorkbenchLocaleController(preferences);
        await locale.initialize();
        if (disposed) {
          locale.dispose();
          await preferences.close();
          return;
        }
        const productOptions = await clientProductOptions(import.meta.env, clientRuntime.kind === "electron" ? "electron" : undefined);
        if (disposed) return;
        const created = await module.a({
          ...productOptions,
          ...(mobileContainer() ? { navigationMode: "memory", hostProfileMode: "configured", isPresentationActive: () => mobileBinding?.active() ?? true } : {}),
          serverExtensions: serverWorkbenchExtensions,
          deferOptionalFeatures: true,
        });
        application = created;
        if (disposed) {
          locale.dispose();
          await Promise.all([created.dispose(), preferences.close()]);
          return;
        }
        if (created.supervisor.hostProfileStorageError) {
          reportRuntimeError(created.supervisor.hostProfileStorageError, "host-profile-storage-recovery");
        }
        mobileBinding = bindMobileContainer(created.supervisor.navigation);
        setState({ phase: "ready", module, application: created, preferences, locale });
      })
      .catch((cause) => {
        disposeDensity?.();
        locale?.dispose();
        void preferences?.close().catch(error => reportRuntimeError(error, "application-disposal"));
        if (disposed) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        reportRuntimeError(error, "application-bootstrap");
        setState({ phase: "error", error });
      });
    return () => {
      disposed = true;
      mobileBinding?.dispose();
      locale?.dispose();
      disposeDensity?.();
      if (application !== null) void application.dispose().catch(error => reportRuntimeError(error, "application-disposal"));
      if (preferences !== null) void preferences.close().catch(error => reportRuntimeError(error, "application-disposal"));
    };
  }, []);

  useEffect(() => {
    if (state.phase !== "ready") return;
    const owner = new AbortController();
    const cancel = startAfterWorkbenchPaint(() => state.application.startOptionalFeatures(), owner.signal);
    return () => { owner.abort(); cancel(); };
  }, [state]);

  if (state.phase === "error") throw state.error;
  if (state.phase === "loading") return <StartupShell />;
  const WorkbenchRoot = state.module.b;
  return (
    <UiPreferencesProvider runtime={state.preferences}>
      <WorkbenchIntlProvider controller={state.locale} target={document.documentElement}>
        <WorkbenchRoot application={state.application} />
        {state.application.supervisor.hostProfileStorageError ? <HostProfileStorageNotice /> : null}
      </WorkbenchIntlProvider>
    </UiPreferencesProvider>
  );
}

const reactRoot = ReactDOM.createRoot(rootElement);
const retirePage = bindPageLifecycle(window, () => {
  releaseAppearanceProjector();
  try { clientRuntime.dispose(); } finally { reactRoot.unmount(); }
});
reactRoot.render(
  <RuntimeErrorBoundary>
    <ApplicationBootstrap />
  </RuntimeErrorBoundary>,
);
window.requestAnimationFrame(() => {
  document.getElementById("opencraft-bootstrap")?.remove();
});

if (import.meta.hot !== undefined) {
  import.meta.hot.dispose(() => {
    retirePage();
  });
}
