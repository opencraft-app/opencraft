import type {Server} from "@vela/client-core";
import {createContext, useContext, type ReactNode} from "react";
import type {WorkspaceSection} from "@/ui";

/**
 * Shared navigation for one Server workspace. Layout owns the push/replace
 * wiring (including browser search canonicalization); chat and management
 * call into this instead of each inventing workspaceSectionHref routes.
 */
export interface ServerWorkspaceNavigation {
  navigateSection(section: WorkspaceSection): void;
  push(href: string): void;
  replace(href: string): void;
  sectionHref(section: WorkspaceSection): string;
  selectComputer(computerId: string): void;
  selectServer(serverId: string, section?: WorkspaceSection): void;
  serverHref(server: Server): string;
  showComputerList(): void;
}

export interface ServerWorkspaceValue {
  navigation: ServerWorkspaceNavigation;
  server: Server;
}

const ServerWorkspaceContext = createContext<ServerWorkspaceValue | null>(null);

export function ServerWorkspaceProvider({
  children,
  navigation,
  server,
}: {
  children: ReactNode;
  navigation: ServerWorkspaceNavigation;
  server: Server;
}) {
  return (
    <ServerWorkspaceContext.Provider value={{navigation, server}}>
      {children}
    </ServerWorkspaceContext.Provider>
  );
}

/** Server + nav already resolved by the shared `[serverId]` layout. */
export function useServerWorkspace(): ServerWorkspaceValue {
  const value = useContext(ServerWorkspaceContext);
  if (!value) {
    throw new Error("useServerWorkspace requires ServerWorkspaceProvider");
  }
  return value;
}

export function useServerRoute(): Server {
  return useServerWorkspace().server;
}

export function useOptionalServerWorkspace(): ServerWorkspaceValue | null {
  return useContext(ServerWorkspaceContext);
}
