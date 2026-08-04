import {useLocalSearchParams} from "expo-router";

import {ServerRouteBoundary} from "../../../../../features/workspace/server-route-boundary";
import {newDirectConversationHref} from "../../../../../features/workspace/section-navigation";
import {WorkspaceConversationScreen} from "../../../../../features/workspace/workspace-conversation-screen";

export default function NewServerDirectMessageRoute() {
  const {peerMemberId, serverId} = useLocalSearchParams<{
    peerMemberId: string;
    serverId: string;
  }>();

  return (
    <ServerRouteBoundary
      canonicalHref={(serverSlug) =>
        newDirectConversationHref(peerMemberId ?? "", serverSlug)
      }
      serverReference={serverId}
    >
      {(server) => (
        <WorkspaceConversationScreen
          serverSlug={server.slug}
          target={{kind: "direct_new", peerMemberId: peerMemberId ?? ""}}
        />
      )}
    </ServerRouteBoundary>
  );
}
