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
import { shouldLocalizePublicPath } from "../lib/public-site-routing";
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
 *   2. 国际站「裸路径 + 该路径本身支持 URL 本地化」固定使用区域默认英文，
 *      避免陈旧 localStorage 把首屏改成中文
 *   3. localStorage 用户手动覆盖（仅用于 /agents、/auth 等刻意不做 URL
 *      本地化的控制台路由——这些路由没有 URL 语言信号，只能靠它续命）
 *   4. 区域默认（国际站默认英文，国内站默认中文）
 *
 * 注意第 2 条不能只覆盖根路径 `/`：`shouldLocalizePublicPath` 白名单里的
 * `/subscribe`、`/docs`、`/about` 等页面裸路径同样代表「默认语言版本」
 * （`publicSiteHref` 生成英文链接时就是省掉前缀的裸路径）。曾经这里只判断
 * `pathname === "/"`，导致首页能看到正确的英文，但点击 CTA 跳到裸的
 * `/subscribe` 后又读到陈旧的 localStorage `zh-CN`，页面从英文突然跳回
 * 简体中文——首页的特殊判断反而把这个 bug 掩盖了下来。
 */
const pathnameForInitialLocale =
  typeof window !== "undefined" ? window.location.pathname : null;

const initialLocaleFromPath = parseRuntimeLocaleCode(
  pathnameForInitialLocale ? readLocaleFromPath(pathnameForInitialLocale) : null,
  RUNTIME_LOCALE_OPTIONS,
);

const shouldUseDefaultLocaleForBarePublicPath =
  DEFAULT_LOCALE === "en-US" &&
  pathnameForInitialLocale !== null &&
  shouldLocalizePublicPath(pathnameForInitialLocale);

const initialLocale: LocaleCode =
  (isGlobal
    ? initialLocaleFromPath ??
      (shouldUseDefaultLocaleForBarePublicPath ? DEFAULT_LOCALE : readOverride())
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
 * 从「已明确表达语言意图的公开页」进入时，把该语言持久化下来。
 *
 * 原因：控制台等路径（/agents、/auth 等）刻意不做 URL 本地化
 * （见 PUBLIC_LOCALIZED_PATH_PREFIXES），因此无法从路径推断语言，
 * 只能依赖 localStorage。若用户从公开页跳到 /agents，localStorage 里没有
 * 或残留了别的语言，控制台就会显示错误语种。这里把当前公开页已确定的语言
 * 写入存储，保证跨路径连续性。
 *
 * 两类「明确的语言意图」都要持久化：
 * 1. URL 带语言前缀（/ja-jp/subscribe 等）→ 写该前缀语言；
 * 2. 国际站「裸公开页」（无前缀，如英文默认版 / 或 /subscribe）且判定为默认英文
 *    → 写 en-US。这一条不能漏：英文是默认语、走裸 URL，initialLocaleFromPath
 *    恒为空，若不在此处持久化，英文用户永远不会写 lw-locale，一旦存储里残留了
 *    旧的中文值（例如此前浏览过 /zh-sg/），点 CTA 进 /agents 就会显示成中文。
 */
const localeIntentFromPage =
  initialLocaleFromPath ??
  (shouldUseDefaultLocaleForBarePublicPath ? DEFAULT_LOCALE : null);
if (localeIntentFromPage && typeof window !== "undefined") {
  try {
    if (window.localStorage.getItem(LOCALE_STORAGE_KEY) !== localeIntentFromPage) {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, localeIntentFromPage);
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
