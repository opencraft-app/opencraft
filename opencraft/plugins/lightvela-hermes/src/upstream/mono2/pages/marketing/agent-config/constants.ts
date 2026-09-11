// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { isGlobal } from "../../../lib/region";

/**
 * 是否国际站用户
 *
 * 原 SDK 用 tea-app 的 `site === 2` 判断，mono2/frontend 改用 region 判定（isGlobal）。
 */
export const IS_I18N = isGlobal;
