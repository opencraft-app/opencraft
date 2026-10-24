import type { AppServerBotDirectoryHost } from "@opencraft/bot-conversation-appserver";
import type { HostConnectionProfile } from "@opencraft/workbench-runtime";
import type { ResolvedBotManagementPolicy } from "@opencraft/client-product";

export function eligibleBotManagementProfiles(
  profiles: readonly HostConnectionProfile[],
  policy: ResolvedBotManagementPolicy,
): readonly HostConnectionProfile[] {
  return profiles.filter(profile => profile.enabled
    && (policy.providerIds === undefined || policy.providerIds.includes(profile.providerId)));
}

/** Eligibility selects candidates; only the Host directory reports actual capability. */
export function resolveBotManagementHost(
  profiles: readonly HostConnectionProfile[],
  hosts: readonly AppServerBotDirectoryHost[],
): string | null {
  const eligible = profiles.filter(profile => profile.enabled);
  const connected = eligible.filter(profile => hosts.some(host => host.hostId === profile.hostId && host.canManageBots));
  if (connected.length === 1) return connected[0]!.hostId;
  return eligible.length === 1 ? eligible[0]!.hostId : null;
}

export function connectBotManagementHost(
  connect: Promise<void>,
  timeoutMs = 15_000,
  currentReason: () => string | null = () => null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      const reason = currentReason()?.trim();
      reject(new Error(
        `加载 Bots 超时${reason ? `：${reason}` : "。"}后台任务仍在进行，请稍后重试。`,
      ));
    }, timeoutMs);
    connect.then(
      () => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve();
      },
      error => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}
