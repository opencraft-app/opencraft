import { useShellPresentation } from "../components/shell-presentation";
import { IconButton, ButtonPlaceholder } from "@opencraft/design-system-web/button";
import { useTouchLayout } from "../runtime/use-touch-layout";
import { shortcutLabel, shortcutAria } from "../workbench-shortcuts";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "@opencraft/i18n/react";
import { SidebarToggleIcon } from "./sidebar-toggle-icon";
import { useChromeActionFocusRef } from "./use-chrome-action-focus";

/** One visual/action contract for the sidebar and its collapsed entrance. */
export function SidebarToggleButton({ open, onToggle, hostRole, stationary = false, className = "chrome-button no-drag" }: {
  open: boolean;
  stationary?: boolean;
  onToggle(): void;
  hostRole: "persistent" | "transient";
  className?: string;
}) {
  const intl = useIntl();
  const presentation = useShellPresentation();
  const touch = useTouchLayout();
  const wallpaper = hostRole === "persistent" && presentation?.surface === "application-desktop";
  const ref = useChromeActionFocusRef("sidebar-toggle", hostRole);
  const label = intl.formatMessage(open
    ? { id: "navigation.hideSidebar", defaultMessage: "Hide sidebar" }
    : { id: "navigation.showSidebar", defaultMessage: "Show sidebar" });
  const anchor = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<{left:number;top:number;width:number;height:number} | null>(null);
  useLayoutEffect(() => {
    if (!stationary || !anchor.current) { setBox(null); return; }
    const element = anchor.current;
    const update = () => {
      const {left,top,width,height} = element.getBoundingClientRect();
      setBox(previous => previous && previous.left===left && previous.top===top && previous.width===width && previous.height===height
        ? previous : {left,top,width,height});
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    // Branding can settle after the button mounts without resizing its slot.
    // Observe the intrinsic rail as well so sibling/font changes reposition it.
    const rail = element.closest(".app-shell-header__window-controls-rail");
    if (rail) observer.observe(rail);
    window.addEventListener("resize",update);
    window.visualViewport?.addEventListener("resize",update);
    return () => { observer.disconnect(); window.removeEventListener("resize",update); window.visualViewport?.removeEventListener("resize",update); };
  }, [stationary]);
  const button = <IconButton ref={ref} type="button" className={className}
    surface={touch ? "floating" : "integrated"}
    aria-label={label} aria-expanded={open} title={`${label} (${shortcutLabel("sidebar")})`} aria-keyshortcuts={shortcutAria("sidebar")}
    data-header-surface={wallpaper ? "application-desktop" : undefined}
    data-app-shell-sidebar-trigger="true" data-chrome-action-id="sidebar-toggle"
    data-sidebar-toggle-stationary={stationary || undefined}
    data-chrome-action-host-role={hostRole} onClick={onToggle}>
    <SidebarToggleIcon sidebarOpen={open} />
  </IconButton>;
  if (!stationary) return button;
  return <>
    <ButtonPlaceholder ref={anchor} className={className} style={{visibility:"hidden"}} />
    {box && createPortal(<div className="app-shell-touch-sidebar-toggle" style={{left:box.left,top:box.top,width:box.width,height:box.height}}>{button}</div>, document.body)}
  </>;
}
