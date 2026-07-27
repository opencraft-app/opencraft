/**
 * 计费错误码映射 — 与联调文档 codesign/ctl-frontend-billing-api.md §7 严格对齐
 *
 * 设计要点：
 * - 直接返回中文文案；联调文档明确给的就是中文，国际站不接计费链路
 * - 仅对 ctl 计费侧的 envelope.code 做识别；通用 RepositoryError（如 network_error）
 *   走 fallback 文案
 * - 提供分类工具，便于上层做"是否可重试 / 是否要灰化按钮 / 是否需要跳续费链路"判断
 */

import { RepositoryError } from "@/repositories/http-repositories";

const SYSTEM_BUSY_RETRY_MESSAGE = "系统繁忙，请刷新页面后重试";
const LEGACY_SYSTEM_BUSY_MESSAGE = "系统繁忙，请稍后再试。";

/**
 * envelope.code → 用户文案映射表
 *
 * 与联调文档 §7 完整对齐（4 通用 + 3 Bundle + 16 Pass + 2 5xx）
 */
const BILLING_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  // §7.1 通用
  INVALID_PARAMETER: "请求参数有误，请检查后重试。",
  UNAUTHORIZED: "请先登录后再操作。",
  FORBIDDEN: "当前操作被拒绝，请刷新页面或联系客服。",
  NOT_FOUND: "请求的资源不存在。",
  METHOD_NOT_ALLOWED: "请求方式不正确。",

  // §7.2 Bundle
  BUNDLE_NOT_FOUND: "套餐不存在或已下架。",
  BUNDLE_STATE_INVALID: "套餐状态异常，请刷新后重试。",
  BUNDLE_AIGATEWAY_UNAVAILABLE: "计费服务暂时不可用，请稍后再试。",

  // §7.3 Pass
  PASS_NOT_FOUND: "套餐已删除或不属于当前账号。",
  PASS_INVALID_PARAM: "请求参数有误，请检查后重试。",
  PASS_INVALID_TIME_UNIT: "请重新选择时长单位。",
  PASS_BUNDLE_OFFLINE: "套餐已下架，请选择其他套餐。",
  PASS_BUNDLE_SOLD_OUT: "套餐已售罄，请选择其他套餐。",
  PASS_NOT_ISOLATED: "请等待套餐隔离完成后再销毁。",
  PASS_EXPIRED: "套餐已到期，请前往续费。",
  PASS_QUOTA_EXCEEDED: "Agent 数量已达上限，请升级套餐或释放后重试。",
  PASS_ISOLATING: "套餐正在隔离，请稍候再试。",
  PASS_ISOLATED: "套餐已隔离，请前往续费。",
  PASS_RENEWING: "续费正在处理中，请稍候。",
  PASS_NOT_RENEWABLE: "当前套餐状态不支持续费。",
  PASS_DELETING: "销毁操作正在执行中，请稍候。",
  PASS_TERMINATING: "套餐正在销毁中，请稍候。",
  PASS_SHADOW_BINDING_NOT_FOUND: "用户身份信息异常，请联系客服。",
  PASS_SHADOW_BINDING_REQUIRED: "请先完成手机号验证后再开通套餐。",
  PASS_ALREADY_EXISTS: "您已有有效套餐，无需重复购买。",

  // Instance
  INSTANCE_SHADOW_BINDING_REQUIRED: "请先完成手机号验证后再创建 Hermes。",

  // §7.4 5xx
  INTERNAL_SERVER_ERROR: SYSTEM_BUSY_RETRY_MESSAGE,
  UPSTREAM_ERROR: "计费服务暂时不可用，请稍后再试。",
} as const;

/**
 * 通用兜底文案（按 HTTP 状态码粗分类）
 */
const FALLBACK_BY_STATUS: Readonly<Record<string, string>> = {
  "4xx": "请求未能完成，请检查后重试。",
  "5xx": SYSTEM_BUSY_RETRY_MESSAGE,
} as const;

/** 默认兜底文案 */
const DEFAULT_FALLBACK = "操作失败，请稍后再试。";

/** 已知的计费错误码（联合类型，便于调用方做枚举分支） */
export type BillingErrorCode = keyof typeof BILLING_ERROR_MESSAGES;

/**
 * 从 unknown 错误中提取 envelope.code
 *
 * - RepositoryError.code 直接返回
 * - 鸭子类型识别 { code: string } 形态（fake-repositories 抛的 Error & { code }）
 * - 其余返回 null
 */
export const getBillingErrorCode = (error: unknown): string | null => {
  if (error instanceof RepositoryError) {
    return error.code ?? null;
  }
  if (
    error
    && typeof error === "object"
    && "code" in error
    && typeof (error as { code: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return null;
};

/**
 * 解析任意 error 为用户友好文案
 *
 * @param error    任意错误对象
 * @param fallback 自定义兜底文案；不传则按状态码 / 默认兜底
 * @returns 中文文案（永远非空）
 *
 * @example
 * try { await repo.createPassOrder(...); }
 * catch (e) { showToast(resolveBillingErrorMessage(e, "下单失败")); }
 */
export const resolveBillingErrorMessage = (
  error: unknown,
  fallback?: string,
): string => {
  const code = getBillingErrorCode(error);
  if (code && code in BILLING_ERROR_MESSAGES) {
    return BILLING_ERROR_MESSAGES[code]!;
  }

  // 走原始 message（如 RepositoryError 已经把 ctl 的 message 拼好了）
  if (error instanceof RepositoryError) {
    if (error.message === LEGACY_SYSTEM_BUSY_MESSAGE) return SYSTEM_BUSY_RETRY_MESSAGE;
    if (error.message) return error.message;
    if (error.status >= 500) return FALLBACK_BY_STATUS["5xx"]!;
    if (error.status >= 400) return FALLBACK_BY_STATUS["4xx"]!;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback ?? DEFAULT_FALLBACK;
};

/**
 * 该错误码是否表示「pass 处于过渡态」—— 灰化按钮即可，无需提示用户重试
 *
 * 适用场景：销毁按钮上看到 PASS_DELETING/TERMINATING 时直接禁用
 */
export const isPassTransientError = (code: string | null | undefined): boolean => {
  if (!code) return false;
  return (
    code === "PASS_ISOLATING"
    || code === "PASS_RENEWING"
    || code === "PASS_DELETING"
    || code === "PASS_TERMINATING"
  );
};

/**
 * 该错误码是否表示「需要走续费链路而不是新购」
 *
 * 适用场景：用户在订阅页点击「立即购买」拿到此错误时，引导跳转续费入口
 */
export const isPassRequiresRenewError = (code: string | null | undefined): boolean => {
  if (!code) return false;
  return code === "PASS_EXPIRED" || code === "PASS_ISOLATED";
};

/**
 * 该错误码是否表示「互斥占用」——用户已有有效 pass，不允许再下单
 *
 * 适用场景：新购下单返回此错误时，引导用户去管理页查看现有套餐
 */
export const isPassConflictError = (code: string | null | undefined): boolean => {
  return code === "PASS_ALREADY_EXISTS";
};

/**
 * 该错误码是否表示「不可恢复」—— 当前操作彻底失败，重试无意义
 *
 * 适用场景：销毁过程中拿到 PASS_NOT_FOUND，说明已被销毁，停止轮询
 */
export const isPassTerminalError = (code: string | null | undefined): boolean => {
  if (!code) return false;
  return (
    code === "PASS_NOT_FOUND"
    || code === "BUNDLE_NOT_FOUND"
    || code === "PASS_BUNDLE_OFFLINE"
    || code === "PASS_BUNDLE_SOLD_OUT"
  );
};
