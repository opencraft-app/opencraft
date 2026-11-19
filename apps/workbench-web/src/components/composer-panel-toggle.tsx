import { usePanelComposerChrome } from "./panel-composer-chrome";
import { PanelOverviewButton } from "./panel-overview-presentation";
import { useTouchBrowserLayout } from "./use-touch-browser-layout";

/** Composer hosts navigation without owning panel visibility or tab state. */
export function ComposerPanelToggle({ foreground = "primary" }: { foreground?: "primary" | "tools" }) {
  const integrated = usePanelComposerChrome()?.slot;
  return useTouchBrowserLayout() && !integrated ? <PanelOverviewButton composer foreground={foreground} /> : null;
}
