export type MobileContentSource = Readonly<{ kind: "bundled" }> | Readonly<{ kind: "self-hosted"; url: string }>;
export const BUNDLED_SOURCE: MobileContentSource = Object.freeze({ kind: "bundled" });
export const CONTENT_SOURCE_KEY = "opencraft.mobile.content-source.v1";

/** Addresses contain no secrets. Consent is expressed by saving the selected source. */
export function selfHostedSource(input: string): MobileContentSource {
  if (input.length > 2048) throw new Error("source.invalid");
  const url = new URL(input.trim());
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("source.invalid");
  }
  return { kind: "self-hosted", url: url.href };
}

export function decodeContentSource(raw: string | null): MobileContentSource {
  if (raw === null) return BUNDLED_SOURCE;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("kind" in value)) throw new Error("source.invalid");
  if (value.kind === "bundled") return BUNDLED_SOURCE;
  if (value.kind === "self-hosted" && "url" in value && typeof value.url === "string") return selfHostedSource(value.url);
  throw new Error("source.invalid");
}

export function encodeContentSource(source: MobileContentSource): string {
  return JSON.stringify({ version: 1, ...source });
}

/** Remote sites never acquire the packaged document's privileged origin/bridge. */
export function isSelfHostedNavigation(source: MobileContentSource, input: string): boolean {
  if (source.kind !== "self-hosted") return false;
  try {
    const url = new URL(input);
    return url.protocol === "https:" && !url.username && !url.password && url.origin === new URL(source.url).origin;
  } catch { return false; }
}
