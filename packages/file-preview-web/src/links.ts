/** Imported document links use a narrow host action, never document navigation. */
export function previewLinkTarget(value: string | null): string | null {
  if (!value) return null;
  const target = value.trim();
  if (!target || /[\u0000-\u001f\u007f-\u009f]/u.test(target)) return null;
  if (/^#[^\s<>"']+$/u.test(target)) return target;
  if (!/^https?:\/\//iu.test(target)) return null;
  try { const url = new URL(target); return url.username || url.password ? null : url.href; } catch { return null; }
}
export function bindPreviewLinks(root: HTMLElement, getOpen: () => ((url: string) => void) | undefined): () => void {
  const click = (event: MouseEvent) => {
    const anchor = event.target instanceof Element ? event.target.closest("a") : null;
    if (!anchor) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const target = previewLinkTarget(anchor.getAttribute("href") ?? anchor.getAttribute("xlink:href"));
    if (!target) return;
    if (target.startsWith("#")) {
      let id: string; try { id = decodeURIComponent(target.slice(1)); } catch { return; }
      const destination = [...root.querySelectorAll("[id], a[name]")].find(node => node.id === id || node.getAttribute("name") === id);
      destination?.scrollIntoView({ block: "nearest" });
    } else getOpen()?.(target);
  };
  root.addEventListener("click", click, true);
  return () => root.removeEventListener("click", click, true);
}
