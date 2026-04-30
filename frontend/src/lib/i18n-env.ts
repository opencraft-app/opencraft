/**
 * 国际化环境初始化
 *
 * ⚠️ 本模块必须在使用 @tencent/tea-sdk-lightclaw 的页面中最先 import。
 *
 * 执行顺序：
 * 1. 检测语言环境 → 设置 window.VERSION（tea-app 模块加载时读取此值决定 lng）
 * 2. import initI18n + 英文词条（此时 tea-app 模块被加载，读到 VERSION="en"）
 * 3. 调用 initI18n() 注册词条到 i18next
 *
 * 这样当 SDK 其他模块（moltbot.ts 等）在模块顶层执行 t() 时，
 * i18next 已经初始化完毕且注册了正确语言的词条。
 *
 * 支持 ?lang=en URL 参数手动切换（优先级高于 navigator.language）。
 */
const urlLang = new URLSearchParams(window.location.search).get("lang");
export const isEnglishEnv =
  urlLang === "en" || (!urlLang && !navigator.language.startsWith("zh"));

if (isEnglishEnv) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).VERSION = "en";
}
