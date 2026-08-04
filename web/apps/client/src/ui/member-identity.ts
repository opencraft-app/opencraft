import type {Member} from "@raft-platform/client-core";

const generatedHumanHandlePattern = /^u_[A-Z0-9]{16,}$/u;

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
