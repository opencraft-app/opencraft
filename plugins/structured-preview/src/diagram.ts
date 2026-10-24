import type { WebPreviewDocument } from "@opencraft/file-preview-web";
import DOMPurify from "dompurify";
import { createSvgViewport } from "./svg-viewport";
import "./preview.web.scss";

export async function openDiagram(input: { blob: Blob; name: string; signal: AbortSignal }): Promise<WebPreviewDocument> {
  const source = await input.blob.text(); input.signal.throwIfAborted();
  if (/\.(drawio|dio)$/iu.test(input.name)) {
    const { openDrawio } = await import("./drawio"); input.signal.throwIfAborted();
    return openDrawio(source, input.name, input.signal);
  }
  const viewport = createSvgViewport(input.name);
  const kind = /\.excalidraw$/iu.test(input.name) ? "excalidraw" : "mermaid";
  viewport.element.dataset.diagramKind = kind;
  let disposed = false, dark = false, generation = 0, failure: unknown;
  const listeners = new Set<(error: unknown) => void>();
  const work = new AbortController();
  const dispose = () => { if (!disposed) { disposed = true; generation++; work.abort(); input.signal.removeEventListener("abort", dispose); viewport.dispose(); listeners.clear(); } };
  input.signal.addEventListener("abort", dispose, { once: true });
  const render = async (isDark: boolean) => {
    const current = ++generation; let svg: SVGSVGElement;
    if (kind === "mermaid") {
      if (source.length > 100_000 || source.trim().length === 0) throw new Error("Mermaid source exceeds preview limits or is empty");
      const { renderMermaidSvg } = await import("@opencraft/chat-render-web/mermaid");
      work.signal.throwIfAborted();
      const markup = await renderMermaidSvg(`file-mermaid-${crypto.randomUUID()}`, source, document.documentElement, isDark ? "dark" : "light", work.signal);
      const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
      svg = parsed.documentElement as unknown as SVGSVGElement;
    } else {
      const data = JSON.parse(source);
      if (data.type !== "excalidraw" || !Array.isArray(data.elements) || data.elements.length > 20_000) throw new Error("Invalid Excalidraw scene");
      const { loadFromBlob, exportToSvg, getNonDeletedElements } = await import("@excalidraw/excalidraw");
      work.signal.throwIfAborted();
      const assetBase = new URL(`${import.meta.env.BASE_URL}assets/excalidraw-fonts/`, location.origin).href;
      (window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = assetBase;
      const scene = await loadFromBlob(new Blob([source], { type: "application/json" }), null, null);
      work.signal.throwIfAborted();
      svg = await exportToSvg({ elements: getNonDeletedElements(scene.elements), files: scene.files,
        appState: { ...scene.appState, exportBackground: true, exportWithDarkMode: isDark }, renderEmbeddables: false });
    }
    work.signal.throwIfAborted();
    if (disposed || current !== generation) return;
    DOMPurify.sanitize(svg, { IN_PLACE: true, USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ["style"], FORBID_TAGS: ["foreignObject"] });
    for (const node of svg.querySelectorAll("a, image, use")) {
      for (const attribute of ["href", "xlink:href"]) {
        const value = node.getAttribute(attribute);
        if (value && !value.startsWith("#") && !(node.localName === "image" && /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);/iu.test(value))) node.removeAttribute(attribute);
      }
    }
    viewport.setSvg(svg); viewport.element.dataset.diagramReady = "true";
  };
  try { await render(false); } catch (error) { dispose(); throw error; }
  return { element: viewport.element, dispose, setIntl: viewport.setIntl,
    setActive(active) { viewport.element.inert = !active; },
    setTheme(next) {
      if (disposed || next === dark) return; dark = next;
      void render(next).catch(error => { if (!disposed && !work.signal.aborted) { failure = error; for (const listener of listeners) listener(error); } });
    },
    subscribeFailure(listener) { if (failure) listener(failure); else listeners.add(listener); return () => listeners.delete(listener); },
  };
}
