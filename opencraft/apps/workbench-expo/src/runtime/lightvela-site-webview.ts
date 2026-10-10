// First-party external browser destinations. No remote WebView or credential injection.
import { LIGHTVELA_REGIONS, type LightVelaRegion } from "@opencraft/plugin-lightvela-hermes/account-contract";

export const lightVelaSiteUrl = (region: LightVelaRegion) => `${LIGHTVELA_REGIONS[region].frontendBase}/agents`;
export const LIGHTVELA_SITE_URL = lightVelaSiteUrl("intl");
export type LightVelaSiteTab = "agents" | "account" | "billing";
const SITE_TAB_PATHS: Record<LightVelaSiteTab, string> = {
  agents: "/agents",
  account: "/account",
  billing: "/account/billing",
};
export const lightVelaSiteTabUrl = (region: LightVelaRegion, tab: LightVelaSiteTab) =>
  `${LIGHTVELA_REGIONS[region].frontendBase}${SITE_TAB_PATHS[tab]}`;

export function lightVelaSiteTabForUrl(raw: string, region: LightVelaRegion): LightVelaSiteTab | null {
  try {
    const origin = LIGHTVELA_REGIONS[region].frontendBase;
    const url = new URL(raw, origin);
    if (url.origin !== origin) return null;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === SITE_TAB_PATHS.billing || path.startsWith(`${SITE_TAB_PATHS.billing}/`)) return "billing";
    if (path === SITE_TAB_PATHS.account || path.startsWith(`${SITE_TAB_PATHS.account}/`)) return "account";
    if (path === SITE_TAB_PATHS.agents || path.startsWith(`${SITE_TAB_PATHS.agents}/`)) return "agents";
  } catch { /* Untrusted location is not a tab. */ }
  return null;
}
