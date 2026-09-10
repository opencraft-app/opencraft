import type {
  HostConnectionJson,
  HostConnectionProvider,
} from "@opencraft/workbench-runtime";
import { throwIfSignalAborted } from "@opencraft/workbench-runtime";

import type { LightVelaAccountService } from "../account/lightvela-account-service";
import type { HermesSessionTokenCache } from "../lib/hermes-session-token-cache";
import { LightVelaHermesTransport } from "../transport/lightvela-hermes-transport";

export interface LightVelaHermesHostConfig {
  readonly dashboardUrl?: string;
}

function validateConfig(config: HostConnectionJson): LightVelaHermesHostConfig & HostConnectionJson {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new TypeError("LightVela Hermes Host config must be an object");
  }
  const record = config as Readonly<Record<string, HostConnectionJson>>;
  if (record.dashboardUrl !== undefined && typeof record.dashboardUrl !== "string") {
    throw new TypeError("LightVela Hermes dashboard URL must be a string");
  }
  return Object.freeze({
    ...(typeof record.dashboardUrl === "string" && record.dashboardUrl.trim()
      ? { dashboardUrl: record.dashboardUrl.trim() }
      : {}),
  }) as LightVelaHermesHostConfig & HostConnectionJson;
}

export function createLightVelaHermesHostProvider(
  account: LightVelaAccountService,
  sessionTokenCache?: HermesSessionTokenCache,
): HostConnectionProvider {
  return {
    id: "lightvela.hermes",
    label: "LightVela Hermes",
    settingsPageId: "lightvela.hermes.settings",
    targets: ["web", "electron"],
    configVersion: 1,
    validate: validateConfig,
    preflight(_config, _context, { signal }) {
      throwIfSignalAborted(signal);
      const snapshot = account.getSnapshot();
      const activeBot = snapshot.activeBotId === null
        ? undefined
        : snapshot.bots.find((bot) => bot.instanceId === snapshot.activeBotId);
      if (snapshot.phase !== "authenticated" || activeBot === undefined) {
        throw new Error("No running LightVela Hermes Bot is available");
      }
    },
    createTransport(config) {
      const normalized = validateConfig(config);
      return new LightVelaHermesTransport({
        account,
        dashboardUrl: normalized.dashboardUrl,
        sessionTokenCache,
      });
    },
  };
}
