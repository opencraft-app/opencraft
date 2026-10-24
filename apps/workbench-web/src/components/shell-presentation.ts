import { createContext, useContext } from "react";

/** Header and panel controls describe the actual window, not suspended intent. */
export const ShellPresentationContext = createContext<{
  sidebarOpen: boolean;
  /** Unified Shell owns its collapse control inside the sidebar. */
  sidebarControlsInSidebar?: boolean;
  sidebarFloating: boolean;
  /** Shell-owned mobile action overlay, outside the conversation scrollport. */
  mobileSidebar?: boolean;
  sidebarActionHost?: HTMLElement | null;
  rightPanelOpen: boolean;
  rightPanelFullWidth: boolean;
  toggleSidebar(): void;
  dismissSidebarAfterSelection(): void;
  toggleRightPanel(): void;
} | null>(null);

export const useShellPresentation = () => useContext(ShellPresentationContext);

/** Selection closes the mobile drawer without subscribing lists to Shell geometry. */
export const SidebarDismissContext = createContext<(() => void) | null>(null);
export const useDismissSidebarAfterSelection = () => useContext(SidebarDismissContext);
