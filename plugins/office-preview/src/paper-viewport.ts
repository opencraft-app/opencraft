import type { FilePreviewIntl } from "@opencraft/file-preview-web";

/** Paper layout stays at natural size; the retained view owns reading scale. */
export function createPaperViewport(kind: "doc" | "docx") {
  const element = document.createElement("div"); element.className = `office-preview office-preview--${kind} office-preview--paper`;
  const toolbar = document.createElement("div"); toolbar.className = "office-preview__paper-toolbar";
  const scroll = document.createElement("div"); scroll.className = "office-preview__paper-scroll";
  const frame = document.createElement("div"); frame.className = "office-preview__paper-frame";
  const content = document.createElement("div"); content.className = "office-preview__paper-content";
  frame.append(content); scroll.append(frame); element.append(toolbar, scroll);
  const percentage = document.createElement("span"); percentage.setAttribute("aria-live", "polite");
  let scale = 1, fitted = true, disposed = false;
  const controls: Array<{ button: HTMLButtonElement; id: string; defaultMessage: string }> = [];
  const paint = () => {
    frame.style.width = `${content.offsetWidth * scale}px`; frame.style.height = `${content.offsetHeight * scale}px`;
    content.style.transform = `scale(${scale})`; percentage.textContent = `${Math.round(scale * 100)}%`;
  };
  const refresh = () => {
    if (disposed || !scroll.clientWidth || !content.offsetWidth) return;
    if (fitted) scale = Math.max(0.05, Math.min(1, (scroll.clientWidth - 24) / content.offsetWidth));
    paint();
  };
  const zoom = (ratio: number) => {
    fitted = false;
    const x = (scroll.scrollLeft + scroll.clientWidth / 2) / scale;
    const y = (scroll.scrollTop + scroll.clientHeight / 2) / scale;
    scale = Math.min(4, Math.max(0.05, scale * ratio)); paint();
    scroll.scrollLeft = x * scale - scroll.clientWidth / 2; scroll.scrollTop = y * scale - scroll.clientHeight / 2;
  };
  const button = (glyph: string, id: string, defaultMessage: string, action: () => void) => {
    const button = document.createElement("button"); button.type = "button"; button.textContent = glyph;
    button.title = defaultMessage; button.setAttribute("aria-label", defaultMessage); button.onclick = action;
    controls.push({ button, id, defaultMessage }); toolbar.append(button);
  };
  button("−", "pdf.zoomOut", "Zoom out", () => zoom(1 / 1.25));
  button("+", "pdf.zoomIn", "Zoom in", () => zoom(1.25));
  button("↔", "pdf.fit", "Fit width", () => { fitted = true; refresh(); }); toolbar.append(percentage);
  const observer = new ResizeObserver(refresh); observer.observe(scroll); observer.observe(content);
  return { element, content, refresh,
    setIntl(intl: FilePreviewIntl) { for (const { button, ...message } of controls) { const text = intl.formatMessage(message); button.title = text; button.setAttribute("aria-label", text); } },
    dispose() { if (!disposed) { disposed = true; observer.disconnect(); element.remove(); } },
  };
}
