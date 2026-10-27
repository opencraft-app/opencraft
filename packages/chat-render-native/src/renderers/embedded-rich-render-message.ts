export type EmbeddedRenderMessage =
  | { readonly type: "ready" }
  | { readonly type: "failed"; readonly revision: number }
  | { readonly type: "rendered"; readonly revision: number; readonly width: number; readonly height: number };

/** The isolated document returns only a revision and bounded geometry. */
export function parseEmbeddedRenderMessage(data: string): EmbeddedRenderMessage | null {
  let value: unknown;
  try { value = JSON.parse(data); } catch { return null; }
  if (value === null || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.type === "ready") return { type: "ready" };
  if ((message.type !== "failed" && message.type !== "rendered")
    || typeof message.revision !== "number" || !Number.isSafeInteger(message.revision) || message.revision < 1) return null;
  if (message.type === "failed") return { type: "failed", revision: message.revision };
  if (typeof message.width !== "number" || typeof message.height !== "number"
    || !Number.isFinite(message.width) || !Number.isFinite(message.height)
    || message.width <= 0 || message.height <= 0
    || message.width > 100_000 || message.height > 100_000) return null;
  return { type: "rendered", revision: message.revision, width: message.width, height: message.height };
}
