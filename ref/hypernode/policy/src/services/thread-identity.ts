export const CLOUD_THREAD_PREFIX = "☁️";

const PRESENTATION_PREFIX = /^(?:(?:🔒|✅|✍️?)\s+[^·\n]{1,80}?\s+·\s*)+/u;

export function canonicalThreadTitle(name: unknown, preview: unknown = ""): string {
  let current = typeof name === "string" ? name.trim() : "";
  // Execution ownership is connection-relative presentation state. Desktop
  // may echo a thread/name/updated value back through rename or fork flows, so
  // canonicalize at the domain boundary instead of trusting a single caller.
  for (;;) {
    const before = current;
    if (current.startsWith(CLOUD_THREAD_PREFIX)) {
      current = current.slice(CLOUD_THREAD_PREFIX.length).trim();
    }
    current = current.replace(PRESENTATION_PREFIX, "").trim();
    if (current === before) break;
  }
  const fallback = String(preview || "").trim().replace(/\s+/g, " ").slice(0, 80) || "New chat";
  return current || fallback;
}

export function cloudThreadName(name: unknown, preview: unknown = ""): string {
  return `${CLOUD_THREAD_PREFIX} ${canonicalThreadTitle(name, preview)}`;
}

export function uuidV7(): string {
  const timestamp = Date.now().toString(16).padStart(12, "0").slice(-12);
  const random = crypto.randomBytes(10);
  const variant = ((Number.parseInt(random[3] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${random.slice(0, 3)}-${variant}${random.slice(4, 7)}-${random.slice(7, 19)}`;
}
