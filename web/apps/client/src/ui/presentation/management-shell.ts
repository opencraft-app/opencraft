import type {Server} from "@vela/client-core";

import {
  visibleSectionPresentationItems,
  type WorkspaceSection,
} from "./section-navigation-model";
import type {ManagementShellModel, PresentationAction} from "./index";

/**
 * Shell chrome for semantic/terminal models. Labels and membership come from
 * `sectionNavigation` — the same list the graphical rail and bottom bar use —
 * so a new section cannot land in one surface and stay missing from another.
 */
export function buildSectionPresentationNavigation(
  onNavigateSection: (section: WorkspaceSection) => void,
  canManageServer = false,
): PresentationAction[] {
  return visibleSectionPresentationItems(canManageServer).map(item => ({
    id: `navigate-${item.id}`,
    label: item.label,
    run: () => onNavigateSection(item.id),
  }));
}

export function buildManagementShellModel(input: {
  accountLabel?: string;
  activeSection: WorkspaceSection;
  canManageServer?: boolean;
  currentServerId: string | null;
  onLogout?: () => void | Promise<void>;
  onNavigateSection(section: WorkspaceSection): void;
  onSelectServer(serverId: string): void | Promise<void>;
  servers: Server[];
}): ManagementShellModel {
  const selectedServer = input.servers.find(
    server => server.id === input.currentServerId,
  );
  return {
    accountLabel: input.accountLabel,
    activeSection: input.activeSection,
    navigation: buildSectionPresentationNavigation(
      input.onNavigateSection,
      input.canManageServer ?? false,
    ),
    ...(input.onLogout ? {onLogout: input.onLogout} : {}),
    serverName: selectedServer?.name,
    serverOptions: input.servers.map(server => ({
      id: server.id,
      label: server.name,
      onSelect: () => input.onSelectServer(server.id),
      selected: server.id === input.currentServerId,
    })),
  };
}
