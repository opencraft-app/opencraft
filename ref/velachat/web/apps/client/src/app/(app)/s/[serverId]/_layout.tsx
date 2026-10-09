import {memberCanManageServer, selectCurrentHumanMember, type Server} from "@vela/client-core";
import {
  Slot,
  useLocalSearchParams,
  usePathname,
  useRouter,
  type Href,
} from "expo-router";
import {useMemo} from "react";
import {useShallow} from "zustand/react/shallow";
import {WorkspaceChrome, type WorkspaceSection} from "@/ui";

import {currentBrowserHref} from "../../../../features/navigation/browser-navigation";
import {ServerRouteBoundary} from "../../../../features/workspace/server-route-boundary";
import {
  ServerWorkspaceProvider,
  type ServerWorkspaceNavigation,
} from "../../../../features/workspace/server-route-context";
import {
  canonicalizeServerPathname,
  computerHref,
  serverRootHref,
  workspaceActiveSectionFromPathname,
  workspaceSectionHref,
} from "../../../../features/workspace/section-navigation";
import {browserSearch} from "../../../../runtime/browser-location";
import {useAppRuntime, useAppState} from "../../../../runtime/app-runtime";

/**
 * One Server tree: resolve the Server once, keep WorkspaceChrome mounted across
 * chat ↔ management navigations so the rail / bottom bar do not remount.
 */
export default function ServerWorkspaceLayout() {
  const {serverId} = useLocalSearchParams<{serverId: string}>();
  const pathname = usePathname();

  return (
    <ServerRouteBoundary
      canonicalHref={(slug) =>
        canonicalizeServerPathname(
          pathname,
          serverId ?? "",
          slug,
          browserSearch(),
        )
      }
      serverReference={serverId}
    >
      {(server) => <ServerWorkspaceChrome server={server} />}
    </ServerRouteBoundary>
  );
}

function ServerWorkspaceChrome({server}: {server: Server}) {
  const pathname = usePathname();
  const router = useRouter();
  const {store} = useAppRuntime();
  const activeSection = workspaceActiveSectionFromPathname(pathname);
  const {account, currentChannelId, currentMember, imStatus, servers} =
    useAppState(
      useShallow(state => ({
        account: state.account,
        currentChannelId: state.currentChannelId,
        currentMember: selectCurrentHumanMember(state.members, {
          accountId: state.account?.id,
          imUserId: state.account?.imUserId,
        }),
        imStatus: state.imState.status,
        servers: state.servers,
      })),
    );
  const canManageServer = memberCanManageServer(currentMember);

  const navigation = useMemo<ServerWorkspaceNavigation>(
    () => ({
      navigateSection(section) {
        router.push(
          currentBrowserHref(
            workspaceSectionHref(server.slug, section, currentChannelId),
          ) as Href,
        );
      },
      push(href) {
        router.push(currentBrowserHref(href) as Href);
      },
      replace(href) {
        router.replace(currentBrowserHref(href) as Href);
      },
      sectionHref(section) {
        return workspaceSectionHref(server.slug, section, currentChannelId);
      },
      selectComputer(computerId) {
        router.push(
          currentBrowserHref(computerHref(server.slug, computerId)) as Href,
        );
      },
      selectServer(serverId, section: WorkspaceSection = activeSection) {
        const next = servers.find(candidate => candidate.id === serverId);
        if (!next) return;
        router.replace(
          currentBrowserHref(
            workspaceSectionHref(next.slug, section, null),
          ) as Href,
        );
      },
      serverHref(candidate) {
        return serverRootHref(candidate.slug);
      },
      showComputerList() {
        router.replace(
          currentBrowserHref(
            workspaceSectionHref(server.slug, "computers"),
          ) as Href,
        );
      },
    }),
    [activeSection, currentChannelId, router, server.slug, servers],
  );

  return (
    <WorkspaceChrome
      account={account}
      activeSection={activeSection}
      canManageServer={canManageServer}
      currentServerId={server.id}
      imStatus={imStatus}
      onLogout={() => store.getState().logout()}
      onNavigateSection={section => navigation.navigateSection(section)}
      onSelectServer={serverId => navigation.selectServer(serverId)}
      sectionHref={section => navigation.sectionHref(section)}
      serverHref={candidate => navigation.serverHref(candidate)}
      servers={servers}
    >
      <ServerWorkspaceProvider navigation={navigation} server={server}>
        <Slot />
      </ServerWorkspaceProvider>
    </WorkspaceChrome>
  );
}
