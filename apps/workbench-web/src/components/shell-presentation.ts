import { createContext, useContext } from "react";
import type { NavigationAction } from "./shell-navigation/navigation-action";

/** Header and panel controls describe the actual window, not suspended intent. */
export const ShellPresentationContext = createContext<{
  surface?: "default" | "application-desktop";
  sidebarOpen: boolean;
  /** Unified Shell owns its collapse control inside the sidebar. */
  sidebarControlsInSidebar?: boolean;
  sidebarFloating: boolean;
  /** Shell-owned mobile action overlay, outside the conversation scrollport. */
  mobileSidebar?: boolean;
  /** Persistent navigation portal; page chrome stays in its route frame. */
  navigationChromeHost?: HTMLElement | null;
  sidebarActionHost?: HTMLElement | null;
  /** Entry destinations stay outside the mobile conversation scrollport. */
  sidebarNavigationHost?: HTMLElement | null;
  /** Global Applications destination in the leading navigation rail. */
  applicationsAction?: NavigationAction;
  rightPanelOpen: boolean;
  rightPanelFullWidth: boolean;
  /** Derived once by Shell, independently of input density and tab identity. */
  foreground?: 'primary' | 'tools';
  sceneOwnerId?: string;
  contentPresentation?: 'primary' | 'tools' | 'split';
  /** Target allocation in the Shell, independent of preview/resource placement. */
  sceneBounds?(target: 'primary' | 'tools'): { x: number; y: number; width: number; height: number } | null;
  touchScene?: boolean;
  overviewPresentation?: 'contained' | 'fullscreen';
  dismissTransientSidebar?(): void;
  selectPrimary?(): void;
  selectTools?(): void;
  toggleSidebar(): void;
  dismissSidebarAfterSelection(): void;
  toggleRightPanel(): void;
} | null>(null);

export const useShellPresentation = () => useContext(ShellPresentationContext);

/** Selection closes the mobile drawer without subscribing lists to Shell geometry. */
export const SidebarDismissContext = createContext<(() => void) | null>(null);
export const useDismissSidebarAfterSelection = () => useContext(SidebarDismissContext);
