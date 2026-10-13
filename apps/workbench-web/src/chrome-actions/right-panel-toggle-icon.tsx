import { SidebarToggleIcon } from "./sidebar-toggle-icon";

interface RightPanelToggleIconProps {
  readonly panelOpen: boolean;
}

/**
 * A presentation-only projection of right-panel visibility.
 *
 * Both glyphs stay inside one fixed optical box. The owning toolbar action
 * remains mounted while CSS cross-fades the two panel glyphs, so a
 * visibility transition cannot change hit testing, focus, or header measure.
 */
export function RightPanelToggleIcon({
  panelOpen,
}: RightPanelToggleIconProps) {
  return (
    <span
      aria-hidden="true"
      className="right-panel-toggle-icon"
      data-panel-open={panelOpen}
    >
      <span
        className="right-panel-toggle-icon__glyph right-panel-toggle-icon__glyph--closed"
        data-panel-toggle-glyph="closed"
      >
        <SidebarToggleIcon sidebarOpen={false} />
      </span>
      <span
        className="right-panel-toggle-icon__glyph right-panel-toggle-icon__glyph--open"
        data-panel-toggle-glyph="open"
      >
        <SidebarToggleIcon sidebarOpen />
      </span>
    </span>
  );
}
