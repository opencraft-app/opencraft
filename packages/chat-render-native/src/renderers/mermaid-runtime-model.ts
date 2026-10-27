export { parseEmbeddedRenderMessage as parseMermaidRuntimeMessage } from "./embedded-rich-render-message";

/** Keep the transcript preview bounded; the full viewer owns diagram panning. */
export function nativeMermaidPreviewHeight(containerWidth: number, naturalWidth: number, naturalHeight: number): number {
  if (!(containerWidth > 0 && naturalWidth > 0 && naturalHeight > 0)) return 240;
  return Math.max(96, Math.min(480, Math.ceil(containerWidth * naturalHeight / naturalWidth)));
}
