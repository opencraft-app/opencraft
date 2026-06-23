import type { ReactNode } from "react";
import type { DesktopHostBridge } from "./host";
import { browserDesktopHostBridge } from "./host";
import { VelaSidebarShell } from "./components/sidebar";

export interface VelaDesktopShellProps {
  sidebar: ReactNode;
  children: ReactNode;
  host?: DesktopHostBridge;
  isSidebarVisible: boolean;
  sidebarPresentation?: "auto" | "docked" | "overlay";
  sidebarWidthPx?: number;
  onCreateSession?: () => void;
  onToggleSidebar?: () => void;
  onSidebarVisibilityChange?: (isVisible: boolean) => void;
  onSidebarWidthChange?: (widthPx: number) => void;
  onSidebarWidthPreview?: (widthPx: number) => void;
  onSidebarResizeStart?: () => void;
}

export function VelaDesktopShell({
  sidebar,
  children,
  host = browserDesktopHostBridge,
  isSidebarVisible,
  sidebarPresentation = "docked",
  sidebarWidthPx,
  onCreateSession,
  onToggleSidebar,
  onSidebarVisibilityChange,
  onSidebarWidthChange,
  onSidebarWidthPreview,
  onSidebarResizeStart,
}: VelaDesktopShellProps) {
  return (
    <VelaSidebarShell
      host={host}
      isSidebarVisible={isSidebarVisible}
      sidebarPresentation={sidebarPresentation}
      sidebar={sidebar}
      sidebarWidthPx={sidebarWidthPx}
      onCreateSession={onCreateSession}
      onSidebarResizeStart={onSidebarResizeStart}
      onSidebarVisibilityChange={onSidebarVisibilityChange}
      onSidebarWidthChange={onSidebarWidthChange}
      onSidebarWidthPreview={onSidebarWidthPreview}
      onToggleSidebar={onToggleSidebar}
    >
      {children}
    </VelaSidebarShell>
  );
}
