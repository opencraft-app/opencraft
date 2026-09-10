import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { AdaptivePanel, projectPanel, type PanelPage } from "@opencraft/workbench-runtime";

export interface AdaptivePanelPage extends PanelPage {
  readonly title: string;
  readonly content: ReactNode;
  readonly layout?: "collection" | "document";
}

/** Project independently identified pages. No list/detail or provider knowledge. */
export function AdaptivePanelView({ pages, controller }: {
  readonly pages: readonly [AdaptivePanelPage, ...AdaptivePanelPage[]];
  readonly controller: AdaptivePanel;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const resize = () => setWidth(element.clientWidth);
    resize(); const observer = new ResizeObserver(resize); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const secondary = pages.find(page => page.id === state.secondaryId);
  const { visible, canGoBack } = projectPanel(state, pages[0], secondary, width);
  const ordered = secondary ? [pages[0], secondary] : [pages[0]];
  const columns = visible.map((id, index) => index === visible.length - 1 ? "minmax(0, 1fr)" : `${pages.find(page => page.id === id)!.minWidth}px`).join(" ");
  // Stable page keys, not fixed list/detail slots, preserve page identity.
  return <div ref={root} className="adaptive-panel" data-presentation={visible.length > 1 ? "split" : "stack"} style={{ gridTemplateColumns: columns }}>
    {ordered.map((page, index) => <section key={page.id} data-panel-page={page.id} data-layout={page.layout ?? "document"} aria-label={page.title} hidden={!visible.includes(page.id)} className="adaptive-panel__page">
      {index > 0 && canGoBack ? <nav className="adaptive-panel__navigation" aria-label="Panel navigation"><button type="button" className="settings-navigation-link" onClick={controller.back}><span aria-hidden="true">‹</span>{ordered[0].title}</button></nav> : null}
      {page.content}
    </section>)}
  </div>;
}
