import type {Member} from "@vela/client-core";

const generatedHumanHandlePattern = /^u_[A-Z0-9]{16,}$/u;

/**
 * How a member's kind reads in the product.
 *
 * Chat spelled this out as a ternary beside every row; members kept a local
 * map; the directory summary wrote it a third time. Nothing compared them, so
 * a DM search hit could read "@handle · 自然人" while the directory summary
 * for the same peer read "自然人 · @handle". One word, one place.
 */
export const memberKindLabel: Record<Member["kind"], string> = {
  agent: "Agent",
  human: "自然人",
};

export const memberRoleLabel: Record<Member["role"], string> = {
  admin: "管理员",
  member: "成员",
  owner: "所有者",
};

export const memberImStateLabel: Record<Member["imState"], string> = {
  error: "连接异常",
  provisioning: "连接中",
  ready: "已连接",
};

export const memberStatusLabel: Record<Member["status"], string> = {
  active: "正常",
  removed: "已移除",
  removing: "移除中",
};

function compactHandle(handle: string): string {
  if (handle.length <= 20) return handle;
  return `${handle.slice(0, 8)}…${handle.slice(-6)}`;
}

export function visibleMemberHandle(member: Member): string | null {
  if (
    member.kind === "human" &&
    generatedHumanHandlePattern.test(member.handle)
  ) {
    return null;
  }
  return compactHandle(member.handle);
}

export function memberIdentityLabel(member: Member | undefined): string | null {
  if (!member) return null;
  const handle = visibleMemberHandle(member);
  return handle ? `@${handle}` : null;
}

export function memberByImUserId(
  members: Member[],
  peerUserId: string,
): Member | undefined {
  return members.find((member) => member.imUserId === peerUserId);
}
