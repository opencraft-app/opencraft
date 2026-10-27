import type { FilePreviewIntl } from "@opencraft/file-preview-web";
/** A local view owns only its transform; the adapter owns document bytes and lifetime. */
export function createSvgViewport(name: string) {
  const element = document.createElement("div"); element.className = "structured-preview";
  const toolbar = document.createElement("div"); toolbar.className = "structured-preview__toolbar";
  const viewport = document.createElement("div"); viewport.className = "structured-preview__diagram";
  viewport.tabIndex = 0; viewport.setAttribute("role", "region"); viewport.setAttribute("aria-label", name);
  const content = document.createElement("div"); content.className = "structured-preview__diagram-content";
  viewport.append(content); element.append(toolbar, viewport);
  const percentage = document.createElement("span"); percentage.setAttribute("aria-live", "polite");
  let scale = 1, x = 0, y = 0, width = 1, height = 1, disposed = false, fitted = true;
  const pointers = new Map<number, { x: number; y: number }>();
  const paint = () => { content.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; percentage.textContent = `${Math.round(scale * 100)}%`; };
  const fit = () => {
    if (disposed || viewport.clientWidth <= 0 || viewport.clientHeight <= 0) return;
    fitted = true;
    scale = Math.max(0.01, Math.min(1, (viewport.clientWidth - 32) / width, (viewport.clientHeight - 32) / height));
    x = (viewport.clientWidth - width * scale) / 2; y = (viewport.clientHeight - height * scale) / 2; paint();
  };
  const zoom = (ratio: number, px = viewport.clientWidth / 2, py = viewport.clientHeight / 2) => {
    fitted = false;
    const next = Math.min(8, Math.max(0.01, scale * ratio)), change = next / scale;
    x = px - (px - x) * change; y = py - (py - y) * change; scale = next; paint();
  };
  const translations: Array<{ control: HTMLButtonElement; id: string; defaultMessage: string }> = [];
  const button = (text: string, label: string, id: string, action: () => void) => {
    const control = document.createElement("button"); control.type = "button"; control.textContent = text;
    control.setAttribute("aria-label", label); control.title = label; control.onclick = action; toolbar.append(control); translations.push({ control, id, defaultMessage: label });
  };
  button("−", "Zoom out", "pdf.zoomOut", () => zoom(1 / 1.25)); button("+", "Zoom in", "pdf.zoomIn", () => zoom(1.25)); button("↔", "Fit diagram", "preview.fitDiagram", fit); toolbar.append(percentage);
  viewport.addEventListener("keydown", event => {
    if (["+", "=", "-", "0", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) event.preventDefault();
    if (event.key === "+" || event.key === "=") zoom(1.25);
    else if (event.key === "-") zoom(1 / 1.25);
    else if (event.key === "0") fit();
    else if (event.key.startsWith("Arrow")) { fitted = false; x += event.key === "ArrowLeft" ? 32 : event.key === "ArrowRight" ? -32 : 0; y += event.key === "ArrowUp" ? 32 : event.key === "ArrowDown" ? -32 : 0; paint(); }
  });
  viewport.addEventListener("wheel", event => {
    event.preventDefault(); const box = viewport.getBoundingClientRect();
    zoom(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.002), event.clientX - box.left, event.clientY - box.top);
  }, { passive: false });
  viewport.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); viewport.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  });
  viewport.addEventListener("pointermove", event => {
    const previous = pointers.get(event.pointerId); if (!previous) return;
    fitted = false;
    const other = [...pointers].find(([id]) => id !== event.pointerId)?.[1];
    if (other) {
      const oldDistance = Math.hypot(previous.x - other.x, previous.y - other.y);
      const nextDistance = Math.hypot(event.clientX - other.x, event.clientY - other.y);
      const box = viewport.getBoundingClientRect();
      if (oldDistance > 0) zoom(nextDistance / oldDistance, (previous.x + other.x) / 2 - box.left, (previous.y + other.y) / 2 - box.top);
      x += (event.clientX - previous.x) / 2; y += (event.clientY - previous.y) / 2;
    } else { x += event.clientX - previous.x; y += event.clientY - previous.y; }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); paint();
  });
  const release = (event: PointerEvent) => { pointers.delete(event.pointerId); };
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) viewport.addEventListener(type, release as EventListener);
  const observer = new ResizeObserver(() => { if (fitted) fit(); }); observer.observe(viewport);
  return {
    element,
    setIntl(intl: FilePreviewIntl) { for (const { control, ...message } of translations) { const label = intl.formatMessage(message); control.title = label; control.setAttribute("aria-label", label); } },
    setSvg(svg: SVGSVGElement) {
      if (disposed) return;
      const box = svg.viewBox.baseVal;
      width = box.width || Number.parseFloat(svg.getAttribute("width") ?? "") || 1;
      height = box.height || Number.parseFloat(svg.getAttribute("height") ?? "") || 1;
      svg.setAttribute("width", String(width)); svg.setAttribute("height", String(height));
      svg.style.maxWidth = "none"; svg.style.width = `${width}px`; svg.style.height = `${height}px`;
      content.replaceChildren(svg); if (fitted) fit();
    },
    dispose() { disposed = true; pointers.clear(); observer.disconnect(); element.remove(); element.replaceChildren(); },
  };
}
