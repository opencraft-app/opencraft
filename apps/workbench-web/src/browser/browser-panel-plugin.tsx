import type {
  BrowserPageId,
  BrowserTabId,
  BrowserViewportMode,
} from "@opencraft/browser-core";
import {
  BROWSER_DEVICE_PRESETS,
  browserUrlDisplayValue,
  rotateBrowserViewportMode,
} from "@opencraft/browser-core";
import type { Context } from "@deepseek-ai/cordis";
import type { PanelToolbarActionContext } from "@opencraft/workbench-panels";
import type { PanelRendererProps } from "@opencraft/workbench-panels-react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe2,
  LoaderCircle,
  MonitorSmartphone,
  RotateCcw,
  RotateCw,
  X,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { useAppShellLayoutMotion } from "../components/app-shell";
import {
  useBrowserPresentationCoordinator,
  useBrowserTab,
  useBrowserWorkbench,
  useWebBrowserPage,
  useWebBrowserPageRuntime,
} from "./browser-runtime-context";
import type { BrowserPresentationHandle } from "./browser-presentation-coordinator";
import type { BrowserWorkbenchCoordinator } from "./browser-workbench-coordinator";
import type { WebBrowserPageRuntime } from "./web-browser-runtime";

const FIT_VIEWPORT = { type: "fit", width: 1440, height: 900 } as const;

function viewportModeKey(mode: BrowserViewportMode): string {
  if (mode.type === "responsive") return "responsive";
  if (mode.type === "fit") return "fit";
  return `device:${mode.presetId}`;
}

function viewportModeFromKey(key: string): BrowserViewportMode {
  if (key === "fit") return FIT_VIEWPORT;
  if (key.startsWith("device:")) {
    const preset = BROWSER_DEVICE_PRESETS.find(
      (candidate) => candidate.id === key.slice("device:".length),
    );
    if (preset !== undefined) {
      return {
        type: "device",
        presetId: preset.id,
        width: preset.width,
        height: preset.height,
      };
    }
  }
  return { type: "responsive" };
}

function browserTabIdFromPanel(tab: PanelRendererProps["tab"]): BrowserTabId {
  if (tab.resource === undefined) throw new Error(`Browser panel ${tab.id} has no tab resource`);
  return tab.resource as BrowserTabId;
}

function BrowserPanel({ tab: panelTab, presentationId }: PanelRendererProps) {
  const tabId = browserTabIdFromPanel(panelTab);
  const pages = useWebBrowserPageRuntime();
  const workbench = useBrowserWorkbench();
  const presentations = useBrowserPresentationCoordinator();
  const { rightPanelLayoutTick, rightPanelPresentationActive } = useAppShellLayoutMotion();
  const tab = useBrowserTab(tabId);
  const pageId = tab?.pageId ?? ("missing-browser-page" as BrowserPageId);
  const page = useWebBrowserPage(pageId);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const presentationRef = useRef<BrowserPresentationHandle | null>(null);
  const [address, setAddress] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

  useEffect(() => {
    if (page !== null) setAddress(browserUrlDisplayValue(page.navigation.currentUrl));
  }, [page?.navigation.currentUrl]);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (slot === null || tab === null || page === null || !rightPanelPresentationActive) return;
    const presentation = presentations.present({
      pageId: tab.pageId,
      tabId: tab.id,
      viewId: presentationId,
      surface: "right-panel",
      slot,
      viewportMode: tab.viewportMode,
    });
    presentationRef.current = presentation;
    let frameId: number | null = null;
    const scheduleMeasure = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        presentation.measure();
      });
    };
    const unsubscribeLayout = rightPanelLayoutTick.on("change", scheduleMeasure);
    scheduleMeasure();
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      unsubscribeLayout();
      if (presentationRef.current === presentation) presentationRef.current = null;
      presentation.dispose();
    };
  }, [
    presentationId,
    page === null,
    pageId,
    presentations,
    rightPanelLayoutTick,
    rightPanelPresentationActive,
    tabId,
  ]);

  useLayoutEffect(() => {
    if (tab !== null) presentationRef.current?.updateViewportMode(tab.viewportMode);
  }, [tab?.viewportMode]);

  if (tab === null || page === null) {
    return (
      <div className="right-panel-empty">
        <span><Globe2 size={18} /></span>
        <strong>Browser tab unavailable</strong>
        <p>This tab can be closed and reopened.</p>
      </div>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      pages.navigate(page.id, address);
      setInputError(null);
    } catch (error) {
      setInputError(error instanceof Error ? error.message : "Invalid address");
    }
  };
  const currentUrl = page.navigation.currentUrl;

  return (
    <section className="browser-panel" data-viewport-mode={tab.viewportMode.type} aria-label={page.title}>
      <form className="browser-panel__toolbar" onSubmit={submit}>
        <button type="button" className="browser-toolbar-button" disabled={!page.navigation.canGoBack}
          aria-label="Back" title="Back" onClick={() => pages.goBack(page.id)}>
          <ArrowLeft size={14} />
        </button>
        <button type="button" className="browser-toolbar-button" disabled={!page.navigation.canGoForward}
          aria-label="Forward" title="Forward" onClick={() => pages.goForward(page.id)}>
          <ArrowRight size={14} />
        </button>
        <button type="button" className="browser-toolbar-button"
          aria-label={page.navigation.isLoading ? "Stop" : "Reload"}
          title={page.navigation.isLoading ? "Stop" : "Reload"}
          onClick={() => page.navigation.isLoading ? pages.stop(page.id) : pages.reload(page.id)}>
          {page.navigation.isLoading ? <X size={13} /> : <RotateCw size={13} />}
        </button>
        <label className="browser-address-field" data-invalid={inputError !== null}>
          {page.navigation.isLoading
            ? <LoaderCircle className="browser-address-field__spinner" size={13} />
            : <Globe2 size={13} />}
          <input aria-label="Web address" autoCapitalize="none" autoCorrect="off"
            placeholder="Enter a web address" spellCheck={false} value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => event.currentTarget.select()} />
        </label>
        <button type="button" className="browser-toolbar-button" disabled={currentUrl === null}
          aria-label="Open in external browser" title="Open in external browser"
          onClick={() => currentUrl !== null && window.open(currentUrl, "_blank", "noopener,noreferrer")}>
          <ExternalLink size={13} />
        </button>
        <label className="browser-viewport-mode-picker" title="Browser viewport">
          <MonitorSmartphone size={13} aria-hidden="true" />
          <select aria-label="Browser viewport" value={viewportModeKey(tab.viewportMode)}
            onChange={(event) => workbench.setViewportMode(tab.id, viewportModeFromKey(event.currentTarget.value))}>
            <option value="responsive">Responsive</option>
            <option value="fit">Fit · {tab.viewportMode.type === "fit"
              ? `${tab.viewportMode.width} × ${tab.viewportMode.height}` : "1440 × 900"}</option>
            {BROWSER_DEVICE_PRESETS.map((preset) => (
              <option key={preset.id} value={`device:${preset.id}`}>
                {preset.label} · {tab.viewportMode.type === "device" && tab.viewportMode.presetId === preset.id
                  ? `${tab.viewportMode.width} × ${tab.viewportMode.height}`
                  : `${preset.width} × ${preset.height}`}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="browser-toolbar-button browser-viewport-rotate"
          disabled={tab.viewportMode.type === "responsive"} aria-label="Rotate viewport" title="Rotate viewport"
          onClick={() => workbench.setViewportMode(tab.id, rotateBrowserViewportMode(tab.viewportMode))}>
          <RotateCcw size={13} />
        </button>
      </form>
      {inputError ?? page.error ? (
        <div className="browser-panel__notice" role="status">
          <span>{inputError ?? page.error}</span>
          {currentUrl !== null ? <button type="button"
            onClick={() => window.open(currentUrl, "_blank", "noopener,noreferrer")}>Open externally</button> : null}
        </div>
      ) : null}
      <div ref={slotRef} className="browser-viewport-slot"
        data-viewport-mode={tab.viewportMode.type} />
    </section>
  );
}

export function createBrowserWorkbenchPanelPlugin(
  pages: WebBrowserPageRuntime,
  workbench: BrowserWorkbenchCoordinator,
  onCreateTab: (context: PanelToolbarActionContext) => void = () => undefined,
) {
  const browserPanelTab = (browserTabId: string) => {
    const tabId = browserTabId as BrowserTabId;
    const page = workbench.pageForTab(tabId);
    return {
      id: `browser:${tabId}`,
      kind: "browser",
      region: "right" as const,
      title: page?.title ?? "Browser",
      icon: "browser",
      resource: tabId,
      closable: true,
      preview: false,
      durableRoute: {
        kind: "browser-tab",
        params: { browserTabId: tabId },
        payloadVersion: 1,
      },
    };
  };
  return Object.assign(function BrowserWorkbenchPanelPlugin(ctx: Context) {
    const remove = [
      ctx.workbenchPanels.register<{ readonly browserTabId: string }>({
        kind: "browser",
        restoreTabs: (ownerId) => workbench.listForOwner(ownerId)
          .map(({ tab }) => browserPanelTab(tab.id)),
        createTab: ({ browserTabId }) => browserPanelTab(browserTabId),
        disposeTab: (tab, ownerId, reason) => {
          if (tab.resource !== undefined)
            workbench.releasePanel(ownerId, tab.resource as BrowserTabId, reason === "close");
        },
      }),
      ctx.workbenchPanelRenderers.register({ kind: "browser", Component: BrowserPanel }),
      ctx.workbenchPanels.registerToolbarAction({
        id: "vela.browser.new-tab",
        region: "right",
        order: 100,
        label: "New browser tab",
        creationLabel: "Browser",
        icon: "browser",
        run: onCreateTab,
      }),
    ];
    ctx.effect(() => () => remove.reverse().forEach((dispose) => dispose()));
  }, { inject: ["workbenchPanels", "workbenchPanelRenderers"] });
}
