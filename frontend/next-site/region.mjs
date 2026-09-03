/**
 * 构建脚本共用的区域常量与解析逻辑（`.mjs`，供 `next.config.mjs` 与 `scripts/*.mjs` 使用）。
 *
 * 为什么不直接 import `src/lib/region.ts`：构建脚本与 `next.config.mjs` 在
 * Node 里裸跑，没有 TS 编译步骤。所以这里是运行时脚本侧的**唯一**区域来源，
 * 与 `src/lib/region.ts` 的 `Region` 保持同一套取值与默认行为。
 * 两侧任一处新增区域时，另一处也必须同步（目前只有 cn / global 两种）。
 */

export const REGION_CN = 'cn';
export const REGION_GLOBAL = 'global';

/** 全部合法区域。用于校验，避免把 `'CN'`、`'cn-prod'` 之类静默当成合法值。 */
export const REGIONS = Object.freeze([REGION_CN, REGION_GLOBAL]);

/**
 * 从环境变量解析区域。
 *
 * 缺失或非法时按国内站处理 —— 与 `src/lib/region.ts` 的
 * `export const REGION: Region = envRegion ?? "cn"` 一致。
 * 若这里改成抛错，裸 `pnpm build`（不带 region 的本地构建）会直接失败。
 */
export function resolveRegion(env = process.env) {
  const value = (env.NEXT_PUBLIC_REGION || env.VITE_REGION || '').trim();
  return REGIONS.includes(value) ? value : REGION_CN;
}

export function isGlobalRegion(env = process.env) {
  return resolveRegion(env) === REGION_GLOBAL;
}
