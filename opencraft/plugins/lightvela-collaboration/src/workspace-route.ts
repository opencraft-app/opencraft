const SCHEME = "lightvela-collaboration:";

export type CollaborationWorkspaceRoute =
  | { readonly kind: "home" }
  | { readonly kind: "chat"; readonly serverId: string }
  | { readonly kind: "channel"; readonly serverId: string; readonly channelId: string }
  | { readonly kind: "direct"; readonly serverId: string; readonly directConversationId: string }
  | { readonly kind: "member"; readonly serverId: string; readonly memberId: string }
  | {
      readonly kind: "im-thread";
      readonly serverId: string;
      readonly channelId: string;
      readonly threadId: string;
    }
  | { readonly kind: "computers"; readonly serverId: string }
  | { readonly kind: "computer"; readonly serverId: string; readonly computerId: string };

function encode(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes("/")) {
    throw new RangeError("Collaboration resource identity must be a non-empty path segment");
  }
  return encodeURIComponent(normalized);
}

function segments(url: URL): string[] | null {
  try {
    const values = url.pathname
      .split("/")
      .filter(Boolean)
      .map((value) => decodeURIComponent(value));
    return values.every((value) => value !== "" && !value.includes("/")) ? values : null;
  } catch {
    return null;
  }
}

export function serializeCollaborationWorkspaceRoute(
  route: CollaborationWorkspaceRoute,
): string {
  if (route.kind === "home") return `${SCHEME}//home`;
  const root = `${SCHEME}//servers/${encode(route.serverId)}`;
  switch (route.kind) {
    case "chat":
      return `${root}/chat`;
    case "channel":
      return `${root}/chat/channels/${encode(route.channelId)}`;
    case "direct":
      return `${root}/chat/direct/${encode(route.directConversationId)}`;
    case "member":
      return `${root}/chat/members/${encode(route.memberId)}`;
    case "im-thread":
      return `${root}/chat/channels/${encode(route.channelId)}/im-threads/${encode(route.threadId)}`;
    case "computers":
      return `${root}/computers`;
    case "computer":
      return `${root}/computers/${encode(route.computerId)}`;
  }
}

export function parseCollaborationWorkspaceRoute(
  resourceUri: string | null,
): CollaborationWorkspaceRoute | null {
  if (resourceUri === null) return null;
  let url: URL;
  try {
    url = new URL(resourceUri);
  } catch {
    return null;
  }
  if (url.protocol !== SCHEME || url.search || url.hash || url.username || url.password || url.port) {
    return null;
  }
  const path = segments(url);
  if (path === null) return null;
  if (url.hostname === "home" && path.length === 0) return { kind: "home" };
  if (url.hostname !== "servers" || path.length < 2) return null;
  const [serverId, area, resource, resourceId, child, childId] = path;
  if (!serverId) return null;
  if (area === "chat" && path.length === 2) return { kind: "chat", serverId };
  if (area === "chat" && resource === "channels" && resourceId && path.length === 4) {
    return { kind: "channel", serverId, channelId: resourceId };
  }
  if (
    area === "chat" && resource === "channels" && resourceId &&
    child === "im-threads" && childId && path.length === 6
  ) {
    return { kind: "im-thread", serverId, channelId: resourceId, threadId: childId };
  }
  if (area === "chat" && resource === "direct" && resourceId && path.length === 4) {
    return { kind: "direct", serverId, directConversationId: resourceId };
  }
  if (area === "chat" && resource === "members" && resourceId && path.length === 4) {
    return { kind: "member", serverId, memberId: resourceId };
  }
  if (area === "computers" && path.length === 2) return { kind: "computers", serverId };
  if (area === "computers" && resource && path.length === 3) {
    return { kind: "computer", serverId, computerId: resource };
  }
  return null;
}
