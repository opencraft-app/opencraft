import { useShellPresentation } from "../components/shell-presentation";
import { IconButton } from "@opencraft/design-system-web/button";
import { useTouchLayout } from "../runtime/use-touch-layout";
import { shortcutLabel, shortcutAria } from "../workbench-shortcuts";
import { useIntl } from "@opencraft/i18n/react";
import { SidebarToggleIcon } from "./sidebar-toggle-icon";
import { useChromeActionFocusRef } from "./use-chrome-action-focus";

/** One visual/action contract for the sidebar and its collapsed entrance. */
export function SidebarToggleButton({ open, onToggle, hostRole, className = "chrome-button no-drag" }: {
  open: boolean;
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
  // A stationary control now lives in Shell's stable frame. No measured body
  // portal: an anchor's transform is not a ResizeObserver size notification.
  return <IconButton ref={ref} type="button" className={className}
    surface={touch ? "floating" : "integrated"}
    aria-label={label} aria-expanded={open} title={`${label} (${shortcutLabel("sidebar")})`} aria-keyshortcuts={shortcutAria("sidebar")}
    data-header-surface={wallpaper ? "application-desktop" : undefined}
    data-app-shell-sidebar-trigger="true" data-chrome-action-id="sidebar-toggle"
    data-chrome-action-host-role={hostRole} onClick={onToggle}>
    <SidebarToggleIcon sidebarOpen={open} />
  </IconButton>;
}
