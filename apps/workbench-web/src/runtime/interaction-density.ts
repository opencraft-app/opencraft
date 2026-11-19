import type { UiPreferencesRuntime } from "@opencraft/ui-preferences";

/** Installation preference owns normal density. A frame-local presentation intent
 * may project touch controls without changing preferences or pointer modality. */
export function bindInteractionDensity(
  document: Document,
  preferences: UiPreferencesRuntime,
  view?: { readonly touchFriendly: "on" },
): () => void {
  const capability = document.defaultView!.matchMedia("(any-pointer: coarse)");
  const update = () => {
    const values = preferences.getSnapshot().values;
    const choice = view?.touchFriendly ?? values["interface.touchFriendly"];
    document.documentElement.dataset.uiDensity = choice === "on" || (choice === "auto" && capability.matches) ? "touch" : "compact";
  };
  const unsubscribe = preferences.subscribe(update);
  capability.addEventListener("change", update);
  update();
  return () => {
    unsubscribe();
    capability.removeEventListener("change", update);
    delete document.documentElement.dataset.uiDensity;
  };
}
