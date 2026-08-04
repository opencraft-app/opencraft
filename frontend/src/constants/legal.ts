import { isCN } from "@/lib/region";

export const ICP_LICENSE = "京ICP备11018762号-1137";
export const BEIAN_URL = "https://beian.miit.gov.cn/#/Integrated/index";
export const CN_PRIVACY_POLICY_URL =
  "https://privacy.qq.com/document/preview/a955b796edc34796b6e81d4f4df006f3";
export const CN_TERMS_OF_SERVICE_URL =
  "https://cloud.tencent.com/document/product/301/48034";
export const GLOBAL_TERMS_OF_SERVICE_BASE_URL =
  "https://www.tencentcloud.com/document/product/301/12905";

export const getGlobalTermsOfServiceUrl = (locale?: string): string => {
  const lowerLocale = locale?.toLowerCase();
  const lang = lowerLocale?.startsWith("zh") ? "zh" : "en";
  return `${GLOBAL_TERMS_OF_SERVICE_BASE_URL}?lang=${lang}&pg=`;
};

/**
 * 是否需要展示 ICP 备案号。
 *
 * ICP 备案号只属于国内站，国际站构建和预览环境均不展示。
 */
export const shouldShowICP = (): boolean => {
  return isCN;
};
