// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
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
 * 加载策略：
 *   - 不接 `i18next-browser-languagedetector`
 *   - 已发布语种同步装载，保证既有首屏行为不变
 *   - 尚未发布的日语/韩语按需分包；发布前性能门禁证明日语若同步装载会让
 *     首页 gzip JS 增加超过 100 KB
 */

import i18n from "i18next";
import type { Resource } from "i18next";
import { initReactI18next } from "react-i18next";

import { DEFAULT_LOCALE, isGlobal, readLocaleFromPath } from "../lib/region";
import {
  type I18nDictKey,
  type LocaleCode,
  localeDefinition,
  parseRuntimeLocaleCode,
} from "./locales.config";
import enUS from "./generated/en-US.json";
import es from "./generated/es.json";
import idID from "./generated/id-ID.json";
import zhCN from "./generated/zh-CN.json";
import zhHant from "./generated/zh-Hant.json";

type TranslationDictionary = Record<string, string>;

/**
 * 首屏同步字典与按需字典。
 *
 * 动态 import 仍保持字面量路径，确保打包器生成独立 chunk。日语或韩语
 * 成为当前 URL / 用户选择时才下载；已发布既有语种继续同步可用。
 */
const EAGER_DICTIONARIES: Partial<Record<I18nDictKey, TranslationDictionary>> = {
  "en-US": enUS,
  "zh-CN": zhCN,
  "zh-Hant": zhHant,
  "id-ID": idID,
  es,
};

const LAZY_DICTIONARY_LOADERS: Partial<
  Record<I18nDictKey, () => Promise<TranslationDictionary>>
> = {
  "ja-JP": async () => (await import("./generated/ja-JP.json")).default,
  "ko-KR": async () => (await import("./generated/ko-KR.json")).default,
};

const dictionaryCache: Partial<Record<I18nDictKey, TranslationDictionary>> = {
  ...EAGER_DICTIONARIES,
};
const dictionaryLoads = new Map<I18nDictKey, Promise<TranslationDictionary>>();

/**
 * i18next 支持的 locale 类型。
 *
 * 保留此别名以兼容既有调用方（如 `setLocale('en-US')`）；
 * 实际取值范围由注册表定义。
 */
export type SupportedLocale = LocaleCode;

/** 本地存储 key，用户手动切换语言时持久化 */
const LOCALE_STORAGE_KEY = "lw-locale";

const RUNTIME_LOCALE_OPTIONS = {
  region: isGlobal ? "global" : "cn",
  isProduction: process.env.NODE_ENV === "production",
  previewLocales: process.env.NEXT_PUBLIC_PREVIEW_LOCALES,
} as const;

/**
 * 读取用户手动覆盖的语言（若存在）。
 *
 * 返回值经注册表白名单校验：`localStorage` 可能残留已下线的 locale，
 * 或被人为篡改成任意字符串，直接用于设置语言/拼接路径是不安全的。
 */
const readOverride = (): LocaleCode | null => {
  if (typeof window === "undefined") return null;
  try {
    return parseRuntimeLocaleCode(
      window.localStorage.getItem(LOCALE_STORAGE_KEY),
      RUNTIME_LOCALE_OPTIONS,
    );
  } catch {
    return null;
  }
};

/** `zh-SG` 等公开 locale 统一解析到实际字典 key。 */
const dictKeyForLocale = (locale: LocaleCode): I18nDictKey =>
  localeDefinition(locale).i18nKey;

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

const initialLocaleFromPath = parseRuntimeLocaleCode(
  pathnameForInitialLocale ? readLocaleFromPath(pathnameForInitialLocale) : null,
  RUNTIME_LOCALE_OPTIONS,
);

const shouldUseDefaultLocaleForBarePublicRoot =
  pathnameForInitialLocale === "/" && DEFAULT_LOCALE === "en-US";

const initialLocale: LocaleCode =
  (isGlobal
    ? initialLocaleFromPath ??
      (shouldUseDefaultLocaleForBarePublicRoot ? DEFAULT_LOCALE : readOverride())
    : null) ??
  DEFAULT_LOCALE;

const initialDictKey = dictKeyForLocale(initialLocale);

async function loadDictionary(dictKey: I18nDictKey): Promise<TranslationDictionary> {
  const cached = dictionaryCache[dictKey];
  if (cached) return cached;

  const existingLoad = dictionaryLoads.get(dictKey);
  if (existingLoad) return existingLoad;

  const loader = LAZY_DICTIONARY_LOADERS[dictKey];
  if (!loader) throw new Error(`[i18n] missing dictionary loader: ${dictKey}`);
  const load = loader().then((dictionary) => {
    dictionaryCache[dictKey] = dictionary;
    dictionaryLoads.delete(dictKey);
    return dictionary;
  });
  dictionaryLoads.set(dictKey, load);
  return load;
}

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

/** 按注册表装配 i18next resources，新增字典语种无需改这段循环。 */
const resources: Resource = Object.fromEntries(
  Object.entries(dictionaryCache).map(([dictKey, translation]) => [dictKey, { translation }]),
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

/** 确保目标 locale 的字典已经注册，供切换器和静态渲染共用。 */
export async function ensureLocaleDictionary(locale: SupportedLocale): Promise<I18nDictKey> {
  const dictKey = dictKeyForLocale(locale);
  if (!i18n.hasResourceBundle(dictKey, "translation")) {
    const translation = await loadDictionary(dictKey);
    i18n.addResourceBundle(dictKey, "translation", translation, true, true);
  }
  return dictKey;
}

/**
 * 手动切换语言并持久化
 * @example setLocale('ja-JP')
 */
export const setLocale = (locale: SupportedLocale): void => {
  const runtimeLocale = parseRuntimeLocaleCode(locale, RUNTIME_LOCALE_OPTIONS);
  if (!runtimeLocale) return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, runtimeLocale);
  } catch {
    /* 隐私模式等场景 localStorage 不可用，忽略 */
  }
  /* 切到实际字典 key：zh-SG 需落到 zh-CN，否则 i18next 找不到资源。 */
  const dictKey = dictKeyForLocale(runtimeLocale);
  if (i18n.hasResourceBundle(dictKey, "translation")) {
    void i18n.changeLanguage(dictKey);
    return;
  }
  void ensureLocaleDictionary(runtimeLocale).then((loadedDictKey) => i18n.changeLanguage(loadedDictKey));
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
