/** Temporary presentation ownership of inert. Preserve later writes by other
 * owners, even a redundant inert=true, rather than restoring an old snapshot. */
export function suspendSceneChrome(root: HTMLElement): () => void {
  // Same paint boundaries as panel-tab-overview.scss; nested leases are safe
  // for input, but never acquire controls belonging to a different Shell.
  const selector = '.panel-mobile-dock, .thread-scroll-footer, :is(.app-shell-header-motion-host,.shell-chrome-host) > *, [data-retained-preview-chrome], .thread-composer-overlay-host';
  const leases = new Map<HTMLElement, { release(): void }>();
  const acquire = (node: HTMLElement) => {
    if (leases.has(node) || node.closest('.app-shell-root') !== root) return;
    let desired = node.inert;
    const observe = () => observer.observe(node, { attributes: true, attributeFilter: ['inert'] });
    const reconcile = (records: MutationRecord[]) => {
      if (!records.length) return;
      desired = node.inert;
      observer.disconnect();
      node.inert = true;
      observe();
    };
    const observer = new MutationObserver(reconcile);
    node.inert = true;
    observe();
    leases.set(node, { release() {
      // Release can run before the mutation observer microtask.
      if (observer.takeRecords().length) desired = node.inert;
      observer.disconnect(); node.inert = desired;
    } });
  };
  const discover = (node: Element) => {
    if (node instanceof HTMLElement && node.matches(selector)) acquire(node);
    for (const child of node.querySelectorAll<HTMLElement>(selector)) acquire(child);
  };
  discover(root);
  const observer = new MutationObserver(records => {
    // Inspect only inserted subtrees. Streaming text does not rescan the Shell.
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof Element) discover(node);
    }
    for (const [node, lease] of leases) if (!root.contains(node) || node.closest('.app-shell-root') !== root) {
      lease.release(); leases.delete(node);
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    for (const lease of leases.values()) lease.release();
    leases.clear();
  };
}
