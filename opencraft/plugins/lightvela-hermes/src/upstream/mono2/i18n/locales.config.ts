// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * Locale 注册表 —— 全项目语言配置的唯一真源
 * ══════════════════════════════════════════════════════════════
 *
 * ## 为什么需要这个文件
 *
 * 重构前，locale 常量分散在 6 条互不 import 的镜像管线中：
 *   ① SPA / Vite 层      `src/lib/public-site-routing.ts`
 *   ② Next.js 层         `next-site/public-locale.ts`
 *   ③ i18next 资源层     `src/i18n/index.ts`
 *   ④ Node 脚本层        `scripts/sync-fumadocs-content.mjs` 等
 *   ⑤ SEO 校验层         `src/lib/seo-data.ts`
 *   ⑥ 定时任务展示层     `agent-automations-panel.tsx`（2026-08 新增）
 *
 * 新增一个语种需要在 8 个文件中手工修改 45 处，其中多数漏改
 * **不会编译报错**，只会静默回退成英文/简体，或字体缺字。历史上
 * `scripts/subset-fonts.mjs` 就漏配了 `id-ID`（因印尼语是纯 ASCII
 * 而长期未被发现）。
 *
 * ## 数据与类型的分工
 *
 * - `locales.json`：**数据真源**。TS 与 Node 脚本（`.mjs`）都直接读它。
 *   之所以用 JSON 而不是把数据写在本文件里：`.mjs` 无法 import `.ts`，
 *   而 CI 使用的 Node 22.12 剥离 TS 类型仍需实验性 flag。JSON 是两条
 *   管线唯一无摩擦的共享格式。
 * - 本文件：**类型层与派生索引**。`LocaleCode` 等联合类型在此手写，
 *   以获得字面量类型，从而让 `Record<LocaleCode, T>` 具备穷举保护。
 *
 * 两者的一致性由 `__tests__/locales.config.test.ts` 双向校验：
 * JSON 多一个语种或联合类型少一个语种，测试都会失败。
 *
 * ## 新增一个语言版本的正确做法
 *
 * 1. 在 `locales.json` 增加一条数据。
 * 2. 在本文件的 `LocaleCode` / `UrlLang` / `I18nDictKey` 联合类型中补上对应字面量。
 * 3. 运行 `pnpm i18n:extract` 生成字典骨架，补齐翻译。
 * 4. 运行 `pnpm check`；任何 `Record<LocaleCode, …>` 未补齐条目都会编译失败。
 *
 * ## 严禁的写法
 *
 * - 不要在其他文件中硬编码 locale 字面量（如 `'ja-JP'`、`'ja-jp'`）。
 * - 不要用带 fallback 的三元链、`startsWith('zh')` 猜测，或
 *   `locale !== 'en-US' && locale !== 'id-ID'` 这类排除式判断；
 *   一律使用 `Record<LocaleCode, T>` 全量查表，让漏配在编译期暴露。
 *
 * @see wiki/prd-docs/2026-08-21-intl-locale-registry-es-ja-ko.md
 */

import rawLocaleDefinitions from "./locales.json";

/* ──────────────────────────────────────────────────────────────
 * 1. 类型定义
 *
 * 这些联合类型刻意手写而非从 JSON 派生：JSON 模块的字符串会被 TS 推断为
 * `string`，无法提供字面量类型，也就无法支撑 `Record` 的穷举检查。
 * 手写联合类型 = 显式声明「本项目支持哪些语种」，由测试保证与 JSON 同步。
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
  /**
   * 是否在语言切换器中展示。
   *
   * 用于灰度：字典尚未翻译完成的语种应保持 `false`，避免用户选中后
   * 看到大面积中文回退。
   */
  readonly switcherVisible: boolean;
  /** CI 是否强制校验该语种字典无缺失翻译。 */
  readonly translationRequired: boolean;
  /**
   * 该语种所需但主字体缺失的字符，需依赖字体回退栈。
   * 实测 `HYRuiYiSong-45J` 与 `chuangji-hei` 均不含日文假名、
   * 韩文谚文，也不含 `ñÑ¿¡`。
   */
  readonly requiresFontFallback: boolean;
  /** 是否把该语种字典字符写入 HYRuiYiSong 字体子集。 */
  readonly fontSubsetEligible: boolean;
};

/* ──────────────────────────────────────────────────────────────
 * 2. 数据装载
 * ────────────────────────────────────────────────────────────── */

/**
 * 全部 locale 定义，数据来自 `locales.json`。
 *
 * 这里的类型断言是**必要**的：JSON 模块会把字符串推断为 `string`，
 * 而下游需要字面量类型。JSON 与联合类型的实际一致性由单元测试校验，
 * 不依赖此处的断言。
 */
export const LOCALE_DEFINITIONS: readonly LocaleDefinition[] =
  rawLocaleDefinitions as readonly LocaleDefinition[];


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

/**
 * 已满足公开发布门禁的 locale。
 *
 * `switcherVisible` 表达产品发布意图，`translationRequired` 表达翻译完整度
 * 已进入 CI 强校验；两者缺一时均不得生成公开路由或进入切换器。参数可注入
 * 是为了让测试在不提前开放生产 locale 的前提下验证未来发布行为。
 */
export function publishedLocaleDefinitions(
  definitions: readonly LocaleDefinition[] = LOCALE_DEFINITIONS,
): readonly LocaleDefinition[] {
  return definitions.filter((definition) => (
    definition.switcherVisible && definition.translationRequired
  ));
}

/** 单个 locale 是否同时通过产品可见性与翻译完整度发布门禁。 */
export function isPublishedLocale(
  locale: LocaleCode,
  definitions: readonly LocaleDefinition[] = LOCALE_DEFINITIONS,
): boolean {
  const definition = definitions.find((candidate) => candidate.code === locale);
  return Boolean(definition?.switcherVisible && definition.translationRequired);
}

/** 已发布 locale 的规范 URL 前缀。 */
export function publishedUrlLangs(
  definitions: readonly LocaleDefinition[] = LOCALE_DEFINITIONS,
): readonly UrlLang[] {
  return publishedLocaleDefinitions(definitions).map((definition) => definition.urlLang);
}

/** 已发布 locale 实际使用的 i18next 字典 key（去重后）。 */
export function publishedI18nDictKeys(
  definitions: readonly LocaleDefinition[] = LOCALE_DEFINITIONS,
): readonly I18nDictKey[] {
  return [
    ...new Set(publishedLocaleDefinitions(definitions).map((definition) => definition.i18nKey)),
  ];
}

export type RuntimeLocaleOptions = {
  /** 国内站永不接受本地预览语种。 */
  readonly region: "cn" | "global";
  /** 生产构建即使误注入预览变量也必须忽略。 */
  readonly isProduction: boolean;
  /** 逗号分隔的规范 locale code，仅接受注册表中的精确值。 */
  readonly previewLocales?: string | null;
  /** 测试或未来发布模拟时可注入定义，默认使用正式注册表。 */
  readonly definitions?: readonly LocaleDefinition[];
};

/**
 * 运行时可访问 locale。
 *
 * 默认值严格等于正式发布集合；只有国际站非生产环境显式传入
 * `previewLocales` 时，才把已注册的目标 locale 合并进来。返回顺序始终
 * 沿用注册表顺序，避免语言菜单在预览模式下跳位。
 */
export function runtimeLocaleDefinitions(
  options: RuntimeLocaleOptions,
): readonly LocaleDefinition[] {
  const definitions = options.definitions ?? LOCALE_DEFINITIONS;
  const publishedCodes = new Set(
    publishedLocaleDefinitions(definitions).map((definition) => definition.code),
  );

  if (options.region !== "global" || options.isProduction || !options.previewLocales) {
    return definitions.filter((definition) => publishedCodes.has(definition.code));
  }

  const previewCodes = new Set(
    options.previewLocales
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return definitions.filter((definition) => (
    publishedCodes.has(definition.code) || previewCodes.has(definition.code)
  ));
}

/** 把 URL / localStorage 等不可信输入收敛为当前运行时可访问的 locale。 */
export function parseRuntimeLocaleCode(
  value: string | null | undefined,
  options: RuntimeLocaleOptions,
): LocaleCode | null {
  const locale = parseLocaleCode(value);
  if (!locale) return null;
  return runtimeLocaleDefinitions(options).some((definition) => definition.code === locale)
    ? locale
    : null;
}

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
 * 把浏览器 URL、本地存储等公开输入收敛为已经发布的 locale。
 * 注册但尚未发布的字典只能由构建/测试内部显式预载，不能成为用户界面语言。
 */
export function parsePublishedLocaleCode(
  value: string | null | undefined,
  definitions: readonly LocaleDefinition[] = LOCALE_DEFINITIONS,
): LocaleCode | null {
  const locale = parseLocaleCode(value);
  return locale && isPublishedLocale(locale, definitions) ? locale : null;
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
