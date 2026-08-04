import {useLocalSearchParams} from "expo-router";

import {ServerRoot} from "../../../../features/workspace/server-root";
import {ServerRouteBoundary} from "../../../../features/workspace/server-route-boundary";
import {serverRootHref} from "../../../../features/workspace/section-navigation";
import {useAppRuntime, useAppState} from "../../../../runtime/app-runtime";

export default function ServerRootRoute() {
  const {serverId} = useLocalSearchParams<{serverId: string}>();
  const {store} = useAppRuntime();
  const channels = useAppState((state) => state.channels);
  return (
    <ServerRouteBoundary
      canonicalHref={serverRootHref}
      serverReference={serverId}
    >
      {(server) => (
        <ServerRoot
          channels={channels}
          onRetry={() => void store.getState().selectServer(server.id)}
          server={server}
        />
      )}
    </ServerRouteBoundary>
  );
}
