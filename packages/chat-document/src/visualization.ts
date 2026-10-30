import type { TokenizerExtension } from "marked";

const marker = "\uE200visualize\uE202";
/** Assistant-only standalone content reference; code samples remain literal. */
export const visualizationTokenizer: TokenizerExtension = {
  name: "visualization",
  level: "block",
  start(source) {
    const found = source.indexOf(`\n${marker}`);
    return found < 0 ? undefined : found + 1;
  },
  tokenizer(source) {
    if (!source.startsWith(marker)) return undefined;
    const end = source.indexOf("\uE201", marker.length);
    if (end < 0 || end > 16384) return undefined;
    const rest = source.slice(end + 1);
    if (rest && !/^[ \t]*(?:\r?\n|$)/u.test(rest)) return undefined;
    try {
      const value: unknown = JSON.parse(source.slice(marker.length, end));
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const { path, mode, title } = value as Record<string, unknown>;
      if (typeof path !== "string" || path.length > 8192
        || !/^(?:\/(?!\/)|[a-z]:[\\/])[^\0\r\n]*\.html?$/iu.test(path)
        || (mode !== undefined && mode !== "wide")
        || (title !== undefined && (typeof title !== "string" || title.length > 250))) return undefined;
      return { type: "visualization", raw: source.slice(0, end + 1), path,
        mode: mode ?? "inline", title: title ?? "" };
    } catch { return undefined; }
  },
};
