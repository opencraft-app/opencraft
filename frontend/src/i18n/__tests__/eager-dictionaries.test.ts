/**
 * 首屏同步字典的区域门禁测试
 * ──────────────────────────────────────────────────────────────
 * 国内站只发布中文：`initialLocale` 恒为默认语言，构建产物也不含任何
 * 语种前缀路由，因此 en/es/id/zh-Hant 不该进国内站首屏 chunk。
 *
 * 这条测试守的是**体积**：字典单份约 1 MB，且会被打进多个 chunk 分组，
 * 一旦有人把门禁去掉，国内站首页 JS 会悄悄涨回去，而功能测试全绿。
 * 同时确认非同步装载的语种都留有按需通道，不会在被请求时抛错。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_LOCALE } from "@/lib/region";
import { ALL_I18N_DICT_KEYS, localeDefinition, type I18nDictKey } from "../locales.config";

/**
 * 装载 i18n 时，当前 URL / 区域默认语言的字典一定会就位（同步或按需），
 * 与门禁无关。断言「不该同步装载」的语种要排除它，否则这条测试在
 * VITE_REGION=global 下会误报。
 */
const INITIAL_DICT_KEY = localeDefinition(DEFAULT_LOCALE).i18nKey;
const OPTIONAL_DICT_KEYS = (["en-US", "es", "id-ID", "ms-MY", "zh-Hant"] as const)
  .filter((key) => key !== INITIAL_DICT_KEY);

/**
 * 以指定构建标记重新装载 i18n 单例，返回其同步可用的语种。
 *
 * 标记由 next.config.mjs 按区域内联；"1" = 国内站（只要中文），其余值 = 全量。
 */
async function eagerLocalesFor(lazyLocales: string): Promise<I18nDictKey[]> {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_I18N_LAZY_LOCALES", lazyLocales);
  const i18n = (await import("../index")).default;
  return ALL_I18N_DICT_KEYS.filter((key) => i18n.hasResourceBundle(key, "translation"));
}

describe("首屏同步字典按构建区域裁剪", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("国内站只同步装载中文字典", async () => {
    const eager = await eagerLocalesFor("1");
    expect(eager).toContain("zh-CN");
    expect(OPTIONAL_DICT_KEYS.length).toBeGreaterThan(0);
    for (const key of OPTIONAL_DICT_KEYS) {
      expect(eager).not.toContain(key);
    }
  });

  it("国际站保持既有的多语种同步装载", async () => {
    const eager = await eagerLocalesFor("0");
    for (const key of ["en-US", "zh-CN", "zh-Hant", "id-ID", "es"] as const) {
      expect(eager).toContain(key);
    }
  });

  /**
   * 嵌入式工作台（opencraft）vendoring 了同一份源码，其 Vite 把
   * NEXT_PUBLIC_REGION 固定替换成 "cn"，却必须保留国际站控制台要用的英文字典。
   * 因此门禁只认本标记；取不到标记时一律全量同步装载。
   */
  it("取不到构建标记时保持全量同步装载", async () => {
    const eager = await eagerLocalesFor("");
    for (const key of ["en-US", "zh-CN", "zh-Hant", "id-ID", "es"] as const) {
      expect(eager).toContain(key);
    }
  });

  it("国内站未同步装载的语种仍可按需取到字典", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_I18N_LAZY_LOCALES", "1");
    const module = await import("../index");
    for (const locale of ["en-US", "zh-Hant", "id-ID", "es"] as const) {
      await expect(module.ensureLocaleDictionary(locale)).resolves.toBe(locale);
    }
  });
});
