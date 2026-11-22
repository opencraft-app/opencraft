export type MobileContentSource = Readonly<{ kind: "bundled" }> | Readonly<{ kind: "self-hosted"; url: string }>;
type SelfHostedAuthentication = Readonly<{ siteOrigin: string; authOrigin: string }>;
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

function httpsNavigationOrigin(input: string): string | undefined {
  // Parse just the authority. The React Native URL implementation can mistake
  // an @ in the path or query for URL credentials.
  const authority = /^https:\/\/([^/?#\\@\s]+)(?:[/?#]|$)/i.exec(input)?.[1];
  if (!authority) return undefined;
  try {
    return new URL(`https://${authority.toLowerCase().replace(/:0*443$/, "")}/`).origin;
  } catch {
    return undefined;
  }
}

function parseHttpsOrigin(input: string | undefined): string | undefined {
  const value = input?.trim();
  if (value && /^https:\/\/[^/?#]+\/?$/i.test(value)) return httpsNavigationOrigin(value);
}

export function selfHostedAuthentication(site: string | undefined, auth: string | undefined): SelfHostedAuthentication | undefined {
  const siteOrigin = parseHttpsOrigin(site);
  const authOrigin = parseHttpsOrigin(auth);
  if (siteOrigin && authOrigin && siteOrigin !== authOrigin) return { siteOrigin, authOrigin };
  return undefined;
}

/** Remote sites never acquire the packaged document's privileged origin/bridge. */
export function isSelfHostedNavigation(source: MobileContentSource, input: string, authentication?: SelfHostedAuthentication): boolean {
  if (source.kind !== "self-hosted") return false;
  const origin = httpsNavigationOrigin(input);
  if (!origin) return false;
  const sourceOrigin = httpsNavigationOrigin(source.url);
  return origin === sourceOrigin || (authentication?.siteOrigin === sourceOrigin && origin === authentication?.authOrigin);
}
