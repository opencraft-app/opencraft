import { LightVelaAccountService } from "@opencraft/plugin-lightvela-hermes";
import type { MobileLightVelaAccount } from "./lightvela-account-types";

export function createMobileLightVelaAccount(): MobileLightVelaAccount {
  const account = new LightVelaAccountService();
  return {
    getSnapshot() {
      const value = account.getSnapshot();
      return {
        revision: value.revision,
        region: value.region,
        phase: value.phase,
        botCount: value.bots.length,
        activeBotId: value.activeBotId,
        botName: value.bots.find(bot => bot.instanceId === value.activeBotId)?.name ?? null,
        error: value.error,
      };
    },
    subscribe: account.subscribe,
    async initialize() {
      account.bootstrapOAuthFragment();
      if (account.hasStoredSession()) await account.refreshBots();
    },
    async signIn() { account.signIn(); },
    async signOut() { account.signOut(); },
    async retry() { await account.refreshBots(); },
    request: account.request.bind(account),
    resolveActiveBot: account.resolveActiveBot.bind(account),
    dispose: () => account.dispose(),
  };
}

export type { MobileLightVelaAccount, MobileLightVelaSnapshot } from "./lightvela-account-types";
