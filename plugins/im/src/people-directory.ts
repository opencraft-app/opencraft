import type { ChannelSummary } from '@opencraft/appserver-protocol';

/** Presentation over the shared Inbox projection, never a second unread owner. */
export function recentGroups(groups: readonly ChannelSummary[]): ChannelSummary[] {
  return groups.filter(group => group.kind === 'group' && group.latestMessage && Number.isFinite(group.latestMessage.at))
    .sort((a,b) => b.latestMessage!.at-a.latestMessage!.at || a.id.localeCompare(b.id)).slice(0,3);
}

/** The Inbox stream: every group with a message, newest first. The assistant's
 * direct channel is pinned by the caller, so it is excluded here. */
export function inboxGroups(groups: readonly ChannelSummary[], pinnedId?: string | null): ChannelSummary[] {
  return groups.filter(group => group.kind === 'group' && group.id !== pinnedId && group.latestMessage && Number.isFinite(group.latestMessage.at))
    .sort((a,b) => b.latestMessage!.at-a.latestMessage!.at || a.id.localeCompare(b.id));
}
