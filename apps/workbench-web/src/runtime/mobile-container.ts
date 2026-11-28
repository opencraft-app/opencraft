import {
  isMobileContainerIdentity,
  isMobileContainerEvent,
  externalMobileUrl,
  resolveMobileContainerTransport,
  type MobileContainerIdentity,
  type MobileContainerRequest,
} from "@opencraft/client-product/mobile-container";
import type { ApplicationNavigation } from "./workbench-navigation";
import type { WorkbenchLocation } from "@opencraft/workbench-runtime";

interface MobileWindow extends Window {
  readonly opencraftMobile?: MobileContainerIdentity;
  readonly opencraftMobileHost?: { postMessage(raw: string): void };
  readonly ReactNativeWebView?: { postMessage(raw: string): void };
}

export function mobileContainer(target: Window = window): MobileContainerIdentity | null {
  const host = target as MobileWindow;
  return isMobileContainerIdentity(host.opencraftMobile) && resolveMobileContainerTransport(host) !== null
    ? host.opencraftMobile! : null;
}
export function mobileContainerSupportsValdi(target: Window = window): boolean {
  return mobileContainer(target)?.capabilities?.valdi === true;
}
export function openMobileSourceSettings(target: Window = window): void {
  const identity = mobileContainer(target);
  const transport = resolveMobileContainerTransport(target);
  if (identity && transport) transport.postMessage(JSON.stringify({ ...identity, type: "source-settings" }));
}
export function reloadMobileWorkbench(target: Window = window): boolean {
  const identity = mobileContainer(target);
  const transport = resolveMobileContainerTransport(target);
  if (!identity || !transport) return false;
  transport.postMessage(JSON.stringify({ ...identity, type: "reload" }));
  return true;
}
export function reportMobileSurfaceState(
  surface: "welcome" | "workbench",
  target: Window = window,
): boolean {
  const identity = mobileContainer(target);
  const transport = resolveMobileContainerTransport(target);
  if (!identity || !transport || identity.capabilities?.valdi !== true) return false;
  transport.postMessage(JSON.stringify({ ...identity, type: "surface-state", surface }));
  return true;
}
/** Application/navigation remain in this realm. Native owns only device events. */
export function bindMobileContainer(
  navigation: ApplicationNavigation<WorkbenchLocation | null>,
  target: Window = window,
): { readonly active: () => boolean; readonly dispose: () => void } {
  const identity = mobileContainer(target);
  const transport = resolveMobileContainerTransport(target);
  if (!identity || !transport) return { active: () => true, dispose() {} };
  let active = true;
  const send = (message: MobileContainerRequest) => transport.postMessage(JSON.stringify(message));
  const publishNavigation = () => send({ ...identity, type: "navigation", canGoBack: navigation.getSnapshot().canReturn || navigation.getSnapshot().canGoBack });
  const receive = (event: Event) => {
    const value: unknown = (event as CustomEvent).detail;
    if (!isMobileContainerEvent(value, identity.runtimeId)) return;
    if (value.type === "back") { if (navigation.getSnapshot().canReturn) navigation.returnToParent(); else navigation.back(); }
    else if (value.type === "navigate-settings") { navigation.openSettings(value.section); }
    else if (value.type === "theme-preference") {
      void import("../appearance-theme").then(({ setThemePreference }) => setThemePreference(value.preference));
    }
    else if (value.type === "visibility") {
      active = value.active;
      // Existing foreground probes listen to visibility/online events; they
      // still consult the Application's presentation owner before catching up.
      target.document.dispatchEvent(new Event("visibilitychange"));
      if (active) target.dispatchEvent(new Event("online"));
    }
  };
  const click = (event: MouseEvent) => {
    const anchor = (event.target instanceof Element ? event.target : null)?.closest("a[href]");
    if (!(anchor instanceof HTMLAnchorElement) || event.defaultPrevented) return;
    const url = externalMobileUrl(anchor.href);
    if (!url) return;
    event.preventDefault();
    send({ ...identity, type: "external", url });
  };
  target.addEventListener("opencraft-mobile", receive);
  target.document.addEventListener("click", click);
  const unsubscribe = navigation.subscribe(publishNavigation);
  send({ ...identity, type: "ready" });
  publishNavigation();
  return { active: () => active, dispose() {
    unsubscribe();
    target.removeEventListener("opencraft-mobile", receive);
    target.document.removeEventListener("click", click);
  } };
}
