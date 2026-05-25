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
 *     因此**切换 SDK 语言必须刷新页面**
 *
 * ## 同步初始化的关键
 *
 * tea-app 的 `t(sentence)` 内部调 `i18next.t(key, { defaultValue: sentence })`，
 * 但 i18next 在**未 init 状态**下 `t()` 会返回 `undefined`（即使传 defaultValue
 * 也无效）。SDK 内部的 `MODEL_PROVIDER_LIST` / `getHermesChannelList` 等数据源
 * 在首次访问时调用 `t()` 求值并缓存——如果 i18n 还没初始化，缓存里就会有
 * 一堆 `undefined` 字段，导致 ChannelPanel 的 `.filter(ch => ch.primaryLabel)`
 * 把整条目过滤掉。
 *
 * 因此：
 *   1. **同步副作用阶段**：根据 `isEnglishEnv` 设置 `window.VERSION = "en"`，
 *      并**同步 import** 英文词条 + 同步调用 `initI18n({ translation })`。
 *      不能用 `await import('en')` 异步加载，否则会被 React 渲染抢跑。
 *   2. 中文环境：直接 `initI18n()` 空词条（t 返回 key 字面值 = 中文源码原文）。
 *
 * 静态 import 也允许 Rollup 在生产构建时直接把英文词条打进对应 chunk，
 * 避免 SDK 自动 init 的 tree-shake 风险。
 */
import { isGlobal } from "@/lib/region";
import { initI18n } from "@tencent/tea-sdk-lightclaw";
// 静态 import 英文词条：vite.config 已通过 sdkI18nPlugin 把 CJS 转成
// ESM，并在 alias 里把 `@tencent/tea-sdk-lightclaw/i18n/translation/en`
// 指向具体文件。这一行**必须**保留为静态 import——异步 `await import(...)`
// 会被 React 渲染抢跑，导致 SDK 模块缓存里的 t() 求值出 undefined。
import { translation as enTranslation } from "@tencent/tea-sdk-lightclaw/i18n/translation/en";

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

// ── 步骤 1：同步设置 window.VERSION ──
// tea-app 的 i18n 模块在加载时一次性读取 window.VERSION 决定 lng。
// 必须在任何 import @tencent/tea-app 的代码执行之前赋值（即本模块作为页面
// 的第一个 import）。
if (isEnglishEnv) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).VERSION = "en";
}

// ── 步骤 2：同步注册 SDK i18n 词条 ──
// 必须在任何 SDK 子模块（如 hermes.ts 的 buildHermesChannelList）首次
// 调用 `t()` 之前完成；否则 i18next 未 init 状态下 t() 返回 undefined。
// 因 SDK 内部用 `let cachedI18nList = ...` 模块级缓存，第一次返回 undefined
// 后无法纠正——必须卡在 React 渲染之前同步完成 init。
if (isEnglishEnv) {
  initI18n({ translation: enTranslation });
} else {
  initI18n();
}
