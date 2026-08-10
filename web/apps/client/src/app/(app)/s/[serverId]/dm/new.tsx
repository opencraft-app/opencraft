import {useLocalSearchParams} from "expo-router";

import {useServerRoute} from "../../../../../features/workspace/server-route-context";
import {routeParam} from "../../../../../features/workspace/section-navigation";
import {WorkspaceConversationScreen} from "../../../../../features/workspace/workspace-conversation-screen";

export default function NewServerDirectMessageRoute() {
  const params = useLocalSearchParams<{peerMemberId?: string | string[]}>();
  const server = useServerRoute();

  return (
    <WorkspaceConversationScreen
      serverSlug={server.slug}
      target={{
        kind: "direct_new",
        peerMemberId: routeParam(params.peerMemberId),
      }}
    />
  );
}
