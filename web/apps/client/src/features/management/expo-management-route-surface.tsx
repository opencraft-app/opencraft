import {TerminalController, type Server} from "@vela/client-core";
import {useRouter, type Href} from "expo-router";
import {useShallow} from "zustand/react/shallow";

import {selectManagementNavigationState} from "../../application/app-selectors";
import {RouteTitle} from "../navigation/route-title";
import {useAppRuntime, useAppState} from "../../runtime/app-runtime";
import {createExpoTerminalOpener} from "../../terminal/expo-terminal";
import {
  computerHref,
  workspaceSectionHref,
} from "../workspace/section-navigation";
import {
  ManagementRouteSurface,
  type ManagementSection,
} from "./management-route-surface";

export interface ExpoManagementRouteSurfaceProps {
  section: ManagementSection;
  selectedComputerId?: string | null;
  server: Server;
}

const sectionTitle: Record<ManagementSection, string> = {
  agents: "Agent",
  computers: "Computer",
  members: "成员",
  tasks: "任务",
};

export function ExpoManagementRouteSurface({
  section,
  selectedComputerId,
  server,
}: ExpoManagementRouteSurfaceProps) {
  const router = useRouter();
  const {store} = useAppRuntime();
  const state = useAppState(useShallow(selectManagementNavigationState));

  return (
    <>
      <RouteTitle title={`${sectionTitle[section]} · ${server.name} · VELA`} />
      <ManagementRouteSurface
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
            router.push(
              workspaceSectionHref(
                server.slug,
                nextSection,
                state.currentChannelId,
              ) as Href,
            ),
          selectComputer: computerId =>
            router.push(computerHref(server.slug, computerId) as Href),
          selectServer: (serverId, nextSection) => {
            const nextServer = state.servers.find(
              candidate => candidate.id === serverId,
            );
            if (nextServer) {
              router.replace(
                workspaceSectionHref(nextServer.slug, nextSection) as Href,
              );
            }
          },
          showComputerList: () =>
            router.replace(
              workspaceSectionHref(server.slug, "computers") as Href,
            ),
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
