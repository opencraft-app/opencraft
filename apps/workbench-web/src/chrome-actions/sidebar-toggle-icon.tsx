import { PanelLeft, PanelLeftClose } from "lucide-react";

export function SidebarToggleIcon({ sidebarOpen }: { readonly sidebarOpen: boolean }) {
  const Icon = sidebarOpen ? PanelLeftClose : PanelLeft;
  return <Icon size={16} strokeWidth={1.8} aria-hidden="true" focusable="false"
    data-sidebar-toggle-icon-state={sidebarOpen ? "visible" : "hidden"} />;
}
