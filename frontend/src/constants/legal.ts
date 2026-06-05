export const ICP_LICENSE = "京ICP备11018762号-1137";
export const BEIAN_URL = "https://beian.miit.gov.cn/";
export const CN_PRIVACY_POLICY_URL =
  "https://privacy.qq.com/document/preview/a955b796edc34796b6e81d4f4df006f3";

/**
 * 是否需要展示 ICP 备案号。
 *
 * 采用黑名单策略：**默认展示**，仅在明确的海外 / 预览域名上隐藏。
 * 这样新增国内域名时不会漏展备案号（合规风险 > 多展示一行文字）。
 *
 * 使用运行时 hostname 判断，而非编译期 REGION，
 * 避免同一份构建产物在不同域名下行为不一致。
 */
const ICP_EXCLUDED_HOSTNAMES: readonly string[] = [
  /* 国际站域名 */
  "lightvela.ai",
  /* 国际站 Cloudflare Pages 预览域名 */
  "lightvela-intl.pages.dev",
  /* 未来可能的纯海外域名，按需追加 */
];

export const shouldShowICP = (): boolean => {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return !ICP_EXCLUDED_HOSTNAMES.some(
    (excluded) => h === excluded || h.endsWith(`.${excluded}`),
  );
};
