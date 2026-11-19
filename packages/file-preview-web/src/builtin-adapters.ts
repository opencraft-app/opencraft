import type { FilePreviewAdapter } from "./index";
export const builtinPreviewAdapters: readonly FilePreviewAdapter[] = [
  {id:"pdf.readonly",extensions:["pdf"],async open(input) { const {openPdf} = await import("./pdf"); input.signal.throwIfAborted(); return openPdf(input); }},
  {id:"media.readonly",extensions:["mp3","wav","ogg","m4a","aac","flac","opus","mp4","webm","mov","m4v","ogv","mkv","avi"],async open(input) { const {openMedia} = await import("./media-document"); input.signal.throwIfAborted(); return openMedia(input); }},
];
