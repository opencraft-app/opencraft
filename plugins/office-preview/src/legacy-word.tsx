import { createRoot } from "react-dom/client";
import { Component, type ReactNode } from "react";
import { DocxEditorViewer, parseDocxForViewer, setWasmSource, useDocxEditor, type ParsedDocxDocument } from "@extend-ai/react-docx";
import wasmUrl from "@extend-ai/react-docx/docx_wasm_bg.wasm?url";
import { bindPreviewLinks, FilePreviewError, type WebPreviewDocument } from "@opencraft/file-preview-web";

import { createPaperViewport } from "./paper-viewport";

setWasmSource(wasmUrl);

class WordBoundary extends Component<{ children: ReactNode; failed(error: unknown): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { this.props.failed(error); }
  render() { return this.state.failed ? null : this.props.children; }
}
function WordDocument({ document }: { document: ParsedDocxDocument }) {
  const editor = useDocxEditor({ document, initialDocumentTheme: "light" });
  return <DocxEditorViewer editor={editor} mode="read-only" zoom={100}
    showComments={false} showTrackedChanges={false} pageGapBackgroundColor="transparent" />;
}
export async function openLegacyWord(buffer: ArrayBuffer, name: string, signal: AbortSignal): Promise<WebPreviewDocument> {
  let parsed: ParsedDocxDocument;
  try {
    parsed = await parseDocxForViewer(buffer, { signal, fileName: name, useWorker: "required", transferBuffer: false });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && /encrypt|password|obfuscat/iu.test(error.message)) throw new FilePreviewError("encrypted");
    if (error instanceof Error && /invalid|not a Word|unsupported legacy|missing.*stream|CFB|FIB|Clx/iu.test(error.message)) throw new FilePreviewError("invalid");
    throw error;
  }
  if (signal.aborted) { parsed.dispose(); signal.throwIfAborted(); }
  const paper = createPaperViewport("doc");
  const element = paper.element;
  let disposed = false, failure: unknown, openLink: ((url: string) => void) | undefined;
  const listeners = new Set<(error: unknown) => void>();
  const unbindLinks = bindPreviewLinks(element, () => openLink);
  const root = createRoot(paper.content);
  const dispose = () => {
    if (disposed) return;
    disposed = true; signal.removeEventListener("abort", dispose); unbindLinks();
    root.unmount(); parsed.dispose(); paper.dispose(); element.remove(); listeners.clear();
  };
  signal.addEventListener("abort", dispose, { once: true });
  const failed = (error: unknown) => {
    failure = error;
    queueMicrotask(() => { if (!disposed) { for (const listener of listeners) listener(error); dispose(); } });
  };
  root.render(<WordBoundary failed={failed}><WordDocument document={parsed} /></WordBoundary>);
  return { element, dispose, setIntl: paper.setIntl, setActive(active) { element.inert = !active; if (active) paper.refresh(); },
    setOpenLink(open) { openLink = open; },
    subscribeFailure(listener) { if (failure) listener(failure); else listeners.add(listener); return () => listeners.delete(listener); },
  };
}
