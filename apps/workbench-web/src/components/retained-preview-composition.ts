/** Presentation-only writes have an explicit owner. Observers may ignore these
 * properties for geometry, but must still observe any other simultaneous style
 * mutation (resize, theme, class, etc.). No resolved style/layout read here. */
const compositions = new WeakMap<HTMLElement, Map<string, { value: number }>>();
export function leasePreviewComposition(
  element: HTMLElement,
  property: "opacity" | "--overview-surface-opacity" = "opacity",
) {
  const previous = element.style.getPropertyValue(property);
  const priority = element.style.getPropertyPriority(property);
  const entries = compositions.get(element) ?? new Map();
  compositions.set(element, entries);
  const state = { value: property === "opacity" ? 1 : 0 };
  entries.set(property, state);
  return {
    set(value: number) {
      if (entries.get(property) !== state) return;
      element.style.setProperty(property, String(value));
      // CSSOM may round opacity; compare against its serialized value.
      state.value = Number(element.style.getPropertyValue(property));
    },
    release() {
      if (entries.get(property) !== state) return;
      entries.delete(property);
      if (!entries.size) compositions.delete(element);
      if (previous) element.style.setProperty(property, previous, priority);
      else element.style.removeProperty(property);
    },
  };
}
export const previewCompositionOpacity = (element: HTMLElement) => compositions.get(element)?.get("opacity")?.value;

export function isPreviewCompositionMutation(record: MutationRecord): boolean {
  if (record.type !== "attributes" || record.attributeName !== "style") return false;
  const element = record.target as HTMLElement,
    entries = compositions.get(element);
  if (!entries?.size) return false;
  const before = element.ownerDocument.createElement("div").style;
  const after = element.ownerDocument.createElement("div").style;
  before.cssText = record.oldValue ?? "";
  after.cssText = element.style.cssText;
  // Ignore only values still owned by this lease. An external opacity writer is
  // a normal invalidation, not permission to reuse a stale projection.
  for (const [property, state] of entries) {
    if (Number(after.getPropertyValue(property)) !== state.value) return false;
    before.removeProperty(property);
    after.removeProperty(property);
  }
  const signature = (style: CSSStyleDeclaration) =>
    [...style].sort().map((name) => [name, style.getPropertyValue(name), style.getPropertyPriority(name)]);
  return JSON.stringify(signature(before)) === JSON.stringify(signature(after));
}
