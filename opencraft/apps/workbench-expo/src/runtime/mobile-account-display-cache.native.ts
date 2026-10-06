import * as Crypto from "expo-crypto";
import Storage from "expo-sqlite/kv-store";
import type { AccountOverviewModel } from "@opencraft/mobile-account-sdk";
import { parseAccountDisplay, projectAccountDisplay, type AccountDisplaySnapshot } from "@opencraft/mobile-account-sdk/display-cache";
import type { LightVelaRegion } from "@opencraft/plugin-lightvela-hermes/account-contract";

async function key(region: LightVelaRegion, token: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, token);
  return `lightvela.account-display.v1.${region}.${digest}`;
}

export const mobileAccountDisplayCache = {
  async scope(region: LightVelaRegion, token: string) { return key(region, token); },
  async read(region: LightVelaRegion, token: string): Promise<AccountDisplaySnapshot | null> {
    try {
      const storageKey = await key(region, token);
      const value = await Storage.getItemAsync(storageKey);
      return value === null ? null : parseAccountDisplay(JSON.parse(value) as unknown, region, Date.now());
    } catch { return null; }
  },
  async write(region: LightVelaRegion, token: string, model: AccountOverviewModel): Promise<void> {
    const storageKey = await key(region, token);
    await Storage.setItemAsync(storageKey, JSON.stringify(projectAccountDisplay(model, region, Date.now())));
  },
  async clear(region: LightVelaRegion, token: string): Promise<void> {
    await Storage.removeItemAsync(await key(region, token));
  },
};
