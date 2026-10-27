import type { WebContents } from "electron";
import type { BrowserPermissionPolicy } from "./browser-permissions.js";
export interface BrowserGuestServices {
  permissions: BrowserPermissionPolicy;
  open(guestId: number, url: string, background: boolean): void;
}

export function isBrowserGuestUrl(input: string): boolean {
  if (input === "about:blank") return true;
  try { const url = new URL(input); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}

/** Main is the security authority; guest attributes are untrusted input. */
export function installBrowserGuests(owner: WebContents, services?: BrowserGuestServices) {
  const guests = new Map<number, { guest: WebContents; partition: string }>();
  const pointerTracking = new Map<number, string>();
  owner.on("will-attach-webview", (event, preferences, params) => {
    if (!/^persist:opencraft-browser:browser-[a-zA-Z0-9-]+$/.test(params.partition ?? "")
      || !isBrowserGuestUrl(params.src || "about:blank")) {
      event.preventDefault();
      return;
    }
    delete preferences.preload;
    Object.assign(preferences, {
      nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false,
    });
  });
  owner.on("did-attach-webview", (_event, guest) => {
    let documentGeneration = 0;
    guest.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) documentGeneration++;
    });
    // Session identity comes from the actual guest, never a caller-supplied partition.
    const partition = guest.session.getStoragePath() ?? `memory:${guest.id}`;
    guests.set(guest.id, { guest, partition });
    guest.once("destroyed", () => { guests.delete(guest.id); pointerTracking.delete(guest.id); });
    guest.on("before-mouse-event", (_event, input) => {
      const trackingId = pointerTracking.get(guest.id);
      if (trackingId && !owner.isDestroyed() && ["mouseMove", "mouseLeave"].includes(input.type))
        owner.send("opencraft:browser-pointer", { guestId: guest.id, trackingId, x: input.x, y: input.y, leave: input.type === "mouseLeave" });
    });
    guest.session.setPermissionRequestHandler((contents, permission, callback, details) => {
      const owned = contents && guests.get(contents.id);
      if (!owned || !services) { callback(false); return; }
      let origin: string;
      try { origin = new URL(contents.getURL()).origin; } catch { callback(false); return; }
      const requesting = (details as { requestingUrl?: string }).requestingUrl;
      try { if (!origin.startsWith("http") || requesting && new URL(requesting).origin !== origin) { callback(false); return; } }
      catch { callback(false); return; }
      const kinds = permission === "media"
        ? ((details as { mediaTypes?: string[] }).mediaTypes ?? []).map(type => type === "video" ? "camera" : type === "audio" ? "microphone" : "unsupported")
        : [permission];
      const generation = documentGeneration;
      const valid = () => {
        try { return generation === documentGeneration && !contents.isDestroyed() && guests.has(contents.id) && new URL(contents.getURL()).origin === origin; } catch { return false; }
      };
      if (!kinds.length) { callback(false); return; }
      void Promise.all(kinds.map(kind => services.permissions.request(partition, origin, kind, valid)))
        .then(results => callback(valid() && results.every(Boolean)), () => callback(false));
    });
    guest.session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      if (!contents || !guests.has(contents.id) || !services) return false;
      try {
        const origin = new URL(contents.getURL()).origin;
        if (new URL(requestingOrigin).origin !== origin) return false;
        const mediaType = (details as { mediaType?: string }).mediaType;
        const kind = permission === "media" ? mediaType === "video" ? "camera" : mediaType === "audio" ? "microphone" : "unsupported" : permission;
        return services.permissions.check(partition, origin, kind);
      } catch { return false; }
    });
    guest.on("will-attach-webview", event => event.preventDefault());
    guest.on("will-navigate", (event, url) => { if (!isBrowserGuestUrl(url)) event.preventDefault(); });
    guest.on("will-redirect", (event, url) => { if (!isBrowserGuestUrl(url)) event.preventDefault(); });
    guest.setWindowOpenHandler(({ url, disposition }) => {
      if (isBrowserGuestUrl(url) && url !== "about:blank" && !guest.isDestroyed())
        services?.open(guest.id, url, disposition === "background-tab");
      return { action: "deny" };
    });
  });
  return {
    trackPointer(id: number, trackingId: string, enabled: boolean) {
      if (enabled) {
        if (!guests.has(id)) throw new Error("Browser page is no longer available");
        pointerTracking.set(id, trackingId);
      } else if (pointerTracking.get(id) === trackingId) pointerTracking.delete(id);
    },
    require(id: number) {
      const entry = guests.get(id);
      if (!entry || entry.guest.isDestroyed()) throw new Error("Browser page is no longer available");
      return entry;
    },
  };
}
