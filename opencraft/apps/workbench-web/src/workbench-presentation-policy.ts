export interface WorkbenchPresentationPolicy {
  readonly shellNavigation: boolean;
  readonly contextSidebar: boolean;
  readonly rightPanel: boolean;
  readonly connectorLauncher: boolean;
  readonly composerActions: "all" | readonly string[];
}

export const FULL_WORKBENCH_PRESENTATION: WorkbenchPresentationPolicy =
  Object.freeze({
    shellNavigation: true,
    contextSidebar: true,
    rightPanel: true,
    connectorLauncher: true,
    composerActions: "all",
  });

/** Product-owned projection for embedding only the core conversation canvas. */
export const EMBEDDED_CORE_CHAT_PRESENTATION: WorkbenchPresentationPolicy =
  Object.freeze({
    shellNavigation: false,
    contextSidebar: false,
    rightPanel: false,
    connectorLauncher: false,
    composerActions: Object.freeze([]),
  });
