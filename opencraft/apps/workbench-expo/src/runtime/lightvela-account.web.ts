import { LightVelaAccountService } from "@opencraft/plugin-lightvela-hermes";
import type { LightVelaRegion } from "@opencraft/plugin-lightvela-hermes/account-contract";
import type { MobileLightVelaAccount } from "./lightvela-account-types";

export function createMobileLightVelaAccount(_packagedRegion?: LightVelaRegion, _loginRedirect?: string): MobileLightVelaAccount {
  const account = new LightVelaAccountService();
  return {
    getSnapshot() {
      const value = account.getSnapshot();
      return {
        revision: value.revision,
        region: value.region,
        phase: value.phase,
        loginPending: false,
        botCount: value.bots.length,
        activeBotId: value.activeBotId,
        botName: value.bots.find(bot => bot.instanceId === value.activeBotId)?.name ?? null,
        error: value.error,
      };
    },
    getAuthenticatedSession() { return null; },
    subscribe: account.subscribe,
    async initialize() {
      account.bootstrapOAuthFragment();
      if (account.hasStoredSession()) await account.refreshBots();
    },
    async selectRegion(region: LightVelaRegion) { account.selectRegion(region); },
    async signIn() { account.signIn(); },
    async cancelSignIn() { await account.cancelSignIn(); },
    async signOut() { account.signOut(); },
    async retry() { await account.refreshBots(); },
    async webSessionToken() { return null; },
    request: account.request.bind(account),
    resolveActiveBot: account.resolveActiveBot.bind(account),
    dispose: () => account.dispose(),
  };
}

export type { MobileLightVelaAccount, MobileLightVelaSnapshot } from "./lightvela-account-types";
