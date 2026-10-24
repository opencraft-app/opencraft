import { isMobileContainerIdentity, isMobileContainerEvent, externalMobileUrl, type MobileContainerIdentity, type MobileContainerRequest } from "@opencraft/client-product/mobile-container";
import type { ApplicationNavigation } from "./workbench-navigation";
import type { WorkbenchLocation } from "@opencraft/workbench-runtime";

interface MobileWindow extends Window {
  readonly opencraftMobile?: MobileContainerIdentity;
  readonly ReactNativeWebView?: { postMessage(raw: string): void };
}
export function mobileContainer(target: Window = window): MobileContainerIdentity | null {
  const host = target as MobileWindow;
  return isMobileContainerIdentity(host.opencraftMobile) && typeof host.ReactNativeWebView?.postMessage === "function"
    ? host.opencraftMobile! : null;
}
/** Application/navigation remain in this realm. Native owns only device events. */
export function bindMobileContainer(
  navigation: ApplicationNavigation<WorkbenchLocation | null>,
  target: Window = window,
): { readonly active: () => boolean; readonly dispose: () => void } {
  const identity = mobileContainer(target);
  if (!identity) return { active: () => true, dispose() {} };
  let active = true;
  const send = (message: MobileContainerRequest) => (target as MobileWindow).ReactNativeWebView!.postMessage(JSON.stringify(message));
  const publishNavigation = () => send({ ...identity, type: "navigation", canGoBack: navigation.getSnapshot().canGoBack });
  const receive = (event: Event) => {
    const value: unknown = (event as CustomEvent).detail;
    if (!isMobileContainerEvent(value, identity.runtimeId)) return;
    if (value.type === "back") navigation.back();
    else {
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
