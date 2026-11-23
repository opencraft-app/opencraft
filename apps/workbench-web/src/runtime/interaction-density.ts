import { resolveUiDensity, touchCapability, UI_DENSITY_KEY } from "@opencraft/design-system-web/input-presentation";
import type { UiPreferencesRuntime } from "@opencraft/ui-preferences";

/** Installation preference owns normal density. A frame-local presentation intent
 * may project touch controls without changing preferences or pointer modality. */
export function bindInteractionDensity(
  document: Document,
  preferences: UiPreferencesRuntime,
  view?: { readonly touchFriendly: "on" },
): () => void {
  const capability = touchCapability(document.defaultView!);
  const root = document.documentElement;
  const update = () => {
    const choice = view?.touchFriendly ?? preferences.getSnapshot().values["interface.touchFriendly"];
    root.dataset[UI_DENSITY_KEY] = resolveUiDensity(choice, capability.matches);
  };
  const unsubscribe = preferences.subscribe(update);
  capability.addEventListener("change", update);
  update();
  return () => {
    unsubscribe();
    capability.removeEventListener("change", update);
    delete root.dataset[UI_DENSITY_KEY];
  };
}
