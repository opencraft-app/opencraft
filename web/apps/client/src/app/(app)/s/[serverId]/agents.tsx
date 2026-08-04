import type {Server} from "@vela/client-core";
import {useLocalSearchParams} from "expo-router";

import {ExpoManagementRouteSurface} from "../../../../features/management/expo-management-route-surface";
import {ServerRouteBoundary} from "../../../../features/workspace/server-route-boundary";
import {workspaceSectionHref} from "../../../../features/workspace/section-navigation";

export default function AgentsRoute() {
  const {serverId} = useLocalSearchParams<{serverId: string}>();
  return (
    <ServerRouteBoundary
      canonicalHref={(slug) => workspaceSectionHref(slug, "agents")}
      serverReference={serverId}
    >
      {(server) => <AgentsContent server={server} />}
    </ServerRouteBoundary>
  );
}

function AgentsContent({server}: {server: Server}) {
  return <ExpoManagementRouteSurface section="agents" server={server} />;
}
