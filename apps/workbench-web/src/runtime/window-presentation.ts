import { isMobileContainerIdentity, resolveMobileContainerTransport } from "@opencraft/client-product/mobile-container";

/** Display mode is independent of the native host and desktop control geometry. */
export interface WindowPresentation {
  readonly host: "browser" | "electron" | "native-container" | "embedded";
  readonly displayMode: "tab" | "standalone" | "fullscreen";
  readonly appearanceControl: "document-and-hint" | "native-bridge" | "host-owned";
}
export function resolveWindowPresentation(input: {
  readonly host?: WindowPresentation["host"];
  readonly standalone?: boolean;
  readonly fullscreen?: boolean;
}): WindowPresentation {
  const host = input.host ?? "browser";
  return {
    host,
    displayMode: input.fullscreen ? "fullscreen" : input.standalone ? "standalone" : "tab",
    appearanceControl: host === "electron" ? "native-bridge" : host === "browser" ? "document-and-hint" : "host-owned",
  };
}
export function readWindowPresentation(view: Window): WindowPresentation {
  const bridge = view as Window & { opencraftDesktop?: { kind?: string }; opencraftMobile?: unknown };
  const media = (query: string) => view.matchMedia?.(query).matches ?? false;
  return resolveWindowPresentation({
    host: view.top !== view ? "embedded" : bridge.opencraftDesktop?.kind === "electron" ? "electron"
      : isMobileContainerIdentity(bridge.opencraftMobile) && resolveMobileContainerTransport(bridge) !== null ? "native-container" : "browser",
    standalone: (view.navigator as Navigator & { standalone?: boolean }).standalone === true || media("(display-mode: standalone)"),
    fullscreen: media("(display-mode: fullscreen)"),
  });
}

export type ClientRuntimeKind = "web" | "pwa" | "electron";

export function resolveClientRuntimeKind(view: Window): ClientRuntimeKind {
  const presentation = readWindowPresentation(view);
  if (presentation.host === "electron") return "electron";
  const standalone = (view.navigator as Navigator & { standalone?: boolean }).standalone === true
    || view.matchMedia?.("(display-mode: standalone)").matches === true;
  return presentation.host === "browser" && standalone ? "pwa" : "web";
}
