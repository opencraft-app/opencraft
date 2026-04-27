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
 *   - en-US.json：hash → 英文
 *   - zh-to-key.json：中文 → hash（仅运行时反查用）
 *
 * 设计要点：
 *   - 默认语言由 `src/lib/region.ts` 根据 `VITE_REGION` 编译期决定
 *   - 浏览器侧可通过 `localStorage.setItem('lw-locale', 'en-US')` 覆盖
 *
 * 不做的事（保持简单）：
 *   - 不接 `i18next-browser-languagedetector`
 *   - 不做懒加载 / 分包（文案整体体积很小，直接静态 import 更快）
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { DEFAULT_LOCALE } from "@/lib/region";
import enUS from "./generated/en-US.json";
import zhCN from "./generated/zh-CN.json";

/** 本地存储 key，用户手动切换语言时持久化 */
const LOCALE_STORAGE_KEY = "lw-locale";

/** 读取用户手动覆盖的语言（若存在） */
const readOverride = (): string | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
};

/** 初始语言：用户覆盖 > 区域默认 */
const initialLocale = readOverride() ?? DEFAULT_LOCALE;

void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN },
    "en-US": { translation: enUS },
  },
  lng: initialLocale,
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
 * @example setLocale('en-US')
 */
export const setLocale = (locale: "zh-CN" | "en-US"): void => {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* 隐私模式等场景 localStorage 不可用，忽略 */
  }
  void i18n.changeLanguage(locale);
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
