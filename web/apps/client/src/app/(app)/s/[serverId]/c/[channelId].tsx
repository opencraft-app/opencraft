import {useLocalSearchParams} from "expo-router";

import {ServerRouteBoundary} from "../../../../../features/workspace/server-route-boundary";
import {workspaceSectionHref} from "../../../../../features/workspace/section-navigation";
import {WorkspaceConversationScreen} from "../../../../../features/workspace/workspace-conversation-screen";

export default function ChannelRoute() {
  const {channelId, serverId} = useLocalSearchParams<{
    channelId: string;
    serverId: string;
  }>();

  return (
    <ServerRouteBoundary
      canonicalHref={(serverSlug) =>
        workspaceSectionHref(serverSlug, "chat", channelId)
      }
      serverReference={serverId}
    >
      {(server) => (
        <WorkspaceConversationScreen
          serverSlug={server.slug}
          target={{
            channelId: channelId ?? "",
            kind: "channel",
            serverId: server.id,
          }}
        />
      )}
    </ServerRouteBoundary>
  );
}
