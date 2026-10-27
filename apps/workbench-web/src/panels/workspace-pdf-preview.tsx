import { ChevronLeftIcon as ChevronLeft, ChevronRightIcon as ChevronRight, LoadingRingIcon as LoaderCircle } from "@opencraft/design-system-web/action-icons";
import { useEffect, useRef, useState } from "react";
import { DownloadIcon as Download, ZoomInIcon as ZoomIn, ZoomOutIcon as ZoomOut } from "@opencraft/design-system-web/action-icons";
import { useIntl } from "@opencraft/i18n/react";
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { PdfBinaryDataFactory } from "./pdf-assets";
import { downloadWorkspaceBlob } from "./workspace-media-preview";
import "./workspace-pdf-preview.scss";

GlobalWorkerOptions.workerSrc = workerUrl;

export function WorkspacePdfPreview({ blob, name }: { readonly blob: Blob; readonly name: string }) {
  const intl = useIntl();
  const [loaded, setLoaded] = useState<{ blob: Blob; document: PDFDocumentProxy } | null>(null);
  const document = loaded?.blob === blob ? loaded.document : null;
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [failed, setFailed] = useState(false);
  const [painted, setPainted] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pageHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    let task: ReturnType<typeof getDocument> | undefined;
    setLoaded(null); setPageNumber(1); setZoom(1); setFailed(false); setPainted(false);
    void blob.arrayBuffer().then(async data => {
      if (!active) return;
      task = getDocument({ data: new Uint8Array(data), BinaryDataFactory: PdfBinaryDataFactory, useWorkerFetch: false });
      const pdf = await task.promise;
      if (active) setLoaded({ blob, document: pdf });
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; void task?.destroy().catch(() => undefined); };
  }, [blob]);

  useEffect(() => {
    const container = scroller.current;
    if (container === null) return;
    const resize = () => setWidth(Math.max(1, container.clientWidth - 32));
    const observer = new ResizeObserver(resize);
    observer.observe(container); resize();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (document === null || width === 0) return;
    let active = true;
    let render: RenderTask | undefined;
    let text: TextLayer | undefined;
    let renderedPage: PDFPageProxy | undefined;
    setPainted(false);
    void document.getPage(pageNumber).then(async page => {
      if (!active) { page.cleanup(); return; }
      renderedPage = page;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / base.width * zoom });
      // Bound the backing bitmap on high-DPI phones, independently of zoom.
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
      const surface = window.document.createElement("div");
      surface.className = "workspace-pdf-preview__page";
      surface.style.width = `${viewport.width}px`;
      surface.style.height = `${viewport.height}px`;
      surface.style.setProperty("--total-scale-factor", String(viewport.scale));
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      surface.append(canvas);
      render = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await render.promise;
      if (!active) return;
      const layer = window.document.createElement("div");
      layer.className = "workspace-pdf-preview__text";
      text = new TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport });
      await text.render();
      if (!active) return;
      surface.append(layer);
      pageHost.current?.replaceChildren(surface);
      scroller.current?.scrollTo(0, 0);
      setPainted(true);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; render?.cancel(); text?.cancel(); renderedPage?.cleanup(); };
  }, [document, pageNumber, width, zoom]);

  return <div className="workspace-pdf-preview" data-pdf-ready={painted && !failed || undefined}>
    <div className="workspace-pdf-preview__toolbar">
      <button type="button" disabled={document === null || pageNumber <= 1} aria-label={intl.formatMessage({ id: "pdf.previous", defaultMessage: "Previous page" })} onClick={() => setPageNumber(pageNumber - 1)}><ChevronLeft size={16} /></button>
      <span aria-live="polite">{document === null ? "—" : intl.formatMessage({ id: "pdf.page", defaultMessage: "{page} / {total}" }, { page: pageNumber, total: document.numPages })}</span>
      <button type="button" disabled={document === null || pageNumber >= document.numPages} aria-label={intl.formatMessage({ id: "pdf.next", defaultMessage: "Next page" })} onClick={() => setPageNumber(pageNumber + 1)}><ChevronRight size={16} /></button>
      <button type="button" disabled={document === null || zoom <= 0.5} aria-label={intl.formatMessage({ id: "pdf.zoomOut", defaultMessage: "Zoom out" })} onClick={() => setZoom(value => Math.max(0.5, value - 0.25))}><ZoomOut size={16} /></button>
      <button type="button" disabled={document === null} onClick={() => setZoom(1)}>{intl.formatMessage({ id: "pdf.fit", defaultMessage: "Fit width" })}</button>
      <button type="button" disabled={document === null || zoom >= 3} aria-label={intl.formatMessage({ id: "pdf.zoomIn", defaultMessage: "Zoom in" })} onClick={() => setZoom(value => Math.min(3, value + 0.25))}><ZoomIn size={16} /></button>
      <button type="button" aria-label={intl.formatMessage({ id: "pdf.download", defaultMessage: "Download file" })} onClick={() => downloadWorkspaceBlob(blob, name)}><Download size={16} /></button>
    </div>
    <div className="workspace-pdf-preview__scroll" ref={scroller} aria-label={name}>
      <div ref={pageHost} hidden={!painted || failed} />
      {!painted && !failed ? <div className="workspace-pdf-preview__status" role="status"><LoaderCircle size={18} className="is-spinning" />{intl.formatMessage({ id: "pdf.loading", defaultMessage: "Loading PDF…" })}</div> : null}
      {failed ? <div className="workspace-pdf-preview__status" role="status">{intl.formatMessage({ id: "pdf.failed", defaultMessage: "This PDF could not be displayed. Download it to open in another reader." })}</div> : null}
    </div>
  </div>;
}
