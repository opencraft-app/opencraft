import type {Server} from "@vela/client-core";
import {useLocalSearchParams} from "expo-router";

import {ExpoManagementRouteSurface} from "../../../../features/management/expo-management-route-surface";
import {ServerRouteBoundary} from "../../../../features/workspace/server-route-boundary";
import {workspaceSectionHref} from "../../../../features/workspace/section-navigation";

export default function MembersRoute() {
  const {serverId} = useLocalSearchParams<{serverId: string}>();
  return (
    <ServerRouteBoundary
      canonicalHref={(slug) => workspaceSectionHref(slug, "members")}
      serverReference={serverId}
    >
      {(server) => <MembersContent server={server} />}
    </ServerRouteBoundary>
  );
}

function MembersContent({server}: {server: Server}) {
  return <ExpoManagementRouteSurface section="members" server={server} />;
}
