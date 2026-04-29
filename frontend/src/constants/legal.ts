export const ICP_LICENSE = "京ICP备11018762号-1137";
export const BEIAN_URL = "https://beian.miit.gov.cn/";

/**
 * 是否需要展示 ICP 备案号。
 *
 * 按监管要求，所有解析到中国大陆的域名都需要悬挂备案号，
 * 包括 lightvela.com（国际站域名但有国内备案）和 lightvela.cn（国内站）。
 *
 * 使用运行时 hostname 判断，而非编译期 REGION，
 * 避免同一份构建产物在不同域名下行为不一致。
 */
export const shouldShowICP = (): boolean => {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return (
    h === "lightvela.com" ||
    h === "www.lightvela.com" ||
    h === "lightvela.cn" ||
    h === "www.lightvela.cn" ||
    h === "preview.lightvela.cn" ||
    h === "lightvela.tencent.com" ||
    h === "www.lightvela.tencent.com" ||
    h === "lightclaw.tech" ||
    h === "www.lightclaw.tech" ||
    h === "lightclaw.cn" ||
    h === "preview.lightclaw.cn" ||
    h === "localhost" ||
    h === "127.0.0.1"
  );
};
