import {useLocalSearchParams} from "expo-router";

import {ServerRouteBoundary} from "../../../../../features/workspace/server-route-boundary";
import {directConversationHref} from "../../../../../features/workspace/section-navigation";
import {WorkspaceConversationScreen} from "../../../../../features/workspace/workspace-conversation-screen";

export default function ServerDirectMessageRoute() {
  const {directConversationId, serverId} = useLocalSearchParams<{
    directConversationId: string;
    serverId: string;
  }>();

  return (
    <ServerRouteBoundary
      canonicalHref={(serverSlug) =>
        directConversationHref(directConversationId ?? "", serverSlug)
      }
      serverReference={serverId}
    >
      {(server) => (
        <WorkspaceConversationScreen
          serverSlug={server.slug}
          target={{
            directConversationId: directConversationId ?? "",
            kind: "direct",
          }}
        />
      )}
    </ServerRouteBoundary>
  );
}
