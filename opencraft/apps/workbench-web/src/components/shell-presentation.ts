import { createContext, useContext } from "react";

/** Header and panel controls describe the actual window, not suspended intent. */
export const ShellPresentationContext = createContext<{
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
  rightPanelFullWidth: boolean;
  toggleSidebar(): void;
  toggleRightPanel(): void;
  restoreRightPanel?: () => void;
} | null>(null);

export const useShellPresentation = () => useContext(ShellPresentationContext);
