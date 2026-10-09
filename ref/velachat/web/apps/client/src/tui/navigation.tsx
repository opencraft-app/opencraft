import {useState} from "react";

import type {WorkspaceSection} from "../ui/presentation/section-navigation-model";

/** Terminal-local route state. It deliberately has no Expo Router or URL owner. */
export function useTerminalNavigation(initial: WorkspaceSection = "chat") {
  const [activeSection, setActiveSection] = useState<WorkspaceSection>(initial);
  return {
    activeSection,
    navigate: setActiveSection,
  };
}
