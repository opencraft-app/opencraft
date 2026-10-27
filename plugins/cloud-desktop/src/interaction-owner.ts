/** DOM focus is evidence of leaving an interaction scope, not authorization.
 * Mobile focusout may temporarily have neither a related target nor an active
 * element. Only explicit outside interaction, known outside focus, or platform
 * deactivation retires control. This owner never grants or restores focus.
 *
 * The panel may live inside a Shadow DOM (embedded workbench). Document-level
 * events are retargeted to the shadow host and `document.activeElement` is the
 * host, so containment is decided from the composed path and the owner's own
 * root, never from retargeted document-level values. */
export function bindDesktopInteractionOwner(owner: HTMLElement, leave: () => void) {
  const document = owner.ownerDocument, window = document.defaultView!;
  let disposed = false, revision = 0;
  const contains = (target: EventTarget | null) => target instanceof window.Node && owner.contains(target);
  const inside = (event: Event) => event.composedPath().includes(owner) || contains(event.target);
  const retire = () => { revision++; leave(); };
  const pointer = (event: Event) => { revision++; if (!inside(event)) leave(); };
  const focus = (event: FocusEvent) => {
    revision++;
    if (!inside(event)) retire();
  };
  const blur = (event: FocusEvent) => {
    if (event.relatedTarget) { if (!contains(event.relatedTarget)) retire(); return; }
    const ticket = ++revision;
    queueMicrotask(() => {
      if (disposed || ticket !== revision) return;
      const root = owner.getRootNode() as Document | ShadowRoot;
      const target = root.activeElement;
      // body/documentElement (or no element in a shadow root) denote an unknown
      // destination after focusout. An outside pointerdown and window blur are
      // independently authoritative.
      if (target && target !== document.body && target !== document.documentElement && !contains(target)) retire();
    });
  };
  const visibility = () => { if (document.visibilityState !== "visible") retire(); };
  document.addEventListener("pointerdown", pointer, true);
  document.addEventListener("focusin", focus, true);
  owner.addEventListener("focusout", blur);
  window.addEventListener("blur", retire);
  document.addEventListener("visibilitychange", visibility);
  return () => {
    disposed = true; revision++;
    document.removeEventListener("pointerdown", pointer, true);
    document.removeEventListener("focusin", focus, true);
    owner.removeEventListener("focusout", blur);
    window.removeEventListener("blur", retire);
    document.removeEventListener("visibilitychange", visibility);
  };
}

/** Whether keyboard focus is inside `owner`, including through a Shadow DOM. */
export function ownsDesktopFocus(owner: HTMLElement): boolean {
  const document = owner.ownerDocument;
  if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
  const root = owner.getRootNode() as Document | ShadowRoot;
  const active = root.activeElement;
  return active !== null && owner.contains(active);
}
