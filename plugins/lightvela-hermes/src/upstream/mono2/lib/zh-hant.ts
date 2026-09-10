// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * 简体 → 繁体（zh-Hant）运行时转换工具
 * ──────────────────────────────────────────────────────────────
 * 背景：
 *   官网大部分文案走 `useT()`（中文即 key），繁体版由构建期脚本
 *   `scripts/i18n-zh-hant.mjs` 用 OpenCC `cn→hk` 生成 `zh-Hant.json`。
 *
 *   但少数「法律页」（隐私政策 / Cookie 政策 / 开源许可）文案是长篇
 *   手写的 `{ en, zh }` 二元对象，未纳入 hash 字典机制。这些页面在
 *   繁体（zh-Hant）语言下需要把简体 `zh` 文案即时转换为繁体呈现。
 *
 * 方案：
 *   复用与构建脚本「同源」的 OpenCC `cn→hk`（香港繁体字形）+ 术语校正表，
 *   在运行时做简→繁转换。转换结果按输入缓存，避免重复计算。
 *
 *   OpenCC 通过动态 import 按需加载 —— 法律页均为懒加载路由，
 *   不会把 OpenCC 字典打进官网首屏主包。
 *
 * 术语校正表 TERM_OVERRIDES 与 `scripts/i18n-zh-hant.mjs` 保持一致，
 * 若二者有分歧应同步修改，确保「法律页」与其余文案繁体用词统一。
 */

import { useEffect, useMemo, useState } from "react";

import i18n from "../i18n";
import { PUBLIC_SITE_LOCALES } from "./public-site-routing";
import { applyZhHantOverrides } from "./zh-hant-overrides";

/** OpenCC converter 单例（惰性、异步加载） */
type Converter = (text: string) => string;
let converterPromise: Promise<Converter> | null = null;

const loadConverter = (): Promise<Converter> => {
  if (!converterPromise) {
    converterPromise = import("opencc-js")
      .then((OpenCC) => {
        const convert = OpenCC.Converter({ from: "cn", to: "hk" });
        return (text: string) => applyZhHantOverrides(convert(text));
      })
      .catch((err) => {
        // 加载失败时兜底：返回原文（简体），避免页面报错
        // eslint-disable-next-line no-console
        console.error("[zh-hant] OpenCC 加载失败，繁体文案将回退为简体：", err);
        converterPromise = null;
        return (text: string) => text;
      });
  }
  return converterPromise;
};

/** 已转换结果缓存：简体原文 → 繁体 */
const cache = new Map<string, string>();

/** 判断某个 locale 是否为繁体 */
export const isZhHant = (locale?: string): boolean =>
  (locale ?? i18n.language) === PUBLIC_SITE_LOCALES.ZH_HANT;

/** 判断某个 locale 是否为中文（简体或繁体） */
export const isZhLocale = (locale?: string): boolean => {
  const l = locale ?? i18n.language;
  return (
    l === PUBLIC_SITE_LOCALES.ZH_CN ||
    l === PUBLIC_SITE_LOCALES.ZH_SG ||
    l === PUBLIC_SITE_LOCALES.ZH_HANT
  );
};

/**
 * Hook：把「简体源文案」按当前语言转换为应展示的中文文案。
 *
 * - 语言为简体（zh-CN/zh-SG）或转换器尚未就绪：原样返回简体
 * - 语言为繁体（zh-Hant）：经 OpenCC `cn→hk` 转换后返回繁体（异步就绪后触发重渲染）
 *
 * @param zh 简体源文案（可为多行长文本）
 * @returns 当前语言下应展示的中文文案
 *
 * @example
 *   const zhText = useZhHant("我们非常重视您的隐私");
 */
export const useZhHant = (zh: string): string => {
  const hant = isZhHant();
  const [converted, setConverted] = useState<string>(() =>
    hant ? cache.get(zh) ?? zh : zh,
  );

  useEffect(() => {
    if (!hant) {
      setConverted(zh);
      return;
    }
    const cached = cache.get(zh);
    if (cached !== undefined) {
      setConverted(cached);
      return;
    }
    let alive = true;
    void loadConverter().then((convert) => {
      const result = convert(zh);
      cache.set(zh, result);
      if (alive) setConverted(result);
    });
    return () => {
      alive = false;
    };
  }, [zh, hant]);

  return converted;
};

/**
 * Hook：预加载 OpenCC 转换器并返回一个「同步」转换函数。
 * 适用于同一组件内需转换「多条/整个文案对象」的场景（如法律页 sections）。
 *
 * 加载完成前对繁体文案返回简体兜底；加载完成后组件重渲染，返回真正的繁体。
 *
 * @returns `(zh: string) => string`，简体转当前语言中文
 *
 * @example
 *   const zhT = useZhHantConverter();
 *   sections.map(s => <p>{zhT(s.body)}</p>)
 */
export const useZhHantConverter = (): ((zh: string) => string) => {
  const hant = isZhHant();
  const [convert, setConvert] = useState<Converter | null>(null);

  useEffect(() => {
    if (!hant) return;
    let alive = true;
    void loadConverter().then((fn) => {
      if (alive) setConvert(() => fn);
    });
    return () => {
      alive = false;
    };
  }, [hant]);

  return useMemo(() => {
    if (!hant) return (zh: string) => zh;
    return (zh: string) => {
      const cached = cache.get(zh);
      if (cached !== undefined) return cached;
      if (!convert) return zh; // 转换器就绪前先回显简体
      const result = convert(zh);
      cache.set(zh, result);
      return result;
    };
  }, [hant, convert]);
};

/**
 * 深度转换：把一个「文案对象/数组」中的所有字符串按当前语言转为繁体。
 * 适用于法律页这类深层嵌套的大文案对象（sections / tables / bullets 等）。
 *
 * - 非繁体语言：原样返回入参（保持引用不变，避免无谓重渲染）
 * - 繁体语言：转换器就绪前回显简体，就绪后返回全量繁体版本
 *
 * 仅转换 string 叶子；数字、布尔、null 等原样保留；React 节点不应传入此函数。
 *
 * @param source 简体源文案对象（或数组 / 字符串）
 * @returns 与入参结构相同、字符串已按当前语言转换的新对象
 *
 * @example
 *   const copy = useZhHantDeep(isZh ? zh : en);
 */
export const useZhHantDeep = <T>(source: T): T => {
  const convert = useZhHantConverter();
  const hant = isZhHant();

  return useMemo(() => {
    if (!hant) return source;

    const walk = (value: unknown): unknown => {
      if (typeof value === "string") return convert(value);
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          out[k] = walk(v);
        }
        return out;
      }
      return value;
    };

    return walk(source) as T;
  }, [source, hant, convert]);
};
