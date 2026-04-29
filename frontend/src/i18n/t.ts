/**
 * i18n 运行时封装：让业务层用「中文即 key」的方式调用 t()。
 * ──────────────────────────────────────────────────────────────
 * 业务侧只需要：
 *   const t = useT();
 *   <Button>{t("立即创建")}</Button>
 *
 * 内部链路：
 *   "立即创建"  ──(zh-to-key 反查表)──▶  "k_a1b2c3d4"  ──▶  i18next.t()  ──▶  "Create Now"
 *
 * 反查表由 `scripts/i18n-extract.mjs` 在构建/手动执行时扫描源码生成：
 *   frontend/src/i18n/generated/
 *     ├── zh-to-key.json   —— "中文" → "k_xxxxxxxx"
 *     ├── zh-CN.json       —— "k_xxxxxxxx" → "中文"
 *     └── en-US.json       —— "k_xxxxxxxx" → "English translation"
 *
 * 兜底策略：
 *   - 脚本未跑 / 新增中文暂未收录 → 直接回显中文原文（保证页面不白屏）
 *   - 开发环境 DEV 会 console.warn 提醒尽快跑一次 extract
 */

import { useTranslation } from "react-i18next";

import zhToKey from "./generated/zh-to-key.json";

/** 反查表类型：中文 → hash key */
type ZhToKeyMap = Record<string, string>;

const zhToKeyMap = zhToKey as ZhToKeyMap;

/**
 * 本地插值：对 "{{name}}" 形式的占位符做简单字符串替换。
 * 专供「字典未命中」的兜底分支使用，避免把 `{{n}}` 这类占位符
 * 原样输出到用户界面（i18next.t 不会处理未命中 key 的插值）。
 *
 * - 仅支持 {{ 变量名 }} 语法（允许变量名两侧有空格）
 * - options 中缺失的变量保持原样，方便开发期暴露问题
 */
const interpolate = (zh: string, options?: Record<string, unknown>): string => {
  if (!options) return zh;
  return zh.replace(/\{\{\s*([\w$]+)\s*\}\}/g, (raw, name: string) => {
    if (Object.prototype.hasOwnProperty.call(options, name)) {
      const v = options[name];
      return v === undefined || v === null ? "" : String(v);
    }
    return raw;
  });
};

/** 开发期对未收录中文的告警（同一条只告警一次，避免刷屏） */
const warnedMissing = new Set<string>();
const warnMissing = (zh: string): void => {
  if (!import.meta.env.DEV) return;
  if (warnedMissing.has(zh)) return;
  warnedMissing.add(zh);
  // eslint-disable-next-line no-console
  console.warn(
    `[i18n] 未在字典中找到："${zh}"，请运行 \`pnpm i18n:extract\` 生成映射。`,
  );
};

/**
 * Hook：返回一个参数为「中文原文」的 t 函数。
 * 支持 i18next 的 interpolation（第二个参数为 options）。
 *
 * @example
 *   const t = useT();
 *   t("立即创建");
 *   t("© {{year}} LightVela 版权所有", { year: 2026 });
 */
export const useT = (): ((zh: string, options?: Record<string, unknown>) => string) => {
  const { t: rawT } = useTranslation();
  return (zh, options) => {
    const key = zhToKeyMap[zh];
    if (!key) {
      warnMissing(zh);
      /* 兜底：没有对应 hash 就直接返回中文（并做一次本地插值），避免 {{x}} 裸露 */
      return interpolate(zh, options);
    }
    /* defaultValue 设为中文原文，key 在字典缺失时也能回落中文 */
    return rawT(key, { defaultValue: zh, ...(options ?? {}) });
  };
};

/**
 * 非 React 环境下的命令式 t（如常量、utils 里使用）。
 * 内部直接拿 i18next 单例，不受 React 渲染节奏影响；
 * 但切换语言后 **不会** 自动重渲染使用方，需要调用方自行感知。
 */
import i18n from "./index";

export const t = (zh: string, options?: Record<string, unknown>): string => {
  const key = zhToKeyMap[zh];
  if (!key) {
    warnMissing(zh);
    return interpolate(zh, options);
  }
  return i18n.t(key, { defaultValue: zh, ...(options ?? {}) });
};
