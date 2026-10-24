/** Capabilities of the trusted, packaged mobile container; never a product identity. */
export const MOBILE_CONTAINER_VERSION = 1 as const;
export const MOBILE_CONTAINER_ORIGIN = "https://opencraft.invalid";
export interface MobileContainerIdentity {
  readonly version: typeof MOBILE_CONTAINER_VERSION;
  readonly runtimeId: string;
}
export type MobileContainerRequest = MobileContainerIdentity & (
  | { readonly type: "ready" }
  | { readonly type: "navigation"; readonly canGoBack: boolean }
  | { readonly type: "external"; readonly url: string }
);
export type MobileContainerEvent = MobileContainerIdentity & (
  | { readonly type: "back" }
  | { readonly type: "visibility"; readonly active: boolean }
);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export function isMobileContainerIdentity(value: unknown): value is MobileContainerIdentity {
  return record(value) && value.version === MOBILE_CONTAINER_VERSION
    && typeof value.runtimeId === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value.runtimeId);
}
export function externalMobileUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:", "tel:"].includes(url.protocol)
      && !url.username && !url.password && url.origin !== MOBILE_CONTAINER_ORIGIN ? url.href : null;
  } catch { return null; }
}
export function mobileNavigationDisposition(url: string, isTopFrame: boolean, initial: boolean): "allow" | "external" | "reject" {
  if (!isTopFrame) return ["about:blank", "about:srcdoc"].includes(url) || url.startsWith("blob:") || url.startsWith("data:") ? "allow" : "reject";
  if (initial && ["about:blank", MOBILE_CONTAINER_ORIGIN + "/"].includes(url)) return "allow";
  return externalMobileUrl(url) ? "external" : "reject";
}
export function parseMobileContainerRequest(raw: string, runtimeId: string): MobileContainerRequest | null {
  if (raw.length > 16384) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isMobileContainerIdentity(value) || value.runtimeId !== runtimeId || !record(value)) return null;
    if (value.type === "ready") return { version: value.version, runtimeId: value.runtimeId, type: "ready" };
    if (value.type === "navigation" && typeof value.canGoBack === "boolean") return { version: value.version, runtimeId: value.runtimeId, type: "navigation", canGoBack: value.canGoBack };
    if (value.type === "external" && typeof value.url === "string" && externalMobileUrl(value.url)) return { version: value.version, runtimeId: value.runtimeId, type: "external", url: value.url };
  } catch { /* Unknown messages never reach native capabilities. */ }
  return null;
}
export function isMobileContainerEvent(value: unknown, runtimeId: string): value is MobileContainerEvent {
  return isMobileContainerIdentity(value) && value.runtimeId === runtimeId && record(value)
    && (value.type === "back" || (value.type === "visibility" && typeof value.active === "boolean"));
}
