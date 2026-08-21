/**
 * Locale 注册表 —— 全项目语言配置的唯一真源
 * ══════════════════════════════════════════════════════════════
 *
 * ## 为什么需要这个文件
 *
 * 重构前，locale 常量分散在 5 条互不 import 的镜像管线中：
 *   ① SPA / Vite 层      `src/lib/public-site-routing.ts`
 *   ② Next.js 层         `next-site/public-locale.ts`
 *   ③ i18next 资源层     `src/i18n/index.ts`
 *   ④ Node 脚本层        `scripts/sync-fumadocs-content.mjs`
 *   ⑤ SEO 校验层         `src/lib/seo-data.ts`
 *
 * 新增一个语种需要在 8 个文件中手工修改 45 处，其中多数漏改
 * **不会编译报错**，只会静默回退成英文/简体，或字体缺字。历史上
 * `scripts/subset-fonts.mjs` 就漏配了 `id-ID`（因印尼语是纯 ASCII
 * 而长期未被发现）。
 *
 * 本文件把语言集合收敛为**数据**，其余模块一律从这里派生。
 *
 * ## 新增一个语言版本的正确做法
 *
 * 1. 在 `LOCALE_DEFINITIONS` 中增加一条声明（本文件是唯一需要改的地方）。
 * 2. 运行 `pnpm i18n:extract` 生成字典骨架，补齐翻译。
 * 3. 运行 `pnpm check`；若有任何 `Record<LocaleCode, …>` 未补齐条目，
 *    TypeScript 会直接报错并指出位置。
 *
 * ## 严禁的写法
 *
 * - 不要在其他文件中硬编码 locale 字面量（如 `'ja-JP'`、`'ja-jp'`）。
 * - 不要用带 fallback 的三元链或 `startsWith('zh')` 猜测语种分支；
 *   一律使用 `Record<LocaleCode, T>` 全量查表，让漏配在编译期暴露。
 *
 * @see wiki/prd-docs/2026-08-21-intl-locale-registry-es-ja-ko.md
 */

/* ──────────────────────────────────────────────────────────────
 * 1. 类型定义
 * ────────────────────────────────────────────────────────────── */

/**
 * 规范 locale code。
 *
 * 注意 `zh-SG` 的特殊性：它**不是**独立的 i18next 字典，而是国际站
 * 简体中文的 SEO 别名（URL 走 `/zh-sg`，文案复用 `zh-CN` 字典）。
 * 见各条目的 `i18nKey` 字段。
 */
export type LocaleCode =
  | "en-US"
  | "zh-CN"
  | "zh-SG"
  | "zh-Hant"
  | "id-ID"
  | "es"
  | "ja-JP"
  | "ko-KR";

/** URL 路径前缀（全小写）。 */
export type UrlLang =
  | "en-us"
  | "zh-cn"
  | "zh-sg"
  | "zh-hant"
  | "id-id"
  | "es"
  | "ja-jp"
  | "ko-kr";

/**
 * i18next resource key —— 实际存在字典文件的语种。
 * `zh-SG` 不在其中（复用 `zh-CN`）。
 */
export type I18nDictKey = "en-US" | "zh-CN" | "zh-Hant" | "id-ID" | "es" | "ja-JP" | "ko-KR";

export type LocaleDefinition = {
  /** 规范 locale code，如 `ja-JP`。 */
  readonly code: LocaleCode;
  /** URL 前缀（全小写），如 `ja-jp`。 */
  readonly urlLang: UrlLang;
  /** i18next 字典 key。`zh-SG` 指向 `zh-CN`，其余等于自身。 */
  readonly i18nKey: I18nDictKey;
  /** `<html lang>` 属性值。 */
  readonly htmlLang: string;
  /** OpenGraph `og:locale` 值，如 `ja_JP`。 */
  readonly ogLocale: string;
  /** 语言切换器下拉中的显示名（使用该语言自身书写）。 */
  readonly displayName: string;
  /** 语言切换器触发按钮上的短标。 */
  readonly shortLabel: string;
  /**
   * 文档源目录前缀（`src/content/docs/<prefix>/`）。
   * 空字符串表示仓库根 docs 目录（国内站简体）。
   */
  readonly docsSourcePrefix: string;
  /** 文档缺失时的回落源前缀，按顺序尝试。 */
  readonly docsFallbackPrefixes: readonly string[];
  /** 是否参与国际站 SEO URL 前缀与 hreflang。 */
  readonly seoPrefixed: boolean;
  /** 是否在语言切换器中展示（可用于灰度未完成的语种）。 */
  readonly switcherVisible: boolean;
  /** CI 是否强制校验该语种字典无缺失翻译。 */
  readonly translationRequired: boolean;
  /**
   * 该语种所需但主字体缺失的字符，需依赖字体回退栈。
   * 实测 `HYRuiYiSong-45J` 与 `chuangji-hei` 均不含日文假名、
   * 韩文谚文，也不含 `ñÑ¿¡`。
   */
  readonly requiresFontFallback: boolean;
};

/* ──────────────────────────────────────────────────────────────
 * 2. 注册表本体 —— 新增语言只需在此增加一条
 * ────────────────────────────────────────────────────────────── */

export const LOCALE_DEFINITIONS = [
  {
    code: "en-US",
    urlLang: "en-us",
    i18nKey: "en-US",
    htmlLang: "en-US",
    ogLocale: "en_US",
    displayName: "English",
    shortLabel: "EN",
    docsSourcePrefix: "en",
    docsFallbackPrefixes: [],
    seoPrefixed: true,
    switcherVisible: true,
    translationRequired: true,
    requiresFontFallback: false,
  },
  {
    code: "zh-CN",
    urlLang: "zh-cn",
    i18nKey: "zh-CN",
    htmlLang: "zh-CN",
    ogLocale: "zh_CN",
    displayName: "简体中文",
    shortLabel: "中",
    docsSourcePrefix: "",
    docsFallbackPrefixes: [],
    seoPrefixed: true,
    switcherVisible: true,
    translationRequired: true,
    requiresFontFallback: false,
  },
  {
    /* 国际站简体中文的 SEO 别名：URL 走 /zh-sg，文案复用 zh-CN 字典。 */
    code: "zh-SG",
    urlLang: "zh-sg",
    i18nKey: "zh-CN",
    htmlLang: "zh-SG",
    ogLocale: "zh_SG",
    displayName: "简体中文",
    shortLabel: "简",
    docsSourcePrefix: "global",
    docsFallbackPrefixes: [],
    seoPrefixed: true,
    switcherVisible: true,
    translationRequired: true,
    requiresFontFallback: false,
  },
  {
    code: "zh-Hant",
    urlLang: "zh-hant",
    i18nKey: "zh-Hant",
    htmlLang: "zh-Hant",
    ogLocale: "zh_TW",
    displayName: "繁體中文",
    shortLabel: "繁",
    docsSourcePrefix: "global",
    docsFallbackPrefixes: [],
    seoPrefixed: true,
    switcherVisible: true,
    translationRequired: true,
    requiresFontFallback: false,
  },
  {
    code: "id-ID",
    urlLang: "id-id",
    i18nKey: "id-ID",
    htmlLang: "id-ID",
    ogLocale: "id_ID",
    displayName: "Bahasa Indonesia",
    shortLabel: "ID",
    docsSourcePrefix: "id",
    docsFallbackPrefixes: ["en", "global"],
    seoPrefixed: true,
    switcherVisible: true,
    translationRequired: true,
    requiresFontFallback: false,
  },
  {
    /**
     * 西语（面向拉美市场）。
     *
     * 采用 2 字母纯语言码 `es` 而非 `es-419` / `es-MX`：URL 前缀最短、
     * SEO 兼容性最好、无数字前缀带来的路由与 CDN 风险。
     * 已知取舍：不区分拉美与西班牙本土；未来若需西班牙本土版本，
     * 新增 `es-ES` 条目即可（前缀匹配已按长度降序，不会被 `es` 抢占）。
     */
    code: "es",
    urlLang: "es",
    i18nKey: "es",
    htmlLang: "es",
    ogLocale: "es_ES",
    displayName: "Español",
    shortLabel: "ES",
    docsSourcePrefix: "es",
    docsFallbackPrefixes: ["en", "global"],
    seoPrefixed: true,
    switcherVisible: true,
    translationRequired: true,
    /* 主字体缺 ñÑ ¿¡，必须依赖拉丁字体回退栈。 */
    requiresFontFallback: true,
  },
  {
    code: "ja-JP",
    urlLang: "ja-jp",
    i18nKey: "ja-JP",
    htmlLang: "ja-JP",
    ogLocale: "ja_JP",
    displayName: "日本語",
    shortLabel: "JA",
    docsSourcePrefix: "ja",
    docsFallbackPrefixes: ["en", "global"],
    seoPrefixed: true,
    switcherVisible: true,
    translationRequired: true,
    /* 主字体不含平假名/片假名，必须依赖系统字体回退栈。 */
    requiresFontFallback: true,
  },
  {
    code: "ko-KR",
    urlLang: "ko-kr",
    i18nKey: "ko-KR",
    htmlLang: "ko-KR",
    ogLocale: "ko_KR",
    displayName: "한국어",
    shortLabel: "KO",
    docsSourcePrefix: "ko",
    docsFallbackPrefixes: ["en", "global"],
    seoPrefixed: true,
    switcherVisible: true,
    translationRequired: true,
    /* 主字体不含谚文，必须依赖系统字体回退栈。 */
    requiresFontFallback: true,
  },
] as const satisfies readonly LocaleDefinition[];

/**
 * 历史遗留的短 URL 前缀别名，仅用于**解析**旧链接，不用于生成新链接。
 * 保留原因：早期国际站使用过 `/en` 与 `/zh`，外链与搜索引擎索引仍存在。
 */
export const LEGACY_URL_LANG_ALIASES = {
  en: "en-US",
  zh: "zh-CN",
} as const satisfies Record<string, LocaleCode>;

/* ──────────────────────────────────────────────────────────────
 * 3. 派生索引 —— 供其余模块消费，避免各处重复遍历
 * ────────────────────────────────────────────────────────────── */

/** 全部 locale code，顺序与注册表声明一致。 */
export const ALL_LOCALE_CODES: readonly LocaleCode[] = LOCALE_DEFINITIONS.map((d) => d.code);

/** 全部 URL 前缀。 */
export const ALL_URL_LANGS: readonly UrlLang[] = LOCALE_DEFINITIONS.map((d) => d.urlLang);

/** 实际存在字典文件的 i18next key（去重后）。 */
export const ALL_I18N_DICT_KEYS: readonly I18nDictKey[] = [
  ...new Set(LOCALE_DEFINITIONS.map((d) => d.i18nKey)),
];

/** CI 强制校验翻译完整度的字典 key。 */
export const TRANSLATION_REQUIRED_DICT_KEYS: readonly I18nDictKey[] = [
  ...new Set(LOCALE_DEFINITIONS.filter((d) => d.translationRequired).map((d) => d.i18nKey)),
];

const DEFINITION_BY_CODE = new Map<LocaleCode, LocaleDefinition>(
  LOCALE_DEFINITIONS.map((d) => [d.code, d]),
);

const DEFINITION_BY_URL_LANG = new Map<UrlLang, LocaleDefinition>(
  LOCALE_DEFINITIONS.map((d) => [d.urlLang, d]),
);

/** 按 locale code 取定义。code 来自 `LocaleCode` 联合类型，故必然命中。 */
export function localeDefinition(code: LocaleCode): LocaleDefinition {
  const found = DEFINITION_BY_CODE.get(code);
  if (!found) {
    /* 理论不可达：LocaleCode 由 LOCALE_DEFINITIONS 派生。 */
    throw new Error(`[locales.config] 未注册的 locale: ${code}`);
  }
  return found;
}

/** 按 URL 前缀取定义；未注册前缀返回 null（用于校验不可信输入）。 */
export function localeDefinitionByUrlLang(urlLang: string): LocaleDefinition | null {
  return DEFINITION_BY_URL_LANG.get(urlLang as UrlLang) ?? null;
}

/**
 * 把任意不可信字符串（如 localStorage 值、URL 片段）收敛为已注册的
 * locale code；无法识别时返回 null。
 *
 * 安全用途：`localStorage('lw-locale')` 可能残留已下线或被篡改的值，
 * 必须经此白名单校验后才可用于拼接路径或设置 `html lang`。
 */
export function parseLocaleCode(value: string | null | undefined): LocaleCode | null {
  if (!value) return null;
  if (DEFINITION_BY_CODE.has(value as LocaleCode)) return value as LocaleCode;
  return null;
}

/**
 * 解析 URL 前缀（含历史别名）为 locale code；无法识别时返回 null。
 */
export function resolveUrlLangToLocale(urlLang: string): LocaleCode | null {
  const direct = DEFINITION_BY_URL_LANG.get(urlLang as UrlLang);
  if (direct) return direct.code;
  const legacy = (LEGACY_URL_LANG_ALIASES as Record<string, LocaleCode | undefined>)[urlLang];
  return legacy ?? null;
}

/**
 * 生成 URL 前缀匹配用的候选列表，**按长度降序排列**。
 *
 * 顺序至关重要：正则交替分支是最左优先匹配，若 `es` 排在 `es-ES` 之前，
 * `/es-es/docs` 会被误判为 `es` + 剩余路径 `-es/docs`。按长度降序可
 * 从机制上消除该类问题，无需人工维护顺序。
 */
export function urlLangMatchCandidates(): readonly string[] {
  return [...ALL_URL_LANGS, ...Object.keys(LEGACY_URL_LANG_ALIASES)].sort(
    (a, b) => b.length - a.length,
  );
}

/**
 * URL 前缀匹配正则。由注册表派生，新增语种自动生效。
 *
 * 分组：1 = 语言前缀，2 = 分隔符，3 = 剩余路径。
 */
export function buildUrlLangPattern(): RegExp {
  const alternation = urlLangMatchCandidates()
    /* 转义正则元字符：当前前缀仅含字母、数字与连字符，此处为防御性处理。 */
    .map((lang) => lang.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(`^/(${alternation})(/|$)(.*)$`);
}
