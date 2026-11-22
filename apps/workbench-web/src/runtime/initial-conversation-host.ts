import { chooseNewConversationHost, type HostConnectionProfile } from "@opencraft/workbench-runtime";

/** Host of the headless Gateway's built-in Codex. It is the product default engine for a first conversation;
 * `opencraft-server` carries the optional DSH/Pi engines and stays selectable. */
export const HEADLESS_DEFAULT_CONVERSATION_HOST = "local-codex";

/** Startup Host: an explicit route wins, then the remembered selection, then the deployment default. */
export function chooseInitialConversationHost(input: {
  readonly profiles: readonly HostConnectionProfile[];
  readonly requestedHostId?: string;
  readonly persistedHostId: string | null;
  readonly persistedHasThread: boolean;
  readonly deploymentDefaultHostId?: string | null;
}): string | undefined {
  const { profiles, requestedHostId, persistedHostId } = input;
  if (requestedHostId !== undefined && profiles.some(host => host.hostId === requestedHostId)) return requestedHostId;
  if (profiles.some(host => host.hostId === persistedHostId && (host.hideFromNewChat !== true || input.persistedHasThread))) return persistedHostId!;
  return chooseNewConversationHost(profiles, input.deploymentDefaultHostId)?.hostId;
}
