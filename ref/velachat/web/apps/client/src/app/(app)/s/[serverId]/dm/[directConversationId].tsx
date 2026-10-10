import {useLocalSearchParams} from "expo-router";

import {useServerRoute} from "../../../../../features/workspace/server-route-context";
import {routeParam} from "../../../../../features/workspace/section-navigation";
import {WorkspaceConversationScreen} from "../../../../../features/workspace/workspace-conversation-screen";

export default function ServerDirectMessageRoute() {
  const params = useLocalSearchParams<{
    directConversationId?: string | string[];
  }>();
  const server = useServerRoute();

  return (
    <WorkspaceConversationScreen
      serverSlug={server.slug}
      target={{
        directConversationId: routeParam(params.directConversationId),
        kind: "direct",
      }}
    />
  );
}
