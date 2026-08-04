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
