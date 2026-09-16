import type { AppServerBotDirectoryHost } from "@opencraft/bot-conversation-appserver";
import type { HostConnectionProfile } from "@opencraft/workbench-runtime";

/** Bot management is a LightVela product surface, not a generic Host picker. */
export function resolveCloudHermesBotHost(
  profiles: readonly HostConnectionProfile[],
  hosts: readonly AppServerBotDirectoryHost[],
): string | null {
  const cloud = profiles.filter(profile => profile.enabled && profile.providerId === "lightvela.hermes");
  const connected = cloud.filter(profile => hosts.some(host => host.hostId === profile.hostId && host.canManageBots));
  if (connected.length === 1) return connected[0]!.hostId;
  return cloud.length === 1 ? cloud[0]!.hostId : null;
}

export function connectCloudHermesBotHost(
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
