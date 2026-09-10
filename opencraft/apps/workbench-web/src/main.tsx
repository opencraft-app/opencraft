import ReactDOM from "react-dom/client";
import { useEffect, useState } from "react";

import { initializeAppearanceTheme } from "./appearance-theme";
import { RuntimeErrorBoundary } from "./components/runtime-error-boundary";
import { reportRuntimeError } from "./runtime-error-reporting";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "./styles/app.scss";

type WorkbenchModule = typeof import("./workbench-entry");
type WebWorkbenchApplication = Awaited<ReturnType<WorkbenchModule["a"]>>;

interface DesktopWindowBridge {
  readonly getWindowFullscreen?: () => boolean;
  readonly onWindowFullscreenChanged?: (
    listener: (isFullScreen: boolean) => void,
  ) => () => void;
  readonly setWindowAppearance?: (appearance: {
    readonly themeSource: "system" | "light" | "dark";
    readonly resolvedTheme: "light" | "dark";
  }) => void;
}

type BootstrapState =
  | { readonly phase: "loading" }
  | {
      readonly phase: "ready";
      readonly module: WorkbenchModule;
      readonly application: WebWorkbenchApplication;
    }
  | { readonly phase: "error"; readonly error: Error };

initializeAppearanceTheme();

const desktopWindowBridge = (
  globalThis as typeof globalThis & { readonly opencraftDesktop?: DesktopWindowBridge }
).opencraftDesktop;
const applyDesktopFullscreen = (isFullScreen: boolean) => {
  document.documentElement.dataset.opencraftWindowFullscreen = String(isFullScreen);
};
const disposeDesktopFullscreenSubscription = desktopWindowBridge?.onWindowFullscreenChanged?.(
  applyDesktopFullscreen,
);
// Subscribe before reading the synchronous snapshot so an enter/leave event
// cannot fall into the bootstrap gap between the initial read and listener.
applyDesktopFullscreen(desktopWindowBridge?.getWindowFullscreen?.() ?? false);

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
      <i className="startup-shell__spinner" aria-hidden="true" />
    </main>
  );
}

function ApplicationBootstrap() {
  const [state, setState] = useState<BootstrapState>({ phase: "loading" });

  useEffect(() => {
    let disposed = false;
    let application: WebWorkbenchApplication | null = null;
    // The query gives the bootstrap boundary its own module identity after a
    // dev-server allowlist or dependency-graph restart. Vite strips it into
    // the normal hashed production chunk; TypeScript does not model Vite
    // resource queries.
    // @ts-expect-error Vite resource query
    void import("./workbench-entry?opencraft-entry=1")
      .then(async (module) => {
        const created = await module.a();
        application = created;
        if (disposed) {
          await created.dispose();
          return;
        }
        setState({ phase: "ready", module, application: created });
      })
      .catch((cause) => {
        if (disposed) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        reportRuntimeError(error, "application-bootstrap");
        setState({ phase: "error", error });
      });
    return () => {
      disposed = true;
      if (application !== null) void application.dispose();
    };
  }, []);

  if (state.phase === "error") throw state.error;
  if (state.phase === "loading") return <StartupShell />;
  const WorkbenchRoot = state.module.b;
  return <WorkbenchRoot application={state.application} />;
}

const reactRoot = ReactDOM.createRoot(rootElement);
reactRoot.render(
  <RuntimeErrorBoundary>
    <ApplicationBootstrap />
  </RuntimeErrorBoundary>,
);
window.requestAnimationFrame(() => {
  document.getElementById("opencraft-bootstrap")?.remove();
});

if (import.meta.hot !== undefined) {
  import.meta.hot.dispose(() => disposeDesktopFullscreenSubscription?.());
  import.meta.hot.dispose(() => {
    reactRoot.unmount();
  });
}
