/**
 * 按 region 解析 Next 的 `pageExtensions`。
 *
 * 单独成文件的原因：`next.config.mjs` 在 vitest 下无法直接 import
 * （它顶层调用 `fileURLToPath(new URL('.', import.meta.url))`，
 * 而 vitest 环境的 `import.meta.url` 不是 file:// scheme，会抛
 * `TypeError: The URL must be of scheme file`）。
 * 把逻辑抽出来，测试就能验证真实行为而不是去正则匹配配置文件源码。
 *
 * ── `.intl.tsx` 是什么 ──────────────────────────────────
 * 「仅国际站存在」的页面后缀，当前用于 `src/app/(site)/[lang]/**`。
 *
 * 国内站只有 zh-CN 一种语言，裸路径即正式 URL，所以 `[lang]` 段一个参数都不需要。
 * 但**不能**靠 `generateStaticParams()` 返回空数组来表达这件事：
 * Next 在 `output: 'export'` 下把空数组等同于「没有这个函数」，报
 *
 *   Error: Page "/[lang]/about" is missing "generateStaticParams()"
 *          so it cannot be used with "output: export" config.
 *
 * 并中断构建。而 dev 模式不做静态导出，所以这个错误能躲过本地
 * dev / tsc / vitest 全部检查，直到 MR 流水线跑真实 `next build` 才暴露。
 *
 * 因此改为让国内站根本不把这些文件识别为页面：`[lang]` 路由段不存在，
 * 产物里也不含相关代码。国际站仍保留 zh-sg / zh-hant / id-id 三种真实语言版本。
 */

import { isGlobalRegion } from './region.mjs';

/** 两站共用：裸路径页面靠它，任何 region 都必须包含。 */
export const BASE_PAGE_EXTENSIONS = Object.freeze(['next.tsx', 'next.ts']);

/** 仅国际站：`[lang]` 前缀路由。 */
export const INTL_ONLY_PAGE_EXTENSIONS = Object.freeze(['intl.tsx', 'intl.ts']);

export { isGlobalRegion };

export function resolvePageExtensions(env = process.env) {
  return isGlobalRegion(env)
    ? [...BASE_PAGE_EXTENSIONS, ...INTL_ONLY_PAGE_EXTENSIONS]
    : [...BASE_PAGE_EXTENSIONS];
}
