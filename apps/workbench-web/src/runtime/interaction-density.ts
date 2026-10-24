import type { UiPreferencesRuntime } from "@opencraft/ui-preferences";

/** One installation preference owns density; modality still owns hover/focus. */
export function bindInteractionDensity(document: Document, preferences: UiPreferencesRuntime): () => void {
  const capability = document.defaultView!.matchMedia("(any-pointer: coarse)");
  const update = () => {
    const values = preferences.getSnapshot().values;
    const choice = values["interface.touchFriendly"];
    document.documentElement.dataset.touchNewera = values["chat.touchNewera"] ? "on" : "off";
    document.documentElement.dataset.uiDensity = choice === "on" || (choice === "auto" && capability.matches) ? "touch" : "compact";
  };
  const unsubscribe = preferences.subscribe(update);
  capability.addEventListener("change", update);
  update();
  return () => {
    unsubscribe();
    capability.removeEventListener("change", update);
    delete document.documentElement.dataset.uiDensity;
    delete document.documentElement.dataset.touchNewera;
  };
}
