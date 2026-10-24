import { bindPreviewLinks, FilePreviewError, type WebPreviewDocument } from "@opencraft/file-preview-web";
import { createPaperViewport } from "./paper-viewport";
import { validateOfficeArchive } from "./archive";
import "./preview.web.scss";

export async function openOfficeDocument(input: { blob: Blob; name: string; signal: AbortSignal }): Promise<WebPreviewDocument> {
  const buffer = await input.blob.arrayBuffer();
  input.signal.throwIfAborted();
  const kind = input.name.split(".").at(-1)!.toLowerCase();
  if (kind === "xls" || kind === "doc") {
    const bytes = new Uint8Array(buffer);
    const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    if (!signature.every((value, index) => bytes[index] === value)) throw new FilePreviewError("invalid");
  } else {
    try { validateOfficeArchive(buffer, kind); } catch (error) {
      if (error instanceof FilePreviewError) throw error;
      throw new FilePreviewError("invalid");
    }
  }
  input.signal.throwIfAborted();
  if (kind === "doc") {
    const { openLegacyWord } = await import("./legacy-word");
    input.signal.throwIfAborted();
    return openLegacyWord(buffer, input.name, input.signal);
  }
  if (kind === "xlsx" || kind === "xls" || kind === "xlsm") {
    const { openSpreadsheet } = await import("./spreadsheet");
    input.signal.throwIfAborted();
    return openSpreadsheet(buffer, input.name, input.signal);
  }
  if (kind === "pptx") {
    const { openPresentation } = await import("./presentation");
    input.signal.throwIfAborted();
    return openPresentation(buffer, input.signal);
  }
  const paper = kind === "docx" ? createPaperViewport("docx") : null;
  const element = paper?.element ?? document.createElement("div");
  if (!paper) element.className = `office-preview office-preview--${kind}`;
  let openLink: ((url: string) => void) | undefined;
  const unbindLinks = bindPreviewLinks(element, () => openLink);
  let disposed = false;
  const cleanups: Array<() => void> = [unbindLinks, () => paper?.dispose()];
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups.reverse()) cleanup();
    element.remove(); element.replaceChildren();
  };
  try {
    if (kind === "docx") {
      const { renderAsync } = await import("docx-preview");
      input.signal.throwIfAborted();
      const style = document.createElement("div");
      const content = document.createElement("div");
      content.className = "office-preview__pages";
      content.style.color = "#000"; content.style.colorScheme = "light";
      paper!.content.append(style, content);
      const className = `office-docx-${crypto.randomUUID()}`;
      // This engine cannot physically cancel parsing. Its detached container
      // is published only if this attempt still owns the result.
      await renderAsync(buffer, content, style, { className, breakPages: true, inWrapper: true,
        ignoreWidth: false, ignoreHeight: false, ignoreLastRenderedPageBreak: true,
        renderAltChunks: false, renderComments: false, renderChanges: false, useBase64URL: true });
      input.signal.throwIfAborted();
      const pages = content.querySelector<HTMLElement>(`.${className}-wrapper`);
      if (pages) { pages.style.padding = "0"; pages.style.background = "transparent"; pages.style.width = "max-content"; }
      paper!.refresh();
      return { element, dispose, setIntl: paper!.setIntl, setOpenLink: open => { openLink = open; }, setActive: active => { element.inert = !active; if (active) paper!.refresh(); } };
    }
    throw new FilePreviewError("invalid");
  } catch (error) { dispose(); throw error; }
}
