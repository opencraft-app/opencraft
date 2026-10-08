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

import { DEFAULT_LOCALE, isGlobal, readLocaleFromPath } from "@/lib/region";
import { shouldLocalizePublicPath } from "@/lib/public-site-routing";
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
 * 国内站只发布中文：`initialLocale` 恒为 DEFAULT_LOCALE（本文件下方），构建
 * 产物也不含任何语种前缀路由，因此其余字典不进首屏。`NEXT_PUBLIC_I18N_LAZY_LOCALES`
 * 由 next.config.mjs 按构建区域内联成字面量，打包器据此把未用到的 JSON 当死代码
 * 消除。取不到该变量的环境（vitest、以及把本文件 vendoring 进去的 opencraft
 * 嵌入式工作台）保持全量同步装载，既有行为不变——不要换回直接读
 * `NEXT_PUBLIC_REGION`，嵌入式构建会把它固定替换成 "cn"，连带裁掉国际站
 * 嵌入式控制台要用的英文字典。
 *
 * 动态 import 仍保持字面量路径，确保打包器生成独立 chunk。未同步装载的语种
 * 一律留有按需通道：即便被意外请求也只是多一次异步加载，不会抛错。
 */
const EAGER_ALL_DICTIONARIES = process.env.NEXT_PUBLIC_I18N_LAZY_LOCALES !== "1";

const EAGER_DICTIONARIES: Partial<Record<I18nDictKey, TranslationDictionary>> = EAGER_ALL_DICTIONARIES
  ? {
    "en-US": enUS,
    "zh-CN": zhCN,
    "zh-Hant": zhHant,
    "id-ID": idID,
    es,
  }
  : { "zh-CN": zhCN };

const LAZY_DICTIONARY_LOADERS: Partial<
  Record<I18nDictKey, () => Promise<TranslationDictionary>>
> = {
  "ja-JP": async () => (await import("./generated/ja-JP.json")).default,
  "ko-KR": async () => (await import("./generated/ko-KR.json")).default,
  ...(EAGER_ALL_DICTIONARIES ? {} : {
    "en-US": async () => (await import("./generated/en-US.json")).default,
    "zh-Hant": async () => (await import("./generated/zh-Hant.json")).default,
    "id-ID": async () => (await import("./generated/id-ID.json")).default,
    es: async () => (await import("./generated/es.json")).default,
  }),
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
const EXPLICIT_LOCALE_STORAGE_KEY = "lw-locale-explicit";

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

const readExplicitLocaleChoice = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(EXPLICIT_LOCALE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

const savedLocaleBeforeInitialPage = readOverride();
if (typeof window !== "undefined") {
  try {
    if (savedLocaleBeforeInitialPage && savedLocaleBeforeInitialPage !== DEFAULT_LOCALE) {
      // Migrate legacy non-English choices before a bare page overwrites lw-locale.
      window.localStorage.setItem(EXPLICIT_LOCALE_STORAGE_KEY, "1");
    } else if (!savedLocaleBeforeInitialPage) {
      window.localStorage.removeItem(EXPLICIT_LOCALE_STORAGE_KEY);
    }
  } catch {
    /* 隐私模式等场景 localStorage 不可用，忽略 */
  }
}

/** Bare public pages write English for console continuity; only explicit intent suppresses the hint. */
export const hasExplicitLocalePreference = (): boolean =>
  readOverride() !== null && readExplicitLocaleChoice();

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

/*
 * 服务端会按多条 locale 路由并发渲染，共享同一个 i18n 单例，因此预载独立
 * chunk 中的字典，保证 LocaleOverrideProvider 的 SSR 首帧不回退中文。
 * 浏览器只加载当前 URL 对应字典，首页仍不会下载日语/韩语 chunk。
 */
if (typeof window === "undefined") {
  await Promise.all(
    (Object.keys(LAZY_DICTIONARY_LOADERS) as I18nDictKey[]).map(loadDictionary),
  );
} else if (!dictionaryCache[initialDictKey]) {
  await loadDictionary(initialDictKey);
}

/**
 * 从公开页进入时，把页面语言持久化下来供控制台使用。
 *
 * 原因：控制台等路径（/agents、/auth 等）刻意不做 URL 本地化
 * （见 PUBLIC_LOCALIZED_PATH_PREFIXES），因此无法从路径推断语言，
 * 只能依赖 localStorage。若用户从公开页跳到 /agents，localStorage 里没有
 * 或残留了别的语言，控制台就会显示错误语种。这里把当前公开页已确定的语言
 * 写入存储，保证跨路径连续性。
 *
 * 两类页面语言都要持久化：
 * 1. URL 带语言前缀（/ja-jp/subscribe 等）→ 写该前缀语言，并记录明确选择；
 * 2. 国际站「裸公开页」（无前缀，如英文默认版 / 或 /subscribe）且判定为默认英文
 *    → 写 en-US，但不记录明确选择。这一条不能漏：英文是默认语、走裸 URL，initialLocaleFromPath
 *    恒为空，若不在此处持久化，英文用户永远不会写 lw-locale，一旦存储里残留了
 *    旧的中文值（例如此前浏览过 /zh-sg/），点 CTA 进 /agents 就会显示成中文。
 */
const localeIntentFromPage =
  initialLocaleFromPath ??
  (shouldUseDefaultLocaleForBarePublicPath ? DEFAULT_LOCALE : null);
if (localeIntentFromPage && typeof window !== "undefined") {
  try {
    if (initialLocaleFromPath) {
      window.localStorage.setItem(EXPLICIT_LOCALE_STORAGE_KEY, "1");
    }
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
    window.localStorage.setItem(EXPLICIT_LOCALE_STORAGE_KEY, "1");
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
