export type ChatFileAppearance = "code" | "image" | "spreadsheet" | "archive" | "audio" | "video" | "folder" | "document";

/** Display metadata only; the original target remains the navigation authority. */
export function chatFilePresentation(target: string, label?: string): {
  readonly name: string; readonly location: string; readonly appearance: ChatFileAppearance;
} {
  let path = target;
  if (/^(?:file|https?):\/\//iu.test(path)) {
    try { const url = new URL(path); path = url.pathname + url.hash; } catch { /* Keep the original label. */ }
  }
  const located = /(?::(\d+)(?::\d+)?(?:[-–](\d+))?|#L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?)$/u.exec(path);
  const start = located?.[1] ?? located?.[3], end = located?.[2] ?? located?.[4];
  const location = start ? `L${start}${end ? `–${end}` : ""}` : "";
  if (located) path = path.slice(0, located.index);
  try { path = decodeURIComponent(path); } catch { /* A malformed escape is still readable text. */ }
  const filename = basename(path);
  const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
  const appearance: ChatFileAppearance = /[\\/]$/u.test(path) ? "folder"
    : /^(?:tsx?|jsx?|m?[cj]s|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sh|bash|zsh|css|scss|html?|json|ya?ml|toml|sql|vue|svelte|ipynb)$/u.test(extension) ? "code"
    : /^(?:png|jpe?g|gif|webp|avif|svg|bmp|ico|heic)$/u.test(extension) ? "image"
    : /^(?:csv|tsv|xlsx?|ods)$/u.test(extension) ? "spreadsheet"
    : /^(?:zip|tar|gz|tgz|bz2|xz|7z|rar)$/u.test(extension) ? "archive"
    : /^(?:mp3|wav|ogg|m4a|flac|aac)$/u.test(extension) ? "audio"
    : /^(?:mp4|webm|mov|mkv|avi)$/u.test(extension) ? "video" : "document";
  const meaningfulLabel = label?.trim();
  const isPathLabel = meaningfulLabel && ((/[\\/]/u.test(meaningfulLabel) && !/\s/u.test(meaningfulLabel)) || /^(?:file:|\/(?!\/)|[a-z]:[\\/])/iu.test(meaningfulLabel)
    || meaningfulLabel === target || meaningfulLabel === `@${target}`
    || (start !== undefined && meaningfulLabel.replace(/(?::\d+(?::\d+)?(?:[-–]\d+)?|#L\d+(?:-L\d+)?)$/u, "") === filename));
  return { name: meaningfulLabel && !isPathLabel ? meaningfulLabel : filename || target, location, appearance };
}


function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path;
}
