// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/*
 * 积分包（credit pack）领域模型与纯计算逻辑。
 *
 * 后端真源：credit 服务（credit/internal/httpapi/server.go:35-53）
 *   - GET  /v1/credit/products   商品列表
 *   - POST /v1/credit/inquiry    询价
 *   - GET  /v1/credit/packages   用户积分包
 *
 * 本期为「前端 UI + 询价」范围，不接入下单与支付。
 */

/** 站点币种：国内站 CNY，国际站 USD。 */
export type CreditCurrency = "CNY" | "USD";

/**
 * 商品列表返回的原始商品（credit/internal/store/model.go:29-37）。
 *
 * ⚠️ 注意：接口不返回积分数量与价格。`credit/AGENTS.md:22` 明确禁止在
 * `credit_product` 表新增 `token_total` / `price_cent` / `time_span` 等字段，
 * 积分额度真源是 `llm_gateway_plan_id` 对应的 LLMGateway plan。
 */
export interface CreditProduct {
  product_id: string;
  product_name: string;
  llm_gateway_plan_id: string;
  state: "ONLINE" | "OFFLINE";
}

/** 询价结果（trade/internal/logic/creditorder/service.go:64-75 透传）。 */
export interface CreditQuote {
  product_id: string;
  /** 折后应付金额（元 / 美元，字符串避免浮点误差） */
  real_total_cost: string;
  /** 原价 */
  total_cost: string;
  currency: CreditCurrency;
}

/**
 * 用户积分包查询项（credit/internal/service/service.go:265-270）。
 *
 * ⚠️ 缺口：不返回 package_id、product_id、created_time。
 * 见 credit/AGENTS.md:79 —— 只返回以下 4 个字段。
 */
export interface CreditPackageItem {
  credit_type: "paid" | "free";
  credit_total: number;
  credit_available: number;
  /** RFC3339 时间串 */
  expired_time: string;
}

/** 创建订单响应。注意字段命名不统一：dealName/bigOrderId 为 camelCase，auth_code 为 snake_case。 */
export interface CreditOrderResult {
  /** jifei 订单号，获取支付链接的必填参数 */
  dealName: string;
  bigOrderId: string;
  /**
   * 一次性鉴权 ticket（CodeBuddy 同款 AuthCode，对齐 pass 链路）。
   *
   * 国内站走「中转页 + wxSign」模式：中转页在微信浏览器内无主站登录态，
   * 靠 auth_code 反查 user_id 调 order-url（见 wx-pay.ts 安全模型）。
   *
   * 后端已实现下发（!3910），但发放失败时静默返回空串（服务日志打
   * "issue auth_code failed"）。order-url 已强制校验：空票据会被
   * AUTH_CODE_INVALID 拒绝，因此 useCreditCheckout 对空票据直接判失败，
   * 不再生成中转页 URL（避免必然显示「二维码已失效」误导用户）。
   */
  auth_code?: string;
}

/** 支付链接请求。 */
export interface CreditOrderUrlInput {
  /** 下单接口返回的 dealName，此处字段名为 snake_case */
  deal_name: string;
  /** PC 控制台固定传 "pc" */
  platform?: string;
  /** 支付完成后的前端回跳地址 */
  return_url?: string;
  /** 取消支付后的前端回跳地址 */
  cancel_url?: string;
}

/**
 * 支付链接响应。
 *
 * ⚠️ 与套餐（pass）链路的差异：积分包**没有 auth_code**，不走「中转页 + 一次性 ticket」
 * 的二维码安全模型（见 src/lib/wx-pay.ts）。积分包直接跳转 pay_url 完成支付。
 */
export interface CreditOrderUrlResult {
  deal_name: string;
  pay_url: string;
  /** 1 = 需跳转 pay_url 支付；0 = 无需支付，直接刷新积分包列表 */
  need_charge: number;
  /* 以下为支付组件可能使用的辅助字段，后端未返回时前端需兼容 */
  token_id?: string;
  order_id?: string;
  midas_app_id?: string;
  uin?: string;
  app_id?: string;
}

/** 卡片展示用的积分包面额定义。 */
export interface CreditPackDenomination {
  /** 与后端 credit_product.product_id 对应 */
  product_id: string;
  /** 积分数量 */
  credit_total: number;
}

/**
 * 积分包面额常量表。
 *
 * ⚠️ 临时方案：积分数量本应由后端提供。当前 `GET /v1/credit/products` 只返回
 * product_id / product_name / llm_gateway_plan_id / state，没有积分额度字段，
 * 而 credit/AGENTS.md:22 禁止把额度写进 credit_product 表。
 *
 * 产品方案要求「接口层根据 LLM Gateway plan 派生 credit_total」，属后端改造，
 * 不在本 change 范围内。在后端补齐派生字段前，前端用本表兜底。
 *
 * TODO(credit-pack): 后端 products 接口补 credit_total 后删除本表，改为直接消费接口字段。
 *
 * product_id 与 credit_total 取自后端 seed 真源（已逐条核对）：
 *   scripts/seed_credit_beijing_sandbox_products.sql
 *
 * ⚠️ 该 seed 仅覆盖 beijing-sandbox。上海生产等环境需独立准备商品数据，
 * 上线前必须确认目标环境的 product_id 与本表一致，否则询价会全部失败。
 */
export const CREDIT_PACK_DENOMINATIONS: readonly CreditPackDenomination[] = [
  { product_id: "credit_1000", credit_total: 1000 },
  { product_id: "credit_2000", credit_total: 2000 },
  { product_id: "credit_4000", credit_total: 4000 },
  { product_id: "credit_8000", credit_total: 8000 },
  { product_id: "credit_12000", credit_total: 12000 },
] as const;

/** 积分来源类型：套餐积分 or 付费积分包。 */
export type CreditSourceType = "plan" | "paid_pack";

/** 账号页「额度明细」的统一展示模型（合并 pass 与 credit 两套数据源）。 */
export interface CreditSourceView {
  source_type: CreditSourceType;
  /**
   * 稳定标识。
   *
   * ⚠️ 临时方案：credit 查询不返回 package_id（credit/AGENTS.md:79），
   * 因此付费积分包用 `${credit_type}-${credit_total}-${expired_time}` 组合。
   * 已知限制：同额度且到期时间完全相同的两个包会冲突（同秒下单两笔同额度包）。
   *
   * TODO(credit-pack): 后端补 package_id 后改用真实 ID。
   */
  source_id: string;
  display_name: string;
  credit_total: number;
  credit_available: number;
  /** 套餐为下一次刷新时间，积分包为到期时间；缺失时为 undefined */
  next_expire_at?: string;
}

/** 账号页汇总数据。 */
export interface CreditSummary {
  /** 所有有效来源的可用积分之和 */
  available: number;
  /** 所有有效来源的总额度之和 */
  total: number;
  /** 已使用 = total - available，最小为 0 */
  used: number;
  /** 有效来源数量 */
  sourceCount: number;
}

/**
 * 为付费积分包生成稳定 key。
 *
 * 见 CreditSourceView.source_id 的说明——这是缺 package_id 时的临时替代。
 */
export const creditPackageSourceId = (item: CreditPackageItem): string =>
  `${item.credit_type}-${item.credit_total}-${item.expired_time}`;

/**
 * 汇总多个积分来源。
 *
 * used 取 max(0, total - available)，避免后端数据异常时出现负数。
 */
export const summarizeCreditSources = (sources: readonly CreditSourceView[]): CreditSummary => {
  let available = 0;
  let total = 0;
  for (const source of sources) {
    available += source.credit_available;
    total += source.credit_total;
  }
  return {
    available,
    total,
    used: Math.max(0, total - available),
    sourceCount: sources.length,
  };
};

/**
 * 按实际扣减优先级排序积分来源。
 *
 * 产品口径：下一次刷新或到期时间更早的先扣；时间相同时购买/创建时间更早的先扣。
 *
 * ⚠️ 本期只能按 next_expire_at 排序：credit 查询不返回购买时间，
 * 无法实现「同时间按购买时间排序」的第二优先级。时间相同或缺失时，
 * 保持输入顺序（Array.prototype.sort 在现代引擎中是稳定排序），
 * 避免页面顺序抖动。
 *
 * 服务端才是扣减顺序的权威，前端排序仅用于解释性展示。
 *
 * TODO(credit-pack): 后端补 created_at / package_id 后补齐二、三级排序。
 */
export const sortCreditSources = (sources: readonly CreditSourceView[]): CreditSourceView[] =>
  [...sources].sort((a, b) => {
    const aTime = a.next_expire_at;
    const bTime = b.next_expire_at;
    /* 缺时间的排在最后：无到期约束的额度不应抢占优先扣减位 */
    if (!aTime && !bTime) return 0;
    if (!aTime) return 1;
    if (!bTime) return -1;
    const aMs = Date.parse(aTime);
    const bMs = Date.parse(bTime);
    /* 无法解析的时间视同缺失，避免 NaN 比较导致排序结果不确定 */
    const aValid = Number.isFinite(aMs);
    const bValid = Number.isFinite(bMs);
    if (!aValid && !bValid) return 0;
    if (!aValid) return 1;
    if (!bValid) return -1;
    return aMs - bMs;
  });
