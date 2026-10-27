import { createRoot } from "react-dom/client";
import { Component, useEffect, type ReactNode } from "react";
import { XlsxViewer, setWasmSource, useXlsxViewerController, type XlsxViewerController } from "@extend-ai/react-xlsx";
import wasmUrl from "@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm?url";
import { bindPreviewLinks, type FilePreviewIntl, type WebPreviewDocument } from "@opencraft/file-preview-web";

setWasmSource(wasmUrl);

class SpreadsheetBoundary extends Component<{ children: ReactNode; failed(error: unknown): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { this.props.failed(error); }
  render() { return this.state.failed ? null : this.props.children; }
}

function Spreadsheet({ buffer, name, dark, intl, ready, failed }: {
  buffer: ArrayBuffer; name: string; dark: boolean; intl?: FilePreviewIntl; ready(): void; failed(error: unknown): void;
}) {
  const controller = useXlsxViewerController({ file: buffer, fileName: name, readOnly: true, useWorker: true, maxFileSizeBytes: 25 * 1024 * 1024 });
  useEffect(() => {
    if (controller.error) failed(controller.error);
    else if (controller.tabs.length > 0 && !controller.isLoading) ready();
  }, [controller.error, controller.tabs.length, controller.isLoading, ready, failed]);
  return <XlsxViewer controller={controller} height="100%" isDark={dark} readOnly rounded={false}
    showDefaultToolbar={false} toolbar={(state: XlsxViewerController) => <div className="office-preview__sheets" role="tablist" aria-label={intl?.formatMessage({ id: "preview.worksheets", defaultMessage: "Worksheets" }) ?? "Worksheets"}>
      {state.tabs.map((tab, index) => <button type="button" role="tab" key={tab.id}
        aria-selected={state.activeTabIndex === index} tabIndex={state.activeTabIndex === index ? 0 : -1}
        onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % state.tabs.length
            : event.key === "ArrowLeft" ? (index + state.tabs.length - 1) % state.tabs.length
              : event.key === "Home" ? 0 : event.key === "End" ? state.tabs.length - 1 : null;
          if (next === null) return;
          event.preventDefault(); state.setActiveTabIndex(next);
          (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
        }} onClick={() => state.setActiveTabIndex(index)}>{tab.name}</button>)}
    </div>} />;
}

export function openSpreadsheet(buffer: ArrayBuffer, name: string, signal: AbortSignal): Promise<WebPreviewDocument> {
  return new Promise((resolve, reject) => {
    const element = document.createElement("div");
    element.className = "office-preview office-preview--xlsx";
    let openLink: ((url: string) => void) | undefined;
    let currentIntl: FilePreviewIntl | undefined, darkTheme = false;
    const unbindLinks = bindPreviewLinks(element, () => openLink);
    // This engine's cell/drawing click path opens URLs without a host callback.
    // Keep selection (pointerdown) and worksheet controls, but no implicit links.
    const containEngineLinks = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button, input, select, [role=tab], [role=scrollbar], a")) return;
      event.stopPropagation();
    };
    element.addEventListener("click", containEngineLinks, true);
    const root = createRoot(element);
    let disposed = false;
    let settled = false;
    let failure: { error: unknown } | undefined;
    const failures = new Set<(error: unknown) => void>();
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener("abort", abort);
      unbindLinks(); element.removeEventListener("click", containEngineLinks, true); root.unmount(); element.remove(); failures.clear();
    };
    const abort = () => { dispose(); if (!settled) { settled = true; reject(new DOMException("Preview cancelled", "AbortError")); } };
    const ready = () => {
      if (disposed || settled) return;
      settled = true;
      resolve({ element, dispose, setTheme: dark => { darkTheme = dark; if (!disposed) render(); },
        setIntl: intl => { currentIntl = intl; if (!disposed) render(); },
        setOpenLink: open => { openLink = open; },
        setActive: active => { element.inert = !active; },
        subscribeFailure: listener => {
          if (failure) listener(failure.error);
          else if (!disposed) failures.add(listener);
          return () => { failures.delete(listener); };
        } });
    };
    const failed = (error: unknown) => {
      if (disposed || failure) return;
      failure = { error };
      if (!settled) { settled = true; reject(error); }
      // Failure can be reported during a React commit; notify/release afterwards.
      queueMicrotask(() => { for (const listener of [...failures]) listener(error); dispose(); });
    };
    const render = () => root.render(<SpreadsheetBoundary failed={failed}><Spreadsheet buffer={buffer} name={name} dark={darkTheme} intl={currentIntl} ready={ready} failed={failed} /></SpreadsheetBoundary>);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    render();
  });
}
