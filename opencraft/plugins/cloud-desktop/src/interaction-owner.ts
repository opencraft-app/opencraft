/** DOM focus is evidence of leaving an interaction scope, not authorization.
 * Mobile focusout may temporarily have neither a related target nor an active
 * element. Only explicit outside interaction, known outside focus, or platform
 * deactivation retires control. This owner never grants or restores focus. */
export function bindDesktopInteractionOwner(owner: HTMLElement, leave: () => void) {
  const document = owner.ownerDocument, window = document.defaultView!;
  let disposed = false, revision = 0;
  const inside = (target: EventTarget | null) => target instanceof window.Node && owner.contains(target);
  const retire = () => { revision++; leave(); };
  const pointer = (event: Event) => { revision++; if (!inside(event.target)) leave(); };
  const focus = (event: FocusEvent) => {
    revision++;
    if (!inside(event.target)) retire();
  };
  const blur = (event: FocusEvent) => {
    if (event.relatedTarget) { if (!inside(event.relatedTarget)) retire(); return; }
    const ticket = ++revision;
    queueMicrotask(() => {
      if (disposed || ticket !== revision) return;
      const target = document.activeElement;
      // body/documentElement denote an unknown destination after focusout.
      // An outside pointerdown and window blur are independently authoritative.
      if (target && target !== document.body && target !== document.documentElement && !inside(target)) retire();
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
