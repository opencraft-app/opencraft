/**
 * Document-level input presentation contract.
 *
 * Two facts are modelled separately and projected onto `<html>` by the host:
 *
 * - Touch presentation (`data-ui-density="touch"`): the installation
 *   preference `interface.touchFriendly` resolved against touch capability.
 *   It decides hit targets, sheets and touch-first affordances.
 * - Current input modality (`data-touch-interaction`): whether the latest
 *   pointer interaction came from touch or pen. It decides transient
 *   feedback such as hover and focus rings for this one interaction.
 *
 * Product code reads both through this module and never re-derives them from
 * pointer/hover media queries, touch points, viewport width or host names.
 * `scripts/check/check-touch-presentation.mjs` enforces that boundary.
 */

export const UI_DENSITY_ATTRIBUTE = "data-ui-density";
export const TOUCH_INTERACTION_ATTRIBUTE = "data-touch-interaction";
/** `dataset` keys of the attributes above, for the host writers. */
export const UI_DENSITY_KEY = "uiDensity";
export const TOUCH_INTERACTION_KEY = "touchInteraction";

export type UiDensity = "touch" | "compact";
export type TouchFriendlyPreference = "auto" | "on" | "off";

/** The one touch-capability query that may feed touch presentation. */
const TOUCH_CAPABILITY_QUERY = "(any-pointer: coarse)";

export function touchCapability(view: Window): MediaQueryList {
  return view.matchMedia(TOUCH_CAPABILITY_QUERY);
}

/** Resolves the installation preference against current touch capability. */
export function resolveUiDensity(preference: TouchFriendlyPreference, touchCapable: boolean): UiDensity {
  return preference === "on" || (preference === "auto" && touchCapable) ? "touch" : "compact";
}

/** Whether the document currently presents touch-first controls. */
export function isTouchPresentation(document: Document): boolean {
  return document.documentElement.dataset[UI_DENSITY_KEY] === "touch";
}

/** Whether the latest pointer interaction in this document was touch or pen. */
export function isTouchInteraction(document: Document): boolean {
  return document.documentElement.dataset[TOUCH_INTERACTION_KEY] !== undefined;
}

/**
 * Text entry that started from touch on a touch presentation. Its Return key
 * usually comes from a software keyboard, so it inserts a line instead of
 * submitting. A mouse or trackpad interaction, or a compact presentation
 * chosen by preference, keeps hardware-keyboard semantics.
 */
export function isTouchTextEntry(document: Document): boolean {
  return isTouchPresentation(document) && isTouchInteraction(document);
}

export function subscribeTouchPresentation(document: Document, onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [UI_DENSITY_ATTRIBUTE] });
  return () => observer.disconnect();
}

/**
 * Capacity heuristics only (cache and memory budgets), never presentation:
 * whether the primary pointer is touch, i.e. a handheld rather than a
 * touch-capable laptop. Presentation consumers use `isTouchPresentation`.
 */
export function isPrimaryPointerTouch(view: Window): boolean {
  return view.matchMedia("(pointer: coarse)").matches;
}
