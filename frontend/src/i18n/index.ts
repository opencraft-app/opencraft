/**
 * i18n 初始化入口
 * ──────────────────────────────────────────────────────────────
 * 文案走「中文即 key」方案：
 *   - 业务侧调用 `useT()`，参数为中文原文：t("立即创建")
 *   - 运行时通过 generated/zh-to-key.json 反查成 hash key
 *   - 再向 i18next 查询 hash → 目标语言
 *
 * 字典文件由 `pnpm i18n:extract` 扫描源码生成，放在 src/i18n/generated/
 *   - zh-CN.json：hash → 中文
 *   - <语种>.json：hash → 译文
 *   - zh-to-key.json：中文 → hash（仅运行时反查用）
 *
 * 设计要点：
 *   - **语种清单来自 `locales.config.ts` 注册表**，本文件不再自持一份副本
 *   - 默认语言由 `src/lib/region.ts` 根据 `VITE_REGION` 编译期决定
 *   - 国际站浏览器侧可通过 `localStorage.setItem('lw-locale', 'en-US')` 覆盖
 *   - 国内站固定中文，忽略跨站点遗留的语言覆盖
 *
 * 不做的事（保持简单）：
 *   - 不接 `i18next-browser-languagedetector`
 *   - 不做懒加载 / 分包（文案整体体积很小，直接静态 import 更快）
 *     注意：语种增多后需复测首屏体积，必要时改为按 locale 分包。
 */

import i18n from "i18next";
import type { Resource } from "i18next";
import { initReactI18next } from "react-i18next";

import { DEFAULT_LOCALE, isGlobal, readLocaleFromPath } from "@/lib/region";
import {
  type I18nDictKey,
  type LocaleCode,
  localeDefinition,
  parseLocaleCode,
} from "./locales.config";
import enUS from "./generated/en-US.json";
import es from "./generated/es.json";
import idID from "./generated/id-ID.json";
import jaJP from "./generated/ja-JP.json";
import koKR from "./generated/ko-KR.json";
import zhCN from "./generated/zh-CN.json";
import zhHant from "./generated/zh-Hant.json";

/**
 * 字典文件映射。
 *
 * 这是全项目**唯一**需要在新增语种时补充静态 import 的地方——因为
 * 打包器要求 import 路径为字面量，无法用注册表数据动态拼接。
 *
 * 类型为 `Record<I18nDictKey, …>`，因此注册表新增字典语种而此处
 * 未补 import 时，`tsc` 会直接报错，不会静默缺失字典。
 */
const DICTIONARIES: Record<I18nDictKey, Record<string, string>> = {
  "en-US": enUS,
  "zh-CN": zhCN,
  "zh-Hant": zhHant,
  "id-ID": idID,
  es,
  "ja-JP": jaJP,
  "ko-KR": koKR,
};

/**
 * i18next 支持的 locale 类型。
 *
 * 保留此别名以兼容既有调用方（如 `setLocale('en-US')`）；
 * 实际取值范围由注册表定义。
 */
export type SupportedLocale = LocaleCode;

/** 本地存储 key，用户手动切换语言时持久化 */
const LOCALE_STORAGE_KEY = "lw-locale";

/**
 * 读取用户手动覆盖的语言（若存在）。
 *
 * 返回值经注册表白名单校验：`localStorage` 可能残留已下线的 locale，
 * 或被人为篡改成任意字符串，直接用于设置语言/拼接路径是不安全的。
 */
const readOverride = (): LocaleCode | null => {
  if (typeof window === "undefined") return null;
  try {
    return parseLocaleCode(window.localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return null;
  }
};

/**
 * 初始语言优先级（仅国际站涉及多语言；国内站固定中文）：
 *   1. URL 路径前缀（/en-us/...、/zh-sg/...、/ja-jp/... 等；兼容旧 /en、/zh）
 *      —— 给搜索引擎跳转 / 直接外链使用
 *   2. 国际站裸 / 固定使用区域默认英文，避免陈旧 localStorage 把首页首屏改成中文
 *   3. localStorage 用户手动覆盖
 *   4. 区域默认（国际站默认英文，国内站默认中文）
 */
const pathnameForInitialLocale =
  typeof window !== "undefined" ? window.location.pathname : null;

const initialLocaleFromPath =
  pathnameForInitialLocale ? readLocaleFromPath(pathnameForInitialLocale) : null;

const shouldUseDefaultLocaleForBarePublicRoot =
  pathnameForInitialLocale === "/" && DEFAULT_LOCALE === "en-US";

const initialLocale: LocaleCode =
  (isGlobal
    ? initialLocaleFromPath ??
      (shouldUseDefaultLocaleForBarePublicRoot ? DEFAULT_LOCALE : readOverride())
    : null) ??
  DEFAULT_LOCALE;

/**
 * 从带语言前缀的公开页进入时，把该语言持久化下来。
 *
 * 原因：控制台等路径（/agents、/auth 等）刻意不做 URL 本地化
 * （见 PUBLIC_LOCALIZED_PATH_PREFIXES），因此无法从路径推断语言，
 * 只能依赖 localStorage。若用户从 /ja-jp/subscribe 直接跳到 /agents，
 * 而此前从未手动切换过语言，localStorage 为空会导致回退英文。
 * 这里把「URL 已明确表达的语言意图」写入存储，保证跨路径连续性。
 */
if (initialLocaleFromPath && typeof window !== "undefined") {
  try {
    if (window.localStorage.getItem(LOCALE_STORAGE_KEY) !== initialLocaleFromPath) {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, initialLocaleFromPath);
    }
  } catch {
    /* 隐私模式等场景 localStorage 不可用，忽略 */
  }
}

/**
 * 把 locale 解析为实际使用的字典 key。
 *
 * `zh-SG` 没有独立字典，其 `i18nKey` 指向 `zh-CN`；此处统一走注册表，
 * 避免调用方各自用 `startsWith('zh')` 猜测。
 */
const dictKeyForLocale = (locale: LocaleCode): I18nDictKey =>
  localeDefinition(locale).i18nKey;

/** 按注册表装配 i18next resources，新增字典语种无需改这段循环。 */
const resources: Resource = Object.fromEntries(
  Object.entries(DICTIONARIES).map(([dictKey, translation]) => [dictKey, { translation }]),
);

void i18n.use(initReactI18next).init({
  resources,
  lng: dictKeyForLocale(initialLocale),
  fallbackLng: "zh-CN",
  interpolation: {
    /* React 已自动转义，无需二次转义 */
    escapeValue: false,
  },
  /* 关闭 missing key 告警；t.ts 里对未收录中文有自己的 warn 机制 */
  saveMissing: false,
  returnNull: false,
});

/**
 * 手动切换语言并持久化
 * @example setLocale('ja-JP')
 */
export const setLocale = (locale: SupportedLocale): void => {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* 隐私模式等场景 localStorage 不可用，忽略 */
  }
  /* 切到实际字典 key：zh-SG 需落到 zh-CN，否则 i18next 找不到资源。 */
  void i18n.changeLanguage(dictKeyForLocale(locale));
};

export default i18n;

/* ──────────────────────────────────────────────────────────────
 * TypeScript 类型增强
 * ──────────────────────────────────────────────────────────────
 * 让 `t('landing.hero.title_line1')` 拥有自动补全与错误提示。
 * 任何拼错的 key 都会在编译期报错。
 */
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: typeof zhCN;
    };
  }
}
