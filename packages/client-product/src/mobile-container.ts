/** Capabilities of the trusted, packaged mobile container; never a product identity. */
export const MOBILE_CONTAINER_VERSION = 1 as const;
export const MOBILE_CONTAINER_ORIGIN = "https://opencraft.invalid";
export interface MobileContainerCapabilities {
  readonly valdi?: boolean;
}
export interface MobileContainerIdentity {
  readonly version: typeof MOBILE_CONTAINER_VERSION;
  readonly runtimeId: string;
  readonly capabilities?: MobileContainerCapabilities;
}
export interface MobileContainerTransport {
  postMessage(raw: string): void;
}
export interface MobileActionSheetItem {
  readonly id: string;
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
}
export type MobileContainerRequest = MobileContainerIdentity & (
  | { readonly type: "ready" }
  | { readonly type: "source-settings" }
  | { readonly type: "startup-error" }
  | { readonly type: "reload" }
  | { readonly type: "resource"; readonly requestId: string; readonly resourceId: string }
  | { readonly type: "navigation"; readonly canGoBack: boolean }
  | { readonly type: "external"; readonly url: string }
  | { readonly type: "appearance"; readonly resolvedTheme: "light" | "dark"; readonly edgeBackgroundColor: string }
  | { readonly type: "surface-state"; readonly surface: "welcome" | "workbench" }
  | { readonly type: "haptic"; readonly style: "selection" | "light" | "warning" }
  | {
      readonly type: "confirm-dialog";
      readonly requestId: string;
      readonly title: string;
      readonly message?: string;
      readonly confirmLabel: string;
      readonly cancelLabel: string;
      readonly destructive?: boolean;
    }
  | {
      readonly type: "action-sheet";
      readonly requestId: string;
      readonly title?: string;
      readonly message?: string;
      readonly cancelLabel: string;
      readonly actions: readonly MobileActionSheetItem[];
    }
);
export type MobileContainerEvent = MobileContainerIdentity & (
  | { readonly type: "back" }
  | { readonly type: "visibility"; readonly active: boolean }
  | { readonly type: "navigate-settings"; readonly section: string }
  | { readonly type: "theme-preference"; readonly preference: "light" | "dark" | "system" }
  | { readonly type: "confirm-dialog-result"; readonly requestId: string; readonly confirmed: boolean }
  | { readonly type: "action-sheet-result"; readonly requestId: string; readonly actionId: string | null }
);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const validRequestId = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,8}$/.test(value);
const validShortText = (value: unknown, max = 240): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const validOptionalText = (value: unknown, max = 600): value is string | undefined =>
  value === undefined || (typeof value === "string" && value.length <= max);

export function isMobileContainerCapabilities(value: unknown): value is MobileContainerCapabilities {
  return record(value) && (value.valdi === undefined || typeof value.valdi === "boolean");
}
export function isMobileContainerIdentity(value: unknown): value is MobileContainerIdentity {
  return record(value) && value.version === MOBILE_CONTAINER_VERSION
    && typeof value.runtimeId === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value.runtimeId)
    && (value.capabilities === undefined || isMobileContainerCapabilities(value.capabilities));
}
export function resolveMobileContainerTransport(target: unknown): MobileContainerTransport | null {
  if (!record(target)) return null;
  for (const key of ["opencraftMobileHost", "ReactNativeWebView"] as const) {
    const candidate = target[key];
    if (record(candidate) && typeof candidate.postMessage === "function") {
      return { postMessage: (raw: string) => (candidate.postMessage as (message: string) => void).call(candidate, raw) };
    }
  }
  return null;
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
    const base = {
      version: value.version,
      runtimeId: value.runtimeId,
      ...(value.capabilities ? { capabilities: { ...(value.capabilities.valdi === undefined ? {} : { valdi: value.capabilities.valdi }) } } : {}),
    };
    if (value.type === "ready") return { ...base, type: "ready" };
    if (value.type === "source-settings" || value.type === "startup-error" || value.type === "reload") return { ...base, type: value.type };
    if (value.type === "resource" && validRequestId(value.requestId)
      && typeof value.resourceId === "string" && /^[a-f0-9]{64}$/.test(value.resourceId)) {
      return { ...base, type: "resource", requestId: value.requestId, resourceId: value.resourceId };
    }
    if (value.type === "navigation" && typeof value.canGoBack === "boolean") return { ...base, type: "navigation", canGoBack: value.canGoBack };
    if (value.type === "external" && typeof value.url === "string" && externalMobileUrl(value.url)) return { ...base, type: "external", url: value.url };
    if (value.type === "appearance" && (value.resolvedTheme === "light" || value.resolvedTheme === "dark") && typeof value.edgeBackgroundColor === "string"
      && /^(?:#(?:[a-fA-F0-9]{3}|[a-fA-F0-9]{4}|[a-fA-F0-9]{6}|[a-fA-F0-9]{8})|rgba?\([\d\s.,%]+\))$/u.test(value.edgeBackgroundColor) && value.edgeBackgroundColor.length <= 100) {
      return { ...base, type: "appearance", resolvedTheme: value.resolvedTheme, edgeBackgroundColor: value.edgeBackgroundColor };
    }
    if (value.type === "haptic" && (value.style === "selection" || value.style === "light" || value.style === "warning")) {
      return { ...base, type: "haptic", style: value.style };
    }
    if (value.type === "surface-state" && (value.surface === "welcome" || value.surface === "workbench")) {
      return { ...base, type: "surface-state", surface: value.surface };
    }
    if (value.type === "confirm-dialog" && validRequestId(value.requestId)
      && validShortText(value.title) && validOptionalText(value.message)
      && validShortText(value.confirmLabel, 80) && validShortText(value.cancelLabel, 80)
      && (value.destructive === undefined || typeof value.destructive === "boolean")) {
      return {
        ...base,
        type: "confirm-dialog",
        requestId: value.requestId,
        title: value.title,
        ...(value.message === undefined ? {} : { message: value.message }),
        confirmLabel: value.confirmLabel,
        cancelLabel: value.cancelLabel,
        ...(value.destructive === undefined ? {} : { destructive: value.destructive }),
      };
    }
    if (value.type === "action-sheet" && validRequestId(value.requestId)
      && validOptionalText(value.title, 240) && validOptionalText(value.message)
      && validShortText(value.cancelLabel, 80)
      && Array.isArray(value.actions) && value.actions.length >= 1 && value.actions.length <= 16) {
      const actions: MobileActionSheetItem[] = [];
      for (const item of value.actions) {
        if (!record(item) || !validShortText(item.id, 80) || !validShortText(item.label, 120)
          || (item.destructive !== undefined && typeof item.destructive !== "boolean")
          || (item.disabled !== undefined && typeof item.disabled !== "boolean")) {
          return null;
        }
        actions.push({
          id: item.id,
          label: item.label,
          ...(item.destructive === undefined ? {} : { destructive: item.destructive }),
          ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
        });
      }
      return {
        ...base,
        type: "action-sheet",
        requestId: value.requestId,
        ...(value.title === undefined ? {} : { title: value.title }),
        ...(value.message === undefined ? {} : { message: value.message }),
        cancelLabel: value.cancelLabel,
        actions,
      };
    }
  } catch { /* Unknown messages never reach native capabilities. */ }
  return null;
}
export function isMobileContainerEvent(value: unknown, runtimeId: string): value is MobileContainerEvent {
  if (!isMobileContainerIdentity(value) || value.runtimeId !== runtimeId || !record(value)) return false;
  if (value.type === "back") return true;
  if (value.type === "visibility") return typeof value.active === "boolean";
  if (value.type === "navigate-settings") return validShortText(value.section, 80);
  if (value.type === "theme-preference") {
    return value.preference === "light" || value.preference === "dark" || value.preference === "system";
  }
  if (value.type === "confirm-dialog-result") return validRequestId(value.requestId) && typeof value.confirmed === "boolean";
  if (value.type === "action-sheet-result") {
    return validRequestId(value.requestId) && (value.actionId === null || validShortText(value.actionId, 80));
  }
  return false;
}
