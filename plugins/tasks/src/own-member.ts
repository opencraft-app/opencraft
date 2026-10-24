import type { TaskMember } from "@opencraft/appserver-protocol";
import type { PlatformViewHost } from "@opencraft/extension-react";

/** Existing directory IDs are explicit handles. Never match a display name or guess an alias. */
export function ownMemberId(members: readonly TaskMember[], user: PlatformViewHost["currentUser"], selected: string | null): string | null {
  if (selected && members.some(member => member.id === selected)) return selected;
  return user && members.some(member => member.id === user.handle) ? user.handle : null;
}
