import { sidebarToggleGlyphs } from "@opencraft/design-system/sidebar-toggle-glyphs";

interface SidebarToggleIconProps {
  readonly sidebarOpen: boolean;
}

interface SidebarStateIconProps {
  readonly state: "hidden" | "visible";
  readonly path: string;
}

function SidebarStateIcon({ state, path }: SidebarStateIconProps) {
  return (
    <svg
      aria-hidden="true"
      data-sidebar-toggle-icon-state={state}
      width={sidebarToggleGlyphs.size}
      height={sidebarToggleGlyphs.size}
      viewBox={sidebarToggleGlyphs.viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}

function SidebarHiddenIcon() {
  return <SidebarStateIcon state="hidden" path={sidebarToggleGlyphs.hidden} />;
}

function SidebarVisibleIcon() {
  return <SidebarStateIcon state="visible" path={sidebarToggleGlyphs.visible} />;
}

export function ReferenceSidebarToggleIcon({ sidebarOpen }: SidebarToggleIconProps) {
  // Use separate component types for the two states. Replacing the SVG
  // atomically avoids WebKit's one-frame repaint when a complex path's `d`
  // attribute is mutated in place, while the owning button stays mounted.
  return sidebarOpen ? <SidebarVisibleIcon /> : <SidebarHiddenIcon />;
}
