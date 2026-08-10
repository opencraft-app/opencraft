import type {Agent, Channel, Member, Server} from "../platform/api.js";
import {PlatformError} from "../platform/errors.js";

export function resolveServer(items: Server[], reference: string): Server {
  return resolveUnique(
    items,
    reference,
    (item) => [item.id, item.slug],
    "Server",
  );
}

export function resolveChannel(items: Channel[], reference: string): Channel {
  return resolveUnique(
    items,
    reference,
    (item) => [item.id, item.name],
    "Channel",
  );
}

/**
 * The server-wide root channel that every member belongs to by construction.
 *
 * Nobody joins it, nobody leaves it, its membership is not edited and neither
 * are its settings, and a mention in it may reach anyone on the server rather
 * than only those listed against the channel. Every one of those rules was
 * written as a bare `systemKey === "all"` at the call site — a dozen of them
 * across the store, the navigation and the chat shell, twice within three
 * lines of each other in the same block and phrased differently both times.
 * The rules differ and belong to their callers. The fact underneath is this.
 */
export function isEveryoneChannel(
  channel: Pick<Channel, "systemKey"> | null | undefined,
): boolean {
  return channel?.systemKey === "all";
}

/**
 * The signed-in Human on the current Server. Callers used to disagree on
 * whether `accountId` alone was enough, or whether `kind === "human"` and an
 * IM-user fallback were required — so the rail could show Settings while the
 * page body denied manage actions (or the reverse).
 */
export function selectCurrentHumanMember(
  members: Member[],
  identity: {
    accountId?: string | null;
    imUserId?: string | null;
  },
): Member | undefined {
  const accountId = identity.accountId ?? undefined;
  const imUserId = identity.imUserId ?? undefined;
  if (accountId === undefined && imUserId === undefined) return undefined;
  return members.find(
    member =>
      member.kind === "human" &&
      ((accountId !== undefined && member.accountId === accountId) ||
        (imUserId !== undefined && member.imUserId === imUserId)),
  );
}

/** Owner and admin may manage Server settings and privileged resources. */
export function memberCanManageServer(
  member: Pick<Member, "role"> | null | undefined,
): boolean {
  return member?.role === "owner" || member?.role === "admin";
}

export function resolveAgent(items: Agent[], reference: string): Agent {
  return resolveUnique(
    items,
    reference,
    (item) => [item.id, item.handle],
    "Agent",
  );
}

export function agentMentionEligibility(
  agent: Agent,
  members: Member[],
): {allowed: boolean; reason?: string} {
  if (agent.imState !== "ready") {
    return {
      allowed: false,
      reason: "Agent IM 身份尚未就绪",
    };
  }
  const member = members.find(
    (item) =>
      item.kind === "agent" &&
      item.status === "active" &&
      item.imUserId === agent.imUserId,
  );
  if (!member) {
    return {
      allowed: false,
      reason: "Agent 尚未加入当前 Channel",
    };
  }
  return {allowed: true};
}

function resolveUnique<T>(
  items: T[],
  reference: string,
  keys: (item: T) => string[],
  kind: string,
): T {
  const matches = items.filter((item) => keys(item).includes(reference));
  if (matches.length === 0) {
    throw new PlatformError(
      "RESOURCE_NOT_FOUND",
      `未找到 ${kind}：${reference}`,
    );
  }
  if (matches.length > 1) {
    throw new PlatformError(
      "RESOURCE_AMBIGUOUS",
      `${kind} 引用不唯一：${reference}`,
    );
  }
  return matches[0] as T;
}
