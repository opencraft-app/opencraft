import type {
  HostConnectionJson,
  HostConnectionProvider,
} from "@opencraft/workbench-runtime";
import { throwIfSignalAborted } from "@opencraft/workbench-runtime";

import type { LightVelaAccountService } from "../account/lightvela-account-service";
import type { HermesSessionTokenCache } from "../lib/hermes-session-token-cache";
import { LightVelaHermesTransport, type LightVelaAccountPort } from "../transport/lightvela-hermes-transport";
import type { LightVelaRegion } from "../account/lightvela-account-contract";

export interface LightVelaHermesHostConfig {
  readonly dashboardUrl?: string;
  readonly instanceId?: string;
  readonly region?: LightVelaRegion;
  readonly accountId?: string;
}

function validateConfig(config: HostConnectionJson): LightVelaHermesHostConfig & HostConnectionJson {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new TypeError("LightVela Hermes Host config must be an object");
  }
  const record = config as Readonly<Record<string, HostConnectionJson>>;
  if (record.accountId !== undefined && (typeof record.accountId !== "string" || !record.accountId.trim() || !record.instanceId)) throw new TypeError("Invalid LightVela account binding");
  if (record.dashboardUrl !== undefined && typeof record.dashboardUrl !== "string") {
    throw new TypeError("LightVela Hermes dashboard URL must be a string");
  }
  if (record.instanceId !== undefined && (typeof record.instanceId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(record.instanceId))) throw new TypeError("Invalid LightVela instance ID");
  if (record.instanceId !== undefined && record.region !== "cn" && record.region !== "intl") throw new TypeError("An explicit instance requires its account region");
  return Object.freeze({
    ...(record.instanceId === undefined ? {} : { instanceId: record.instanceId, region: record.region }),
    ...(record.accountId === undefined ? {} : {accountId: record.accountId}),
    ...(typeof record.dashboardUrl === "string" && record.dashboardUrl.trim()
      ? { dashboardUrl: record.dashboardUrl.trim() }
      : {}),
  }) as LightVelaHermesHostConfig & HostConnectionJson;
}

/** Explicit environments never follow the legacy account-wide activeBotId selection. */
export function environmentAccountPort(account: LightVelaAccountService, config: LightVelaHermesHostConfig): LightVelaAccountPort {
  if (!config.instanceId) return account;
  const checkRegion = () => {
    if (account.getSnapshot().region !== config.region) throw new Error("请登录此环境所属站点的 LightVela 账号。");
    if (config.accountId && account.getSnapshot().details.profile?.id !== config.accountId) throw new Error("请登录此环境所属的 LightVela 账号。");
  };
  return {
    subscribe: account.subscribe,
    getSnapshot: () => {
      const snapshot = account.getSnapshot();
      return { ...snapshot, activeBotId: snapshot.region === config.region && (!config.accountId || snapshot.details.profile?.id === config.accountId) && snapshot.bots.some(bot => bot.instanceId === config.instanceId) ? config.instanceId! : null };
    },
    request: (path, init) => { checkRegion(); return account.request(path, init); },
    resolveActiveBot: async () => {
      checkRegion(); const result = await account.resolveActiveBot(config.instanceId); checkRegion(); return result;
    },
  };
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
    preflight(config, _context, { signal }) {
      throwIfSignalAborted(signal);
      const normalized = validateConfig(config);
      const snapshot = account.getSnapshot();
      const target = normalized.instanceId ?? snapshot.activeBotId;
      if (normalized.instanceId && snapshot.region !== normalized.region) throw new Error("LightVela account region mismatch");
      if (normalized.accountId && snapshot.details.profile?.id !== normalized.accountId) throw new Error("LightVela account identity mismatch");
      const activeBot = target === null
        ? undefined
        : snapshot.bots.find((bot) => bot.instanceId === target);
      if (snapshot.phase !== "authenticated" || activeBot === undefined) {
        throw new Error("No running LightVela Hermes Bot is available");
      }
    },
    createTransport(config) {
      const normalized = validateConfig(config);
      return new LightVelaHermesTransport({
        account: environmentAccountPort(account, normalized),
        dashboardUrl: normalized.dashboardUrl,
        sessionTokenCache,
      });
    },
  };
}
