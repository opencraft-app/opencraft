/** Mirror only Workbench-owned lazy styles into this presentation's shadow
 * boundary. The document copy remains the owner for document-level portals.
 * No polling or host-page stylesheet copying; retirement releases the observer.
 */
export function bindShadowFeatureStyles(shadow: ShadowRoot, assetBase: string): () => void {
  const document = shadow.ownerDocument;
  const base = new URL("assets/", new URL(assetBase, document.baseURI));
  const mirrored = new Map<Element, Element>();
  const sync = () => {
    const sources = new Set<Element>();
    for (const source of document.head.querySelectorAll("link[rel=stylesheet], style[data-vite-dev-id]")) {
      const link = source instanceof HTMLLinkElement;
      const url = link ? new URL(source.href, document.baseURI) : null;
      const owned = url ? url.origin === base.origin && url.pathname.startsWith(base.pathname)
        : /\/opencraft\/(?:apps\/workbench-web|packages|plugins)\//.test(source.getAttribute("data-vite-dev-id") ?? "");
      if (!owned) continue;
      sources.add(source);
      let target = mirrored.get(source);
      if (!target) {
        target = source.cloneNode(true) as Element;
        if (link) (target as HTMLLinkElement).href = source.href;
        shadow.append(target); mirrored.set(source, target);
      } else if (link && (target as HTMLLinkElement).href !== source.href) (target as HTMLLinkElement).href = source.href;
      else if (!link && target.textContent !== source.textContent) target.textContent = source.textContent;
    }
    for (const [source, target] of mirrored) if (!sources.has(source)) { target.remove(); mirrored.delete(source); }
  };
  const observer = new MutationObserver(sync);
  observer.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href", "rel", "data-vite-dev-id"] });
  sync();
  return () => { observer.disconnect(); for (const target of mirrored.values()) target.remove(); mirrored.clear(); };
}
