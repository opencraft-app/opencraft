/**
 * 站点区域常量
 * ──────────────────────────────────────────────────────────────
 * 通过 Vite 编译期环境变量 `VITE_REGION` 区分国内 / 国际站点：
 *   - `cn`     ：国内站（lightvela.cn，默认）
 *   - `global` ：国际站（lightvela.com）
 *
 * 使用场景：
 *   1. 条件渲染（编译期会被 Vite 的 defineConfig 常量替换 + terser 做死代码消除）：
 *      ```tsx
 *      {isCN && <WechatLogin />}
 *      {isGlobal && <GoogleLogin />}
 *      ```
 *   2. 接口 / 支付 / 客服渠道等差异化配置的入口。
 *
 * 切换方式：
 *   pnpm dev:cn          / pnpm build:cn          → REGION=cn
 *   pnpm dev:global      / pnpm build:global      → REGION=global
 */

export type Region = "cn" | "global";

/**
 * 当前站点区域。
 * 默认 `cn`，保持国内站零破坏；国际站构建时会被环境变量覆盖为 `global`。
 */
export const REGION: Region =
  (import.meta.env.VITE_REGION as Region | undefined) ?? "cn";

/** 是否国内站 */
export const isCN: boolean = REGION === "cn";

/** 是否国际站 */
export const isGlobal: boolean = REGION === "global";

/**
 * 默认语言（编译期常量）。
 * 国内站默认中文，国际站默认英文；运行时仍可通过 i18n 动态切换。
 */
export const DEFAULT_LOCALE: "zh-CN" | "en-US" = isGlobal ? "en-US" : "zh-CN";
