import type {
  ActiveConversation,
  Channel,
  Server,
} from "@vela/client-core";
import {channelAddress, isEveryoneChannel} from "@vela/client-core";
import type { WorkspaceSection } from "@/ui";

export type ConversationRouteTarget =
  | {channelId: string; kind: "channel"; serverId: string}
  | {directConversationId: string; kind: "direct"}
  | {kind: "direct_new"; peerMemberId: string};

export function activeConversationMatches(
  active: ActiveConversation | null,
  target: ConversationRouteTarget,
): boolean {
  if (target.kind === "channel") {
    return active?.kind === "channel" && active.channelId === target.channelId;
  }
  if (active?.kind !== "direct") return false;
  return target.kind === "direct"
    ? active.directConversationId === target.directConversationId
    : active.peerMemberId === target.peerMemberId;
}

export function directConversationHref(
  directConversationId: string,
  serverReference: string,
): string {
  return `/s/${encodeURIComponent(serverReference)}/dm/${encodeURIComponent(directConversationId)}`;
}

export function newDirectConversationHref(
  peerMemberId: string,
  serverReference: string,
): string {
  const query = new URLSearchParams();
  query.set("peerMemberId", peerMemberId);
  return `/s/${encodeURIComponent(serverReference)}/dm/new?${query.toString()}`;
}

export function serverRootHref(serverReference: string): string {
  return `/s/${encodeURIComponent(serverReference)}`;
}

export function serverSetupHref(serverReference: string): string {
  return `/s/${encodeURIComponent(serverReference)}/setup`;
}

export function computerHref(
  serverReference: string,
  computerId: string,
): string {
  return `/s/${encodeURIComponent(serverReference)}/computers/${encodeURIComponent(computerId)}`;
}

export function firstRoutableChannelId(
  channels: Channel[],
): string | null {
  const root = channels.find(
    (channel) =>
      isEveryoneChannel(channel) && channelAddress(channel) !== null,
  );
  if (root) return root.id;
  return channels.find((channel) => channelAddress(channel) !== null)?.id ?? null;
}

export type ServerRouteResolution =
  | {
      canonicalSlug: string;
      legacyReference: boolean;
      server: Server;
      status: "ready";
    }
  | {status: "unavailable"};

export function resolveServerRouteReference(
  servers: Server[],
  reference: string,
): ServerRouteResolution {
  const matches = servers.filter(
    (server) =>
      server.id === reference || server.slug === reference,
  );
  if (matches.length !== 1) return {status: "unavailable"};
  const server = matches[0] as Server;
  return {
    canonicalSlug: server.slug,
    legacyReference:
      reference === server.id && reference !== server.slug,
    server,
    status: "ready",
  };
}

export function canonicalRouteSearch(
  search: string,
  browserHostname?: string,
): string {
  if (!isLoopbackHostname(browserHostname)) return "";
  const backend = new URLSearchParams(search).get("backend")?.trim();
  if (!backend || !isHttpUrl(backend)) return "";
  const result = new URLSearchParams();
  result.set("backend", backend);
  return `?${result.toString()}`;
}

export function withCanonicalRouteSearch(
  href: string,
  sourceSearch: string,
  browserHostname?: string,
): string {
  let target: URL;
  try {
    target = new URL(href, "https://vela.invalid");
  } catch {
    return href;
  }
  if (target.origin !== "https://vela.invalid") return href;
  const search = new URLSearchParams(target.search);
  search.delete("backend");
  const canonical = new URLSearchParams(
    canonicalRouteSearch(sourceSearch, browserHostname),
  );
  const backend = canonical.get("backend");
  if (backend) search.set("backend", backend);
  const encoded = search.toString();
  return `${target.pathname}${encoded ? `?${encoded}` : ""}${target.hash}`;
}

export function safeReturnTo(
  value: string | null | undefined,
  browserHostname?: string,
): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    hasControlCharacter(value)
  ) {
    return "/";
  }

  let url: URL;
  try {
    url = new URL(value, "https://vela.invalid");
  } catch {
    return "/";
  }
  if (
    url.origin !== "https://vela.invalid" ||
    !isKnownInternalPath(url.pathname)
  ) {
    return "/";
  }
  const search = new URLSearchParams();
  // /dm/new is useless without the peer; keep that route-owned query after
  // login the same way withCanonicalRouteSearch already does for in-app hrefs.
  const peerMemberId = url.searchParams.get("peerMemberId")?.trim();
  if (
    isNewDirectConversationPath(url.pathname) &&
    peerMemberId &&
    !hasControlCharacter(peerMemberId) &&
    !peerMemberId.includes("\\")
  ) {
    search.set("peerMemberId", peerMemberId);
  }
  const backend = new URLSearchParams(
    canonicalRouteSearch(url.search, browserHostname),
  ).get("backend");
  if (backend) search.set("backend", backend);
  const encoded = search.toString();
  return `${url.pathname}${encoded ? `?${encoded}` : ""}`;
}

/** Expo may hand route params as `string | string[]`; take the first value. */
export function routeParam(
  value: string | string[] | undefined,
  fallback = "",
): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw ?? fallback;
}

export function authRouteHref(
  mode: "login" | "register",
  returnTo: string | null | undefined,
  browserHostname?: string,
): string {
  const safeTarget = safeReturnTo(returnTo, browserHostname);
  if (safeTarget === "/") return `/${mode}`;
  const search = new URLSearchParams();
  search.set("returnTo", safeTarget);
  return `/${mode}?${search.toString()}`;
}

export function defaultSignedInHref(input: {
  currentChannelId: string | null;
  currentServerId: string | null;
}): string {
  if (input.currentServerId && input.currentChannelId) {
    return workspaceSectionHref(
      input.currentServerId,
      "chat",
      input.currentChannelId,
    );
  }
  return "/home";
}

export function workspaceSectionHref(
  serverId: string,
  section: WorkspaceSection,
  channelId?: string | null,
): string {
  const server = encodeURIComponent(serverId);
  if (section === "chat") {
    return channelId
      ? `/s/${server}/c/${encodeURIComponent(channelId)}`
      : `/s/${server}`;
  }
  return `/s/${server}/${section}`;
}

/** Active workspace section for the shared server chrome / bottom bar. */
export function workspaceActiveSectionFromPathname(
  pathname: string,
): WorkspaceSection {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "s" || !segments[1]) return "chat";
  const head = segments[2];
  if (!head || head === "c" || head === "dm") return "chat";
  if (head === "computers") return "computers";
  if (
    head === "tasks" ||
    head === "agents" ||
    head === "members" ||
    head === "settings"
  ) {
    return head;
  }
  return "chat";
}

/**
 * Rewrite `/s/{legacyServerId}/…` to `/s/{canonicalSlug}/…` while keeping the
 * rest of the path (and optional search) intact.
 */
export function canonicalizeServerPathname(
  pathname: string,
  serverReference: string,
  canonicalSlug: string,
  search = "",
): string {
  const parts = pathname.split("/");
  if (parts[1] === "s" && parts[2]) {
    let current = parts[2];
    let reference = serverReference;
    try {
      current = decodeURIComponent(current);
    } catch {
      // keep encoded form for comparison
    }
    try {
      reference = decodeURIComponent(reference);
    } catch {
      // keep encoded form for comparison
    }
    if (current === reference || current === serverReference) {
      parts[2] = encodeURIComponent(canonicalSlug);
    }
  }
  const path = parts.join("/") || "/";
  if (!search) return path;
  return `${path}${search.startsWith("?") ? search : `?${search}`}`;
}

function isKnownInternalPath(pathname: string): boolean {
  if (pathname === "/" || pathname === "/home" || pathname === "/join") {
    return true;
  }
  const segments = pathname.split("/").slice(1);
  if (!segments.every(isSafeEncodedSegment)) return false;
  if (segments[0] === "dm") {
    return segments.length === 2 && Boolean(segments[1]);
  }
  if (segments[0] !== "s" || !segments[1]) return false;
  if (segments.length === 2) return true;
  if (
    segments.length === 3 &&
    [
      "tasks",
      "agents",
      "computers",
      "members",
      "settings",
      "setup",
    ].includes(segments[2] ?? "")
  ) {
    return true;
  }
  if (
    segments.length === 4 &&
    segments[2] === "dm" &&
    Boolean(segments[3])
  ) {
    return true;
  }
  if (
    segments.length === 4 &&
    segments[2] === "computers" &&
    Boolean(segments[3])
  ) {
    return true;
  }
  return (
    segments.length === 4 &&
    segments[2] === "c" &&
    Boolean(segments[3])
  );
}

function isNewDirectConversationPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return (
    segments.length === 4 &&
    segments[0] === "s" &&
    segments[2] === "dm" &&
    segments[3] === "new"
  );
}

function isSafeEncodedSegment(segment: string): boolean {
  if (!segment) return true;
  try {
    const decoded = decodeURIComponent(segment);
    return !/[\\/\u0000-\u001f\u007f]/u.test(decoded);
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string | undefined): boolean {
  const normalized = hostname?.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}
