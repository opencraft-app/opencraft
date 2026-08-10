import {useLocalSearchParams} from "expo-router";

import {useServerRoute} from "../../../../../features/workspace/server-route-context";
import {routeParam} from "../../../../../features/workspace/section-navigation";
import {WorkspaceConversationScreen} from "../../../../../features/workspace/workspace-conversation-screen";

export default function ChannelRoute() {
  const params = useLocalSearchParams<{channelId?: string | string[]}>();
  const server = useServerRoute();

  return (
    <WorkspaceConversationScreen
      serverSlug={server.slug}
      target={{
        channelId: routeParam(params.channelId),
        kind: "channel",
        serverId: server.id,
      }}
    />
  );
}
