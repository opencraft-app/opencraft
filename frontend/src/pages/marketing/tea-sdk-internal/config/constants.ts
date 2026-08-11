import { isGlobal } from "@/lib/region";
import i18n from "@/i18n";

/**
 * 是否国际站用户
 *
 * 原 SDK 用 tea-app 的 `site === 2` 判断，mono2/frontend 改用 region 判定（isGlobal）。
 */
export const IS_I18N = isGlobal;

/** 当前语言是否为英文
 *
 * 原 SDK 用 tea-app 的 `lang === 'en'` 判断，mono2/frontend 改用 i18next 单例的 language。
 */
export const IS_EN = i18n.language?.startsWith("en") ?? false;
