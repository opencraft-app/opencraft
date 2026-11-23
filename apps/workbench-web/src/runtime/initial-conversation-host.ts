import { chooseNewConversationHost, type HostConnectionProfile } from "@opencraft/workbench-runtime";

/** Host of the built-in Codex engine. The Electron Daemon and the headless Gateway both expose it as `local-codex`;
 * the DSH/Pi Host (`local` on desktop, `opencraft-server` on headless) stays selectable and is the fallback. */
export const BUILTIN_CODEX_CONVERSATION_HOST = "local-codex";

/** Deployment default for new conversations. Only deployments that ship the built-in Codex Host name it; a plain Web
 * build with configured AppServer Hosts keeps the deployment order. */
export function conversationDeploymentDefaultHost(deployment: {
  readonly platform: "web" | "electron";
  readonly headlessAppHost: boolean;
}): string | null {
  return deployment.platform === "electron" || deployment.headlessAppHost ? BUILTIN_CODEX_CONVERSATION_HOST : null;
}

/** Startup Host: an explicit route wins, then the remembered selection, then the deployment default. */
export function chooseInitialConversationHost(input: {
  readonly profiles: readonly HostConnectionProfile[];
  readonly requestedHostId?: string;
  readonly persistedHostId: string | null;
  readonly persistedHasThread: boolean;
  readonly deploymentDefaultHostId?: string | null;
}): string | undefined {
  const { profiles, requestedHostId, persistedHostId } = input;
  if (requestedHostId !== undefined && profiles.some((host) => host.hostId === requestedHostId)) return requestedHostId;
  if (
    profiles.some(
      (host) => host.hostId === persistedHostId && (host.hideFromNewChat !== true || input.persistedHasThread),
    )
  )
    return persistedHostId!;
  return chooseNewConversationHost(profiles, null, input.deploymentDefaultHostId)?.hostId;
}
