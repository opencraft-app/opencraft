import type {Server} from "@raft-platform/client-core";
import {useLocalSearchParams} from "expo-router";

import {ExpoManagementRouteSurface} from "../../../../features/management/expo-management-route-surface";
import {ServerRouteBoundary} from "../../../../features/workspace/server-route-boundary";
import {workspaceSectionHref} from "../../../../features/workspace/section-navigation";

export default function ComputersRoute() {
  const {serverId} = useLocalSearchParams<{serverId: string}>();
  return (
    <ServerRouteBoundary
      canonicalHref={(slug) => workspaceSectionHref(slug, "computers")}
      serverReference={serverId}
    >
      {(server) => <ComputersContent server={server} />}
    </ServerRouteBoundary>
  );
}

export function ComputersContent({
  selectedComputerId,
  server,
}: {
  selectedComputerId?: string | null;
  server: Server;
}) {
  return (
    <ExpoManagementRouteSurface
      section="computers"
      {...(selectedComputerId !== undefined ? {selectedComputerId} : {})}
      server={server}
    />
  );
}
