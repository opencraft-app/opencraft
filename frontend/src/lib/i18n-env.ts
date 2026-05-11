/**
 * 国际化环境初始化（针对 @tencent/tea-sdk-lightclaw）
 *
 * ⚠️ 本模块必须在使用 @tencent/tea-sdk-lightclaw 的页面中最先 import。
 *
 * ## 设计原则
 *
 * 与 mono2 自身 i18n（`src/i18n/index.ts`）共用 `localStorage('lw-locale')`：
 *
 *   - **优先级**：`lw-locale`（用户主动切换）> `isGlobal`（编译期默认）
 *   - 国内站默认中文，国际站默认英文；任何站点都允许通过 LanguageSwitcher 切换
 *   - SDK 端的 tea-app i18n 是 init-once 设计（hasInited 锁定后 lng 无法热切换），
 *     因此**切换 SDK 语言必须刷新页面**——这一点由 SDK 使用页面的
 *     LanguageSwitcher 通过 `reloadAfterSwitch` prop 触发
 *
 * ## 执行顺序
 *
 * 1. **同步副作用阶段**（本模块 import 时）：
 *    根据上述优先级判定 `isEnglishEnv`，若为英文则设置 `window.VERSION = "en"`。
 *    必须在 `@tencent/tea-app` 模块加载前完成，否则 tea-app i18n 的 lng
 *    会被锁死为 "zh"。
 *
 * 2. **异步阶段**（消费方调用 `bootstrapSdkI18n()`）：
 *    - 英文环境：动态 import 英文词条 → `initI18n({ translation })`
 *    - 中文环境：`initI18n()`（空词条，t() 返回 key 字面值 = 中文源码原文）
 *
 *    SDK 中 `MODEL_PROVIDER_LIST` / `CHANNEL_LIST` 为 Proxy 惰性求值，
 *    只要在 React 首次访问之前完成 init 即可生效。
 */
import { isGlobal } from "@/lib/region";
import { initI18n } from "@tencent/tea-sdk-lightclaw";

/** 与 mono2 自身 i18n 共用的语言持久化 key（见 src/i18n/index.ts） */
const LOCALE_STORAGE_KEY = "lw-locale";

/**
 * 读取用户在 LanguageSwitcher 上手动切换并持久化的语言偏好。
 * 返回值与 mono2 i18n 的 Locale 类型对齐：'zh-CN' | 'en-US' | null（未设置）。
 */
function readStoredLocale(): "zh-CN" | "en-US" | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return v === "zh-CN" || v === "en-US" ? v : null;
  } catch {
    return null;
  }
}

/**
 * 是否英文环境。
 *
 * 决策表：
 *   | lw-locale | isGlobal | isEnglishEnv |
 *   | --------- | -------- | ------------ |
 *   | en-US     | -        | true         |
 *   | zh-CN     | -        | false        |
 *   | (未设置)   | true     | true         |
 *   | (未设置)   | false    | false        |
 */
export const isEnglishEnv: boolean = (() => {
  const stored = readStoredLocale();
  if (stored === "en-US") return true;
  if (stored === "zh-CN") return false;
  return isGlobal;
})();

// 同步副作用：tea-app 的 i18n 模块在加载时一次性读取 window.VERSION 决定 lng。
// 必须在任何 import @tencent/tea-app 的代码执行之前赋值（即本模块作为页面
// 的第一个 import）。
if (isEnglishEnv) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).VERSION = "en";
}

/**
 * 初始化 SDK i18n 词条。
 *
 * - 英文环境：异步加载英文词条后调用 SDK 的 `initI18n({ translation })`
 * - 中文环境：同步空词条 init，`t()` 返回 key 字面值（=中文源码原文）
 *
 * 多次调用安全（SDK initI18n 内部有幂等保护）。Promise 通常无需 await——
 * 模块顶层 `void bootstrapSdkI18n()` 即可，配合 SDK 内部 Proxy 惰性求值，
 * 组件首次访问列表时词条已就绪。
 */
export async function bootstrapSdkI18n(): Promise<void> {
  if (isEnglishEnv) {
    const { translation } = await import(
      "@tencent/tea-sdk-lightclaw/i18n/translation/en"
    );
    initI18n({ translation });
  } else {
    initI18n();
  }
}
