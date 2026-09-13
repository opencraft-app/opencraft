import {
  LightVelaRegionSwitchRequiresSignOutError,
  type LightVelaAccountService,
  type LightVelaRegion,
} from "../account/lightvela-account-service";

export const LIGHTVELA_REGION_REQUIRES_SIGN_OUT_MESSAGE = "请先退出登录，再切换登录站点。";

export function selectLightVelaLoginRegion(
  account: Pick<LightVelaAccountService, "selectRegion">,
  region: LightVelaRegion,
): string | null {
  try {
    account.selectRegion(region);
    return null;
  } catch (error) {
    if (error instanceof LightVelaRegionSwitchRequiresSignOutError) {
      return LIGHTVELA_REGION_REQUIRES_SIGN_OUT_MESSAGE;
    }
    throw error;
  }
}
