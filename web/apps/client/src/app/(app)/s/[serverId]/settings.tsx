import type {Server} from "@vela/client-core";
import {useLocalSearchParams} from "expo-router";

import {ExpoManagementRouteSurface} from "../../../../features/management/expo-management-route-surface";
import {ServerRouteBoundary} from "../../../../features/workspace/server-route-boundary";
import {workspaceSectionHref} from "../../../../features/workspace/section-navigation";

export default function SettingsRoute() {
  const {serverId} = useLocalSearchParams<{serverId: string}>();
  return (
    <ServerRouteBoundary
      canonicalHref={(slug) => workspaceSectionHref(slug, "settings")}
      serverReference={serverId}
    >
      {(server) => <SettingsContent server={server} />}
    </ServerRouteBoundary>
  );
}

function SettingsContent({server}: {server: Server}) {
  return <ExpoManagementRouteSurface section="settings" server={server} />;
}
