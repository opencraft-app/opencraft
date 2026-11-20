import type { BrowserAnnotator } from "@opencraft/browser-core";
import type { AnnotatableGuest, createGuestAnnotator } from "./guest-annotator";

type GuestAnnotator = ReturnType<typeof createGuestAnnotator>;

/** The page agent is optional desktop work, not a Workbench startup dependency. */
export function createDeferredGuestAnnotator(guest: AnnotatableGuest): GuestAnnotator {
  let pending: Promise<GuestAnnotator> | undefined;
  let loaded: GuestAnnotator | undefined;
  let disposed = false;
  const load = () => {
    if (disposed) return Promise.reject(new Error("Browser page closed"));
    return pending ??= import("./guest-annotator").then(module => {
      if (disposed) throw new Error("Browser page closed");
      loaded = module.createGuestAnnotator(guest);
      return loaded;
    }).catch(error => { pending = undefined; throw error; });
  };
  const annotator: BrowserAnnotator = {
    capabilities: { region: true, text: true, multiSelect: true, styles: true, capture: true, preview: false, sameOriginFrames: true, openShadow: true },
    pickRegion: input => load().then(value => value.pickRegion!(input)),
    pickText: input => load().then(value => value.pickText!(input)),
    readStyles: anchor => load().then(value => value.readStyles!(anchor)),
    preview: input => load().then(value => value.preview!(input)),
    clearPreview: () => !pending ? Promise.resolve() : load().then(value => value.clearPreview!()),
    hitMark: point => load().then(value => value.hitMark?.(point) ?? []),
    pick: input => load().then(value => value.pick(input)),
    mark: (boxes, color) => !pending && boxes.length === 0 ? Promise.resolve() : load().then(value => value.mark(boxes, color)),
    capture: () => load().then(value => value.capture()),
    reveal: fraction => load().then(value => value.reveal?.(fraction)),
    intercept: handlers => {
      let released = false;
      let release: (() => void) | undefined;
      void load().then(value => { if (!released && !disposed) release = value.intercept(handlers); }).catch(() => undefined);
      return () => { released = true; release?.(); };
    },
  };
  return {
    ...annotator,
    refresh: () => loaded?.refresh(),
    dispose: () => { disposed = true; loaded?.dispose(); },
  };
}
