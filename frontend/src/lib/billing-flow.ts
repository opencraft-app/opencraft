/**
 * 计费流程工具集 — 收敛站点分流 / Pass 状态判断 / 时间单位转换等通用逻辑
 *
 * 设计要点：
 * - 付费链路由运行时配置控制；国际站继续走免费试用兜底
 * - Pass 状态从 isolated_time / deleted_time / expired_time 三字段组合推断
 *   （联调文档 §5 显式说明 ctl 不返回 status 字段）
 * - 单位换算：后端询价接口（新购 BundlePrice / 续费 PassRenewPrice）价格字段统一以「分」为单位，
 *   展示前需调 centsToYuan() 转为元
 */

import { isGlobal } from "@/lib/region";
import type { BundleTimeUnit, Pass } from "@/domain/types";

/* ----------------------------- 站点分流 ----------------------------- */

/**
 * 是否启用付费下单链路。
 * 这里不读取环境变量或地域常量，只消费调用方已门控后的运行时开关。
 */
export const isPaidBillingEnabled = (enabled: boolean): boolean => enabled === true;

/**
 * 国际站是否走免费试用兜底
 *
 * 与 isPaidBillingEnabled 互补；放在一起方便调用方语义自解释
 */
export const isFreeTrialOnlyMode = (): boolean => isGlobal;

/* ----------------------------- 时间单位 ----------------------------- */

/**
 * BundleTimeUnit 转中文 — 用于 UI 展示
 */
export const formatTimeUnit = (unit: BundleTimeUnit): string => {
  switch (unit) {
    case "d": return "天";
    case "m": return "个月";
    case "y": return "年";
    default: return unit;
  }
};

/**
 * 标准化时长描述 — `30 + "d"` → "30 天"，`1 + "m"` → "1 个月"
 */
export const formatDuration = (span: number, unit: BundleTimeUnit): string =>
  `${span} ${formatTimeUnit(unit)}`;

/**
 * 价格单位转换：分 → 元
 *
 * 后端询价接口（新购 BundlePrice / 续费 PassRenewPrice）价格字段统一以「分」为单位，展示前需调用本函数转为元
 */
export const centsToYuan = (cents: string | number): number => {
  const value = typeof cents === "string" ? Number(cents) : cents;
  if (!Number.isFinite(value)) return 0;
  return value / 100;
};

/**
 * 把元价格格式化为「¥49.00」字符串
 */
export const formatYuan = (yuan: number, currency = "CNY"): string => {
  if (currency !== "CNY") return `${yuan} ${currency}`;
  return `¥${yuan.toFixed(2)}`;
};

/* ---------------------------- Pass 状态推断 ----------------------------- */

/**
 * Pass 业务状态（前端推断；后端 ctl 不直接返回此字段）
 *
 * - active   ：未过期、未隔离、未销毁 — 唯一可用状态
 * - expired  ：已过期但未隔离        — 应引导用户续费
 * - isolated ：进入隔离期            — 可续费（PASS_ISOLATED）或销毁（前置条件）
 * - deleted  ：销毁完成              — 通常前端会从列表过滤掉
 *
 * 与联调文档 §5 / §3.1 / §4.1 描述对齐
 */
export type PassStatus = "active" | "expired" | "isolated" | "deleted";

/**
 * 从 Pass 字段推断业务状态
 *
 * @param pass Pass 实体
 * @param now  参考时间（默认 Date.now()）；测试时可注入固定时间
 */
export const getPassStatus = (
  pass: Pass,
  now: number = Date.now(),
): PassStatus => {
  if (pass.deleted_time) return "deleted";
  if (pass.isolated_time) return "isolated";
  const expiredAt = new Date(pass.expired_time).getTime();
  if (Number.isFinite(expiredAt) && expiredAt <= now) return "expired";
  return "active";
};

/**
 * 从 pass 列表中找到「当前活跃」的 pass（仅 active 状态）
 *
 * - 用户最多只持有 1 个 active pass（互斥占用规则）
 * - 找不到返回 null
 */
export const findActivePass = (
  passes: readonly Pass[],
  now: number = Date.now(),
): Pass | null => {
  for (const pass of passes) {
    if (getPassStatus(pass, now) === "active") return pass;
  }
  return null;
};

/**
 * 是否允许「销毁」操作 — 联调文档 §4.1：仅 isolated 状态可销毁
 */
export const canDeletePass = (pass: Pass, now?: number): boolean =>
  getPassStatus(pass, now) === "isolated";

/**
 * 是否允许「续费」操作 — 联调文档 §3：active / expired / isolated 都可续费，
 * 只有 deleted 不允许（互斥占用规则会拦截）
 */
export const canRenewPass = (pass: Pass, now?: number): boolean =>
  getPassStatus(pass, now) !== "deleted";

/**
 * 是否允许「新购」—— 当前列表里不存在任何 active 或可续费的 pass
 *
 * 用户曾持有过 isolated/deleted 的 pass 也无法新购（互斥占用规则，trade 侧拦截，
 * 此函数只做前置 UI 优化，避免无效请求）
 */
export const canCreateNewPass = (
  passes: readonly Pass[],
  now: number = Date.now(),
): boolean => {
  for (const pass of passes) {
    const status = getPassStatus(pass, now);
    if (status !== "deleted") return false;
  }
  return true;
};
