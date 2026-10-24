export interface WorkbenchPresentationPolicy {
  /** The containing product owns the execution target in fixed presentations. */
  readonly executionSelection: "selectable" | "fixed";
  readonly machineManagement: boolean;
  readonly runtimeHostConfiguration: boolean;
  readonly shellNavigation: boolean;
  readonly contextSidebar: boolean;
  readonly rightPanel: boolean;
  readonly rightPanelDefaultSize: "standard" | "compact";
  readonly panelActions: "all" | readonly string[];
  readonly filePreviewOnly: boolean;
  readonly connectorLauncher: boolean;
  /** Product opt-in for the desktop shortcut beside the composer. */
  readonly composerDesktopEntry?: boolean;
  readonly composerActions: "all" | readonly string[];
}

export const FULL_WORKBENCH_PRESENTATION: WorkbenchPresentationPolicy =
  Object.freeze({
    executionSelection: "selectable",
    machineManagement: true,
    runtimeHostConfiguration: true,
    shellNavigation: true,
    contextSidebar: true,
    rightPanel: true,
    rightPanelDefaultSize: "standard",
    panelActions: "all",
    filePreviewOnly: false,
    connectorLauncher: true,
    composerActions: "all",
  });

/** Product-owned projection for embedding only the core conversation canvas. */
export const EMBEDDED_CORE_CHAT_PRESENTATION: WorkbenchPresentationPolicy =
  Object.freeze({
    executionSelection: "fixed",
    machineManagement: false,
    runtimeHostConfiguration: false,
    shellNavigation: false,
    contextSidebar: false,
    rightPanel: true,
    rightPanelDefaultSize: "compact",
    panelActions: Object.freeze(["opencraft.browser.new-tab"]),
    filePreviewOnly: true,
    connectorLauncher: false,
    composerActions: Object.freeze(["opencraft.voice-input.toggle"]),
  });
