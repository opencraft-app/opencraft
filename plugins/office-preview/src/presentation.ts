import { buildPresentation, materializeSlideNodes, parseZipLazyMedia, renderSlide, RECOMMENDED_ZIP_LIMITS,
  type SlideHandle } from "@aiden0z/pptx-renderer/browser";
import { bindPreviewLinks, previewLinkTarget, FilePreviewError, type FilePreviewIntl, type WebPreviewDocument } from "@opencraft/file-preview-web";

/** One parsed deck; the retained preview owns page/zoom and every render handle. */
export async function openPresentation(buffer: ArrayBuffer, signal: AbortSignal): Promise<WebPreviewDocument> {
  const files = await parseZipLazyMedia(buffer, { ...RECOMMENDED_ZIP_LIMITS,
    maxTotalUncompressedBytes: 64 * 1024 * 1024, maxEntryUncompressedBytes: 32 * 1024 * 1024 });
  signal.throwIfAborted();
  const presentation = buildPresentation(files, { lazySlides: true });
  if (!presentation.slides.length || !Number.isFinite(presentation.width) || !Number.isFinite(presentation.height)
    || presentation.width <= 0 || presentation.height <= 0) throw new FilePreviewError("invalid");
  signal.throwIfAborted();
  const element = document.createElement("div"); element.className = "office-preview office-preview--pptx";
  const body = document.createElement("div"); body.className = "office-preview__presentation-body";
  const rail = document.createElement("div"); rail.className = "office-preview__thumbnails";
  rail.id = `pptx-slides-${crypto.randomUUID()}`; rail.setAttribute("role", "navigation");
  const viewport = document.createElement("div"); viewport.className = "office-preview__slide-scroll"; viewport.tabIndex = 0;
  viewport.setAttribute("role", "region");
  const canvas = document.createElement("div"); canvas.className = "office-preview__slide-canvas";
  const frame = document.createElement("div"); frame.className = "office-preview__slide-frame";
  canvas.append(frame); viewport.append(canvas); body.append(rail, viewport);
  const toolbar = document.createElement("div"); toolbar.className = "office-preview__presentation-toolbar";
  element.append(body, toolbar);
  let disposed = false, active = true, current = 0, zoom = 100, intl: FilePreviewIntl | undefined;
  let currentHandle: SlideHandle | undefined, failure: { error: unknown } | undefined;
  let openLink: ((url: string) => void) | undefined;
  const listeners = new Set<(error: unknown) => void>();
  const thumbnails = new Map<number, SlideHandle>();
  const visible = new Set<number>();
  const thumbnailButtons: HTMLButtonElement[] = [], thumbnailSurfaces: HTMLDivElement[] = [];
  const labels: Array<{ button: HTMLButtonElement; id: string; defaultMessage: string }> = [];
  const message = (id: string, defaultMessage: string, values?: Record<string, number>) =>
    intl?.formatMessage({ id, defaultMessage }, values) ?? defaultMessage.replace(/\{(\w+)\}/gu, (_, key: string) => String(values?.[key] ?? ""));
  const unbindLinks = bindPreviewLinks(frame, () => openLink);
  const releaseSlide = () => { currentHandle?.dispose(); currentHandle = undefined; frame.replaceChildren(); };
  const releaseThumbnail = (index: number) => { thumbnails.get(index)?.dispose(); thumbnails.delete(index); thumbnailSurfaces[index]?.replaceChildren(); };
  const dispose = () => {
    if (disposed) return;
    disposed = true; signal.removeEventListener("abort", dispose); observer.disconnect(); resize.disconnect(); unbindLinks();
    releaseSlide(); for (const index of thumbnails.keys()) releaseThumbnail(index);
    listeners.clear(); element.remove(); element.replaceChildren();
  };
  const failed = (error: unknown) => {
    if (disposed || failure) return;
    failure = { error };
    queueMicrotask(() => { if (!disposed) { for (const listener of listeners) listener(error); dispose(); } });
  };
  const scaleSlide = () => {
    if (disposed || !active || !currentHandle) return;
    const scale = Math.max(0.01, Math.min((viewport.clientWidth - 24) / presentation.width,
      (viewport.clientHeight - 24) / presentation.height)) * zoom / 100;
    frame.style.width = `${presentation.width * scale}px`; frame.style.height = `${presentation.height * scale}px`;
    currentHandle.element.style.transform = `scale(${scale})`;
  };
  const paint = () => {
    pageInput.value = String(current + 1); pageInput.max = String(presentation.slides.length);
    total.textContent = `/ ${intl?.formatNumber(presentation.slides.length) ?? presentation.slides.length}`;
    status.textContent = message("pdf.page", "{page} / {total}", { page: current + 1, total: presentation.slides.length });
    viewport.setAttribute("aria-label", message("preview.slide", "Slide {page}", { page: current + 1 }));
    previous.disabled = current === 0; next.disabled = current === presentation.slides.length - 1;
    zoomOut.disabled = zoom <= 25; zoomIn.disabled = zoom >= 300;
    percentage.textContent = `${intl?.formatNumber(zoom) ?? zoom}%`;
    thumbnailButtons.forEach((button, index) => {
      button.tabIndex = current === index ? 0 : -1;
      if (current === index) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    });
  };
  const go = (index: number, focusThumbnail = false) => {
    if (disposed || !active) return;
    const target = Math.max(0, Math.min(presentation.slides.length - 1, index));
    if (target !== current) { current = target; showSlide(); viewport.scrollLeft = 0; viewport.scrollTop = 0; }
    paint();
    const button = thumbnailButtons[current]!;
    // Scroll this rail only; scrollIntoView would also move the surrounding Shell.
    if (button.offsetTop < rail.scrollTop) rail.scrollTop = button.offsetTop;
    else if (button.offsetTop + button.offsetHeight > rail.scrollTop + rail.clientHeight)
      rail.scrollTop = button.offsetTop + button.offsetHeight - rail.clientHeight;
    if (focusThumbnail) button.focus({ preventScroll: true });
  };
  const showSlide = () => {
    releaseSlide();
    try {
      const slide = presentation.slides[current]!; materializeSlideNodes(presentation, slide);
      currentHandle = renderSlide(presentation, slide, { pdfjs: false, onNavigate: target => {
        if (disposed || !active) return;
        if (Number.isInteger(target.slideIndex)) go(target.slideIndex!);
        else { const url = previewLinkTarget(target.url ?? null); if (url && !url.startsWith("#")) openLink?.(url); }
      } });
      currentHandle.element.style.position = "absolute"; currentHandle.element.style.inset = "0 auto auto 0";
      currentHandle.element.style.transformOrigin = "top left"; frame.append(currentHandle.element); scaleSlide();
      const handle = currentHandle;
      void handle.ready.catch(error => { if (handle === currentHandle) failed(error); });
    } catch (error) { failed(error); }
  };
  const setZoom = (value: number) => {
    zoom = Math.max(25, Math.min(300, value)); scaleSlide(); paint();
  };
  const button = (parent: HTMLElement, glyph: string, id: string, defaultMessage: string, action: () => void) => {
    const button = document.createElement("button"); button.type = "button"; button.textContent = glyph; button.onclick = action;
    labels.push({ button, id, defaultMessage }); parent.append(button); return button;
  };
  const pages = document.createElement("div"); pages.className = "office-preview__presentation-controls";
  const sizing = document.createElement("div"); sizing.className = "office-preview__presentation-controls";
  const toggle = button(pages, "☷", "preview.slides", "Slide thumbnails", () => {
    element.dataset.thumbnails = element.dataset.thumbnails === "hidden" ? "shown" : "hidden";
    syncToggle();
  });
  toggle.setAttribute("aria-controls", rail.id);
  const previous = button(pages, "‹", "pdf.previous", "Previous page", () => go(current - 1));
  const pageInput = document.createElement("input"); pageInput.type = "number"; pageInput.inputMode = "numeric"; pageInput.min = "1"; pageInput.step = "1";
  const commitPage = () => { const value = Number(pageInput.value); if (Number.isInteger(value) && pageInput.value.trim()) go(value - 1); else paint(); };
  pageInput.onblur = commitPage;
  pageInput.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); commitPage(); } else if (event.key === "Escape") { event.preventDefault(); paint(); } };
  const total = document.createElement("span"); total.setAttribute("aria-hidden", "true"); pages.append(pageInput, total);
  const next = button(pages, "›", "pdf.next", "Next page", () => go(current + 1));
  const zoomOut = button(sizing, "−", "pdf.zoomOut", "Zoom out", () => setZoom(zoom - 25));
  const percentage = document.createElement("span"); sizing.append(percentage);
  const zoomIn = button(sizing, "+", "pdf.zoomIn", "Zoom in", () => setZoom(zoom + 25));
  button(sizing, "⤢", "preview.fitSlide", "Fit slide", () => { setZoom(100); viewport.scrollLeft = 0; viewport.scrollTop = 0; });
  const status = document.createElement("span"); status.className = "office-preview__presentation-status"; status.setAttribute("role", "status");
  toolbar.append(pages, sizing, status);
  const syncToggle = () => {
    const shown = element.dataset.thumbnails !== "hidden";
    rail.hidden = !shown; toggle.setAttribute("aria-expanded", String(shown));
    if (!shown) for (const index of thumbnails.keys()) releaseThumbnail(index);
    else { refreshThumbnails(); queueMicrotask(() => go(current)); }
  };
  const refreshThumbnails = () => {
    if (disposed) return;
    // IntersectionObserver's overscan is still bounded when the rail is tall.
    const desired = active && !rail.hidden ? [...visible].sort((a, b) => Math.abs(a - current) - Math.abs(b - current)).slice(0, 8) : [];
    for (const index of thumbnails.keys()) if (!desired.includes(index)) releaseThumbnail(index);
    for (const index of desired) {
      if (thumbnails.has(index)) continue;
      try {
        const slide = presentation.slides[index]!; materializeSlideNodes(presentation, slide);
        const handle = renderSlide(presentation, slide, { pdfjs: false });
        handle.element.style.transform = `scale(${88 / presentation.width})`; handle.element.style.transformOrigin = "top left";
        thumbnailSurfaces[index]!.append(handle.element); thumbnails.set(index, handle);
        void handle.ready.catch(() => { if (thumbnails.get(index) === handle) releaseThumbnail(index); });
      } catch { /* A thumbnail is optional; selecting it still reports page failures. */ }
    }
  };
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) { const index = Number((entry.target as HTMLElement).dataset.page); if (entry.isIntersecting) visible.add(index); else visible.delete(index); }
    refreshThumbnails();
  }, { root: rail, rootMargin: "160px 0px" });
  presentation.slides.forEach((_, index) => {
    const button = document.createElement("button"); button.type = "button"; button.dataset.page = String(index);
    button.className = "office-preview__thumbnail"; button.onclick = () => go(index);
    const surface = document.createElement("div"); surface.className = "office-preview__thumbnail-surface"; surface.setAttribute("aria-hidden", "true"); surface.inert = true;
    surface.style.height = `${88 * presentation.height / presentation.width}px`;
    const number = document.createElement("span"); number.textContent = String(index + 1); number.setAttribute("aria-hidden", "true");
    button.append(surface, number); rail.append(button); thumbnailButtons.push(button); thumbnailSurfaces.push(surface); observer.observe(button);
  });
  element.onkeydown = event => {
    const target = event.target;
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || target instanceof Element && target.closest("input, textarea, select, a, [contenteditable=true], audio, video")) return;
    const inThumbnails = target instanceof Element && Boolean(target.closest(".office-preview__thumbnail"));
    const nextPage = event.key === "ArrowRight" || event.key === "PageDown" || inThumbnails && event.key === "ArrowDown" ? current + 1
      : event.key === "ArrowLeft" || event.key === "PageUp" || inThumbnails && event.key === "ArrowUp" ? current - 1
        : event.key === "Home" ? 0 : event.key === "End" ? presentation.slides.length - 1 : null;
    if (nextPage === null) return;
    event.preventDefault(); event.stopPropagation(); go(nextPage, inThumbnails);
  };
  const resize = new ResizeObserver(() => {
    if (!element.dataset.thumbnails && element.clientWidth) { element.dataset.thumbnails = element.clientWidth < 520 ? "hidden" : "shown"; syncToggle(); }
    scaleSlide();
  }); resize.observe(element); resize.observe(viewport);
  const updateLabels = () => {
    for (const { button, id, defaultMessage } of labels) { const label = message(id, defaultMessage); button.title = label; button.setAttribute("aria-label", label); }
    rail.setAttribute("aria-label", message("preview.slides", "Slide thumbnails"));
    pageInput.setAttribute("aria-label", message("preview.slideNumber", "Slide number"));
    thumbnailButtons.forEach((button, index) => button.setAttribute("aria-label", message("preview.slide", "Slide {page}", { page: index + 1 })));
    paint();
  };
  try {
    updateLabels();
    signal.addEventListener("abort", dispose, { once: true }); signal.throwIfAborted();
    showSlide(); if (failure) throw failure.error;
    return { element, dispose, setIntl(value) { intl = value; updateLabels(); }, setOpenLink: open => { openLink = open; },
      setActive(value) { active = value; element.inert = !value; if (value) { scaleSlide(); queueMicrotask(() => go(current)); } refreshThumbnails(); },
      subscribeFailure(listener) { if (failure) listener(failure.error); else if (!disposed) listeners.add(listener); return () => listeners.delete(listener); } };
  } catch (error) { dispose(); throw error; }
}
