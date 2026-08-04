import {useLocalSearchParams} from "expo-router";

import {computerHref} from "../../../../../features/workspace/section-navigation";
import {ServerRouteBoundary} from "../../../../../features/workspace/server-route-boundary";
import {ComputersContent} from "../computers";

export default function ComputerDetailRoute() {
  const {computerId, serverId} = useLocalSearchParams<{
    computerId: string;
    serverId: string;
  }>();

  return (
    <ServerRouteBoundary
      canonicalHref={(slug) => computerHref(slug, computerId)}
      serverReference={serverId}
    >
      {(server) => (
        <ComputersContent
          selectedComputerId={computerId}
          server={server}
        />
      )}
    </ServerRouteBoundary>
  );
}
