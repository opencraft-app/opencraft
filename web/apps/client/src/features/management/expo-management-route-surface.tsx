import {TerminalController, type Server} from "@vela/client-core";
import {workspaceSectionLabel} from "@/ui";

import {RouteTitle} from "../navigation/route-title";
import {useAppRuntime} from "../../runtime/app-runtime";
import {createExpoTerminalOpener} from "../../terminal/expo-terminal";
import {useServerWorkspace} from "../workspace/server-route-context";
import {
  ManagementRouteSurface,
  type ManagementSection,
} from "./management-route-surface";

export interface ExpoManagementRouteSurfaceProps {
  section: ManagementSection;
  selectedComputerId?: string | null;
  server?: Server;
}

export function ExpoManagementRouteSurface({
  section,
  selectedComputerId,
  server: serverProp,
}: ExpoManagementRouteSurfaceProps) {
  const {store} = useAppRuntime();
  const {navigation, server: contextServer} = useServerWorkspace();
  const server = serverProp ?? contextServer;

  return (
    <>
      <RouteTitle
        title={`${workspaceSectionLabel(section)} · ${server.name} · VELA`}
      />
      <ManagementRouteSurface
        chrome={false}
        {...(section === "computers"
          ? {
              createTerminalController: (computerId: string) =>
                new TerminalController({
                  createSession: async () => {
                    const session = await store
                      .getState()
                      .createComputerTerminalSession(computerId);
                    if (!session) {
                      throw new Error(
                        store.getState().error ?? "无法创建终端会话",
                      );
                    }
                    return session;
                  },
                  opener: createExpoTerminalOpener(),
                }),
            }
          : {})}
        navigation={{
          navigateSection: nextSection =>
            navigation.navigateSection(nextSection),
          selectComputer: computerId => navigation.selectComputer(computerId),
          selectServer: (serverId, nextSection) =>
            navigation.selectServer(serverId, nextSection),
          showComputerList: () => navigation.showComputerList(),
        }}
        section={section}
        {...(selectedComputerId !== undefined
          ? {selectedComputerId}
          : {})}
        server={server}
      />
    </>
  );
}
