import type {Server} from "@raft-platform/client-core";
import {useLocalSearchParams} from "expo-router";

import {ExpoManagementRouteSurface} from "../../../../features/management/expo-management-route-surface";
import {ServerRouteBoundary} from "../../../../features/workspace/server-route-boundary";
import {workspaceSectionHref} from "../../../../features/workspace/section-navigation";

export default function TasksRoute() {
  const {serverId} = useLocalSearchParams<{serverId: string}>();
  return (
    <ServerRouteBoundary
      canonicalHref={(slug) => workspaceSectionHref(slug, "tasks")}
      serverReference={serverId}
    >
      {(server) => <TasksContent server={server} />}
    </ServerRouteBoundary>
  );
}

function TasksContent({server}: {server: Server}) {
  return <ExpoManagementRouteSurface section="tasks" server={server} />;
}
