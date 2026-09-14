/** Resolve renderer-owned assets before crossing the renderer-neutral announcement contract. */
export function resolveAnnouncementMediaUrl(assetUrl: string, moduleUrl: string): string {
  const value = assetUrl.trim();
  if (value.startsWith("blob:")) return value;
  const resolved = new URL(value, moduleUrl);
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    throw new RangeError("Announcement media URL must resolve to HTTP(S) or blob");
  }
  return resolved.href;
}
