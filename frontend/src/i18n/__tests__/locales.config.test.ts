/**
 * Locale 注册表测试
 * ──────────────────────────────────────────────────────────────
 * 重点覆盖两类容易在「新增语种」时出错、且线上表现为静默降级的行为：
 *   1. URL 前缀匹配顺序（长度降序，防止短前缀抢占长前缀）
 *   2. 不可信输入的白名单收敛（localStorage / URL 片段）
 */

import { describe, expect, it } from "vitest";

import rawLocales from "../locales.json";
import {
  ALL_I18N_DICT_KEYS,
  ALL_LOCALE_CODES,
  ALL_URL_LANGS,
  buildUrlLangPattern,
  LOCALE_DEFINITIONS,
  localeDefinition,
  localeDefinitionByUrlLang,
  parseLocaleCode,
  resolveUrlLangToLocale,
  TRANSLATION_REQUIRED_DICT_KEYS,
  urlLangMatchCandidates,
} from "../locales.config";

/**
 * 数据（locales.json）与类型层（locales.config.ts 手写联合类型）的
 * 双向一致性校验。
 *
 * 这是本文件最重要的一组断言：因为 `LOCALE_DEFINITIONS` 使用了类型断言
 * 把 JSON 转成字面量类型，编译期无法发现「JSON 加了语种但联合类型没加」
 * 或反之。这些测试就是那道防线。
 */
describe("locales.json 与联合类型的一致性", () => {
  /** 与 locales.config.ts 中 LocaleCode 联合类型逐字对应，需同步维护。 */
  const EXPECTED_LOCALE_CODES = [
    "en-US",
    "zh-CN",
    "zh-SG",
    "zh-Hant",
    "id-ID",
    "es",
    "ja-JP",
    "ko-KR",
  ] as const;

  /** 与 UrlLang 联合类型逐字对应。 */
  const EXPECTED_URL_LANGS = [
    "en-us",
    "zh-cn",
    "zh-sg",
    "zh-hant",
    "id-id",
    "es",
    "ja-jp",
    "ko-kr",
  ] as const;

  it("JSON 中的 code 集合与 LocaleCode 联合类型完全一致", () => {
    expect([...ALL_LOCALE_CODES].sort()).toEqual([...EXPECTED_LOCALE_CODES].sort());
  });

  it("JSON 中的 urlLang 集合与 UrlLang 联合类型完全一致", () => {
    expect([...ALL_URL_LANGS].sort()).toEqual([...EXPECTED_URL_LANGS].sort());
  });

  it("JSON 条目数与联合类型成员数一致（防止漏加/多加）", () => {
    expect(rawLocales.length).toBe(EXPECTED_LOCALE_CODES.length);
  });

  it("每条 JSON 数据都包含全部必需字段且类型正确", () => {
    for (const def of rawLocales) {
      expect(typeof def.code, `code: ${def.code}`).toBe("string");
      expect(typeof def.urlLang, `urlLang: ${def.code}`).toBe("string");
      expect(typeof def.i18nKey, `i18nKey: ${def.code}`).toBe("string");
      expect(typeof def.htmlLang, `htmlLang: ${def.code}`).toBe("string");
      expect(typeof def.ogLocale, `ogLocale: ${def.code}`).toBe("string");
      expect(typeof def.displayName, `displayName: ${def.code}`).toBe("string");
      expect(typeof def.shortLabel, `shortLabel: ${def.code}`).toBe("string");
      expect(typeof def.docsSourcePrefix, `docsSourcePrefix: ${def.code}`).toBe("string");
      expect(Array.isArray(def.docsFallbackPrefixes), `docsFallbackPrefixes: ${def.code}`).toBe(true);
      expect(typeof def.seoPrefixed, `seoPrefixed: ${def.code}`).toBe("boolean");
      expect(typeof def.switcherVisible, `switcherVisible: ${def.code}`).toBe("boolean");
      expect(typeof def.translationRequired, `translationRequired: ${def.code}`).toBe("boolean");
      expect(typeof def.requiresFontFallback, `requiresFontFallback: ${def.code}`).toBe("boolean");
    }
  });

  it("i18nKey 必须指向真实存在的字典语种", () => {
    /* zh-SG 复用 zh-CN，因此 i18nKey 可以不等于 code，但必须是已登记的字典 key。 */
    for (const def of LOCALE_DEFINITIONS) {
      expect(ALL_I18N_DICT_KEYS, `${def.code} 的 i18nKey 未登记`).toContain(def.i18nKey);
    }
  });
});

describe("注册表自身一致性", () => {
  it("locale code 与 URL 前缀均无重复", () => {
    expect(new Set(ALL_LOCALE_CODES).size).toBe(ALL_LOCALE_CODES.length);
    expect(new Set(ALL_URL_LANGS).size).toBe(ALL_URL_LANGS.length);
  });

  it("URL 前缀一律为小写，不含大写字母", () => {
    for (const lang of ALL_URL_LANGS) {
      expect(lang).toBe(lang.toLowerCase());
    }
  });

  it("每条定义都能通过 code 反查回自身", () => {
    for (const def of LOCALE_DEFINITIONS) {
      expect(localeDefinition(def.code)).toBe(def);
      expect(localeDefinitionByUrlLang(def.urlLang)?.code).toBe(def.code);
    }
  });

  it("zh-SG 是 zh-CN 的 SEO 别名：URL 独立但复用 zh-CN 字典", () => {
    const zhSG = localeDefinition("zh-SG");
    expect(zhSG.urlLang).toBe("zh-sg");
    expect(zhSG.i18nKey).toBe("zh-CN");
  });

  it("字典 key 已去重，zh-SG 不产生独立字典", () => {
    expect(ALL_I18N_DICT_KEYS).not.toContain("zh-SG");
    expect(new Set(ALL_I18N_DICT_KEYS).size).toBe(ALL_I18N_DICT_KEYS.length);
  });

  it("必填翻译字典是全部字典的子集", () => {
    for (const key of TRANSLATION_REQUIRED_DICT_KEYS) {
      expect(ALL_I18N_DICT_KEYS).toContain(key);
    }
  });

  it("既有 4 语种与新增 3 语种均已注册", () => {
    for (const code of ["en-US", "zh-CN", "zh-SG", "zh-Hant", "id-ID", "es", "ja-JP", "ko-KR"] as const) {
      expect(ALL_LOCALE_CODES).toContain(code);
    }
  });
});

describe("URL 前缀匹配顺序", () => {
  it("候选列表严格按长度降序，长前缀优先", () => {
    const candidates = urlLangMatchCandidates();
    for (let i = 1; i < candidates.length; i += 1) {
      expect(candidates[i - 1]!.length).toBeGreaterThanOrEqual(candidates[i]!.length);
    }
  });

  it("短前缀 es 不会抢占同族长前缀（回归防护）", () => {
    /* 未来新增 es-ES / es-MX 时，此断言保证匹配顺序不退化。 */
    const candidates = urlLangMatchCandidates();
    const esIndex = candidates.indexOf("es");
    const longerSameFamily = candidates.filter((c) => c.startsWith("es-"));
    for (const longer of longerSameFamily) {
      expect(candidates.indexOf(longer)).toBeLessThan(esIndex);
    }
  });

  it("正确解析各语种前缀路径", () => {
    const re = buildUrlLangPattern();
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["/es", "es", ""],
      ["/es/docs", "es", "docs"],
      ["/ja-jp/docs/overview", "ja-jp", "docs/overview"],
      ["/ko-kr/", "ko-kr", ""],
      ["/zh-hant/about", "zh-hant", "about"],
      ["/id-id/subscribe", "id-id", "subscribe"],
    ];
    for (const [path, expectedLang, expectedRest] of cases) {
      const matched = path.match(re);
      expect(matched, `应匹配到语言前缀: ${path}`).not.toBeNull();
      expect(matched![1]).toBe(expectedLang);
      expect(matched![3]).toBe(expectedRest);
    }
  });

  it("兼容历史短前缀 /en 与 /zh", () => {
    const re = buildUrlLangPattern();
    expect("/en/docs".match(re)?.[1]).toBe("en");
    expect("/zh/about".match(re)?.[1]).toBe("zh");
  });

  it("不把恰好以语言码开头的普通路径误判为语言前缀", () => {
    const re = buildUrlLangPattern();
    /* /estonia 以 "es" 开头，但不是 /es/... ，必须不匹配。 */
    for (const path of ["/estonia", "/japan", "/korea", "/english", "/agents", "/auth", "/"]) {
      expect(path.match(re), `不应被识别为语言前缀: ${path}`).toBeNull();
    }
  });
});

describe("不可信输入的白名单收敛", () => {
  it("已注册 locale 原样返回", () => {
    expect(parseLocaleCode("es")).toBe("es");
    expect(parseLocaleCode("ja-JP")).toBe("ja-JP");
    expect(parseLocaleCode("zh-SG")).toBe("zh-SG");
  });

  it("未注册值、空值与被篡改值一律回退 null", () => {
    for (const bad of ["", null, undefined, "xx", "ja", "ES", "../../etc/passwd", "<script>"]) {
      expect(parseLocaleCode(bad)).toBeNull();
    }
  });

  it("URL 前缀解析覆盖正式前缀与历史别名，未知值返回 null", () => {
    expect(resolveUrlLangToLocale("es")).toBe("es");
    expect(resolveUrlLangToLocale("ja-jp")).toBe("ja-JP");
    expect(resolveUrlLangToLocale("en")).toBe("en-US");
    expect(resolveUrlLangToLocale("zh")).toBe("zh-CN");
    expect(resolveUrlLangToLocale("unknown")).toBeNull();
  });
});

describe("新增语种的已知约束", () => {
  it("日语、韩语、西语标记为需要字体回退", () => {
    /* 实测 HYRuiYiSong-45J 与 chuangji-hei 均不含假名/谚文/ñÑ¿¡。 */
    for (const code of ["ja-JP", "ko-KR", "es"] as const) {
      expect(localeDefinition(code).requiresFontFallback).toBe(true);
    }
  });

  it("新增语种配置了文档回落，避免正文缺失导致 404", () => {
    for (const code of ["ja-JP", "ko-KR", "es"] as const) {
      expect(localeDefinition(code).docsFallbackPrefixes.length).toBeGreaterThan(0);
    }
  });

  it("翻译未完成的语种不得在切换器中展示", () => {
    /* 灰度约束：字典未翻译完成前 switcherVisible 必须为 false，
       否则用户选中后会看到大面积中文回退。
       待某语种翻译补齐并把 translationRequired 打开后，才允许展示。 */
    for (const def of LOCALE_DEFINITIONS) {
      if (def.translationRequired) continue;
      expect(def.switcherVisible, `${def.code} 翻译未完成却已在切换器展示`).toBe(false);
    }
  });

  it("所有参与 SEO 的语种都有 htmlLang 与 ogLocale", () => {
    for (const def of LOCALE_DEFINITIONS) {
      if (!def.seoPrefixed) continue;
      expect(def.htmlLang).toBeTruthy();
      expect(def.ogLocale).toMatch(/^[a-z]{2}_[A-Z]{2}$/);
    }
  });
});
