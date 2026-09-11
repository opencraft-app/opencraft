// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
export type PlanTier = "free" | "plus" | "max";
export type SubscriptionCode = "free" | "lite" | "pro";
export type SubscriptionStatus = "active" | "pending_payment" | "cancelled" | "expired";

export interface PlanOption {
  tier: PlanTier;
  name: string;
  description: string;
  priceLabel: string;
  priceNote: string;
  features: string[];
  available: boolean;
  featured?: boolean;
  ctaLabel: string;
}

export type InviteValidationState = "idle" | "valid" | "invalid" | "expired" | "used";

export type RuntimeHealth = "healthy" | "degraded" | "offline";

export type WorkspaceMessageRole = "user" | "assistant" | "system";

export interface User {
  id: string;
  name: string;
  pendingName?: string;
  nameAuditStatus?: "pending" | "passed" | "failed";
  email?: string;
  phone?: string;
  avatarUrl?: string;
  pendingAvatarUrl?: string;
  avatarAuditStatus?: "pending" | "passed" | "failed";
  inviteRequired: boolean;
  /** 是否已完成实名认证，后端 /auth/session /auth/profile 下发 */
  realnameVerified?: boolean;
  /** 实名等级：none / idcard_2fa / phone_3fa */
  realnameLevel?: string;
  /** 实名流程模式，由认证服务下发。 */
  realnameAssuranceMode?: "legacy" | "faceless" | "observe" | "face_required";
  /** 实名信息同步状态：pending / failed / succeeded */
  realnameSyncStatus?: "pending" | "failed" | "succeeded";
  /** 邮箱是否已验证（Magic Link 绑定），后端 /auth/session /auth/profile 下发 */
  emailVerified?: boolean;
  createdAt: string;
}

/** 实名等级常量（后端 realnameLevel 取值，避免魔法字符串） */
export const REALNAME_LEVEL = {
  NONE: "none",
  IDCARD_2FA: "idcard_2fa",
  PHONE_3FA: "phone_3fa",
} as const;

export interface Bot {
  id: string;
  instanceId?: string;
  profileId?: string;
  isDefault?: boolean;
  description?: string;
  createdFrom?: "blank" | "clone";
  sourceBotId?: string;
  weixinOwner?: {
    botId: string;
    profileId: string;
    botName?: string;
    status: string;
  };
  sandboxId?: string;
  name: string;
  type: "sales" | "support" | "ops" | "research";
  template: string;
  mission?: string;
  scenario?: string;
  createdAt: string;
  status: "draft" | "provisioning" | "active" | "paused" | "failed" | "deleting";
}

export interface BotTerminalSession {
  sandboxId?: string;
  poolId: string;
  sessionId: string;
  region: string;
  instanceId: string;
  ownerUin: string;
  loginUin: string;
  appId: number;
  wsUrl: string;
  cols: number;
  rows: number;
  timeoutSeconds?: number;
  username?: string;
  workingDirectory?: string;
}

export interface BotChannelConfigResult {
  status: string;
  channel: string;
  gatewayRestarted: boolean;
  output?: string;
}

export interface WeixinLoginSession {
  session_id: string;
  status: string;
  qr_url?: string;
  qr_ascii?: string;
  last_output?: string;
  started_at?: string;
  expires_at?: string;
  finished_at?: string;
  error_message?: string;
  restart_status?: string;
  restart_error?: string;
}

export interface WeixinLoginSessionEvent {
  type: string;
  status?: string;
  qr_url?: string;
  qr_ascii?: string;
  output?: string;
  error?: string;
  data?: WeixinLoginSession;
}

export interface BotRuntime {
  botId: string;
  health: RuntimeHealth;
  latencyMs: number;
  throughputPerMinute: number;
  lastHeartbeatAt: string;
  activeSessions: number;
  tokenUsage: number;
}

export interface BotVersion {
  id: string;
  botId: string;
  label: string;
  createdAt: string;
  actor: string;
  notes: string;
  rollbackAvailable: boolean;
}

export interface Deployment {
  id: string;
  botId: string;
  environment: "staging" | "production";
  region: string;
  status: "running" | "queued" | "failed";
  updatedAt: string;
}

export interface BillingSummary {
  tier: PlanTier;
  monthCost: number;
  budgetLimit: number;
  estimatedMonthEnd: number;
  tokenSpend: number;
  runMinutes: number;
}

export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  target: string;
  timestamp: string;
  detail: string;
}

export interface AlertItem {
  id: string;
  title: string;
  severity: "critical" | "warning" | "info";
  message: string;
  createdAt: string;
  resolved: boolean;
}

export interface KnowledgeSource {
  id: string;
  name: string;
  type: "docs" | "notion" | "sql" | "drive";
  status: "ready" | "syncing" | "error";
  updatedAt: string;
}

export interface ToolBinding {
  id: string;
  name: string;
  provider: "mcp" | "http" | "native";
  enabled: boolean;
  lastRunAt: string;
}

export interface InviteCodeValidation {
  code: string;
  state: InviteValidationState;
  message: string;
}

export interface PlanSelection {
  tier: PlanTier;
  confirmedAt: string;
}

export interface CurrentSubscription {
  tier: PlanTier;
  code: SubscriptionCode;
  status: SubscriptionStatus;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AuthSessionSnapshot {
  user: User;
  currentSubscription: CurrentSubscription | null;
  impersonated: boolean;
  authenticatedAt?: string;
  sessionToken?: string;
}

export interface WorkspaceMessage {
  id: string;
  role: WorkspaceMessageRole;
  text: string;
  createdAt: string;
}

export type DataMode = "live" | "empty" | "error";

/* ─── Bundle & Pass (套餐与权益) ─── */

export type BundleState = "ONLINE" | "OFFLINE";
export type BundleSalesState = "AVAILABLE" | "SOLD_OUT";
export type BundleTimeUnit = "d" | "m" | "y";

/**
 * 自动续费标记（国际站支持）— 对应后端 CreatePassOrderRequest.auto_renew_flag
 *
 * 取值（与 ctl/pkg/transport/pass.go 对齐）：
 *   - auto_renew：自动续费
 *   - notify_and_manual_renew：通知 + 手动续费
 *   - no_notify_and_manual_renew：不通知 + 手动续费
 */
export type AutoRenewFlag = "auto_renew" | "notify_and_manual_renew" | "no_notify_and_manual_renew";

export interface BundleDescriptionEntry {
  Key: string;
  Value: string;
}

/**
 * 套餐询价对象（GET /v1/bundles 返回 bundles[].price）
 *
 * - 单位：**分**（cents，CNY）；4900 = 49.00 元，与续费询价 PassRenewPrice 已对齐
 * - 展示前请用 `centsToYuan()` 换算成元，再交给 `formatYuan()` 渲染
 * - 后端 trade 询价失败 / 用户未登录时整体置 null（前端按"暂无报价"展示）
 *
 * 与联调文档 codesign/ctl-frontend-billing-api.md §1.1 对齐
 */
export interface BundlePrice {
  /** 标价（分） */
  price: number;
  /** 成本价（分） */
  total_cost: number;
  /** 实付价（分，含折扣） */
  real_total_cost: number;
  /** 币种，固定 "CNY" */
  currency: string;
  /** 折扣率（1.0 = 不打折，0.9 = 9 折） */
  discount: number;
  /**
   * 税额（分）。后端「国际站询价税费拆分」下发（2692ca1ca）：实付金额对应的税额。
   * real_total_cost 为含税实付，税前实付 = real_total_cost - tax_price。
   * 国内站与未下发场景为 0/缺失，前端按税额 0 处理。
   */
  tax_price?: number;
}

/** ctl/pkg/transport/pass_modify.go: authoritative upgrade targets and live prices. */
export interface PassModifyOption {
  target_bundle_id: string;
  bundle: { bundle_id: string; bundle_name: string; cpu: number; memory: number; system_disk_size: number; credit: number };
  modify_price: BundlePrice;
}
export interface PassModifyBundles {
  source_bundle_id: string;
  modify_bundle_set: PassModifyOption[];
}
export interface PassModifyOrder {
  deal_name: string;
  big_order_id: string;
  auth_code?: string;
}
export interface PassModifyCheckout {
  checkout: { deal_name: string; big_order_id: string; target_bundle_id: string; local_status: string } | null;
}
/** ctl/pkg/transport/order.go; success alone does not guarantee local delivery. */
export interface PassOrderStatus {
  deal_name: string;
  order_type: string;
  status: 'pending' | 'paid' | 'success' | 'cancelled' | 'failed';
  local_status?: string;
  source: string;
}

export interface Bundle {
  bundle_id: string;
  bundle_name: string;
  description: BundleDescriptionEntry[];
  bundle_state: BundleState;
  agent_quota: number;
  /** 每个 Agent 可拥有的 Bot 数量上限，包含主 Bot */
  bot_quota_per_agent?: number;
  /** 积分数量（套餐包含多少 AI 积分） */
  credit: number;
  /**
   * 套餐价格（嵌套对象）；后端在 trade 不可用 / 用户未登录时返回 null。
   * 与联调文档 §1.1 对齐 — 旧版本曾是 number 类型，已迁移为 BundlePrice。
   */
  price?: BundlePrice | null;
  time_span: number;
  time_unit: BundleTimeUnit;
  bundle_sales_available_count: number;
  bundle_sales_total_count: number;
  bundle_sales_state: BundleSalesState;
  created_time?: string;
  updated_time?: string;
  /**
   * 套餐分类（用于订阅页按 tab 分组展示），后端字段 `bundle.bundle_type`。
   * 后端枚举（ctl migration 000023 / 2026-06 联调确认）：
   *   - "general"  标准版（启航 / 巡游）
   *   - "ai"       AI 增强版（启航 AI / 巡游 AI）
   *   - "free"     免费试用套餐（走 CreateTrialPass 链路，订阅页**不展示**，由 planList 上游过滤）
   * 联调期可能缺失：缺省 / 空串 / 未识别值会被归入"其他"分组（避免页面挂掉）。
   * 后端新增/调整付费枚举后请同步更新 `subscribe-page.tsx` 中 `BUNDLE_TYPE_TABS` 常量。
   */
  bundle_type?: string;
}

export interface Pass {
  /** Explicit lifecycle from ctl; upgrade completion must not infer it from expiry. */
  status?: string;
  pass_id: string;
  user_id: string;
  bundle_id: string;
  bundle_name: string;
  /** @deprecated 后端 v1.7.30 起不再返回，仅保留供兼容旧 mock 数据 */
  uin?: number;
  /** @deprecated 后端 v1.7.30 起不再返回，仅保留供兼容旧 mock 数据 */
  app_id?: number;
  created_time: string;
  expired_time: string;
  isolated_time?: string | null;
  /** @deprecated 后端 list 接口已过滤掉 deleted 状态的 pass；保留作前端防御性兼容（billing-flow.ts 推断状态用） */
  deleted_time?: string | null;
  updated_time?: string;
  /** 总 Agent 席位配额（联调文档 §5.1） */
  agent_quota_total?: number;
  /** 剩余 Agent 席位（已扣减运行中 Instance 占用） */
  agent_quota_available?: number;
  /** 当前套餐下每个 Agent 可拥有的 Bot 数量上限，包含主 Bot */
  bot_quota_per_agent?: number;
  credit_total: number;
  credit_available: number;
}

/**
 * 新购下单结果（POST /v1/passes/order）— 联调文档 §2.1（v1.7.31 拆分）
 *
 * v1.7.31 起后端拆分为两阶段：
 *   1. POST /v1/passes/order        → 纯下单，仅返 deal_names
 *   2. POST /v1/passes/order-url    → 根据 deal_names 拉支付 URL（CreatePassOrderUrlResult）
 *
 * 续费同理（§3.2 / §3.3 走相同两阶段）。
 *
 * 拆分动机：前端需要在下单后、拉支付 URL 前注入额外参数（如微信 wx_open_id、platform），
 * 用于微信委托划扣中转页的 OAuth 授权后再向后端拉取移动端支付参数。
 */
export interface CreatePassOrderResult {
  /**
   * jifei 订单号列表；当前单订单场景固定 1 元素，为后续多订单可扩展预留。
   * **前端需缓存此值**，下一步调 order-url 时回传。
   */
  deal_names: string[];
  /**
   * 一次性鉴权 ticket（CodeBuddy 同款 AuthCode 模型）— 联调文档 §2.1 / §3.2
   *
   * **PC 端**调下单接口时由后端下发，**前端不存 localStorage**，只把它编进二维码 query。
 * 用户在微信扫码后中转页跳到 `/auth/wechat-pay`，中转页**没有主站登录态**
   * （cookie 跨域 + 公众号 webview 隔离），所以中转页调 `getPassOrderUrl` 时
   * 用 `auth_code` 作为鉴权凭证传入 body，后端校验 auth_code → 解析出 uid → 拉 jifei pay_url。
   *
   * 安全模型：
   *   - auth_code 一次性、TTL 短（建议 ≤10 分钟），失效后整张二维码失效
   *   - 即使二维码截图泄漏，攻击者只能尝试**替受害者付款**（pay_url 仍绑定 uid）
   *   - 与 CodeBuddy 二维码 URL 中 `uid=<AuthCode>` 字段语义对齐
   *
   * 后端未实现该字段时为空字符串/undefined；前端会自动回退到老的两阶段下单链路。
   */
  auth_code?: string;
}

/**
 * 拉支付 URL 入参（POST /v1/passes/order-url 与 POST /v1/passes/{id}/renew/order-url 共用）
 * — 联调文档 §2.2 / §3.3（v1.7.31 新增 + CodeBuddy AuthCode 模型）
 *
 * 调用模式：
 *   PC 端：    `{ deal_names, platform: "pc" }`（依赖主站 Bearer token 鉴权）
 *   中转页（推荐）：`{ deal_names, platform: "mobile", wx_code, auth_code }`
 *               （**无主站 token**，靠 auth_code 鉴权 + wx_code 让后端换 wx_open_id 调 jifei）
 *   中转页（兼容旧）：`{ deal_names, platform: "mobile", wx_open_id }`（前端先换好 openid）
 */
export interface CreatePassOrderUrlInput {
  /** 来自 createPassOrder / createRenewOrder 返回的 deal_names */
  deal_names: string[];
  /** 支付平台：默认 "pc"；微信内中转页传 "mobile" */
  platform?: "pc" | "mobile";
  /**
   * 微信公众号场景：snsapi_base 授权拿到的 openid。
   * 与 wx_code 二选一传一即可（CodeBuddy 模式优先用 wx_code 让后端换）。
   */
  wx_open_id?: string;
  /**
   * 微信网页授权回跳的临时 code（OAuth code，10 分钟内有效）。
   * **CodeBuddy 同款链路**：中转页拿到 code 后直接透传给后端，由后端用 appsecret
   * 调 `sns/oauth2/access_token` 换 wx_open_id；前端不持有 secret，更安全。
   */
  wx_code?: string;
  /**
   * CodeBuddy 同款一次性鉴权 ticket — 来自 createPassOrder 返回的 auth_code。
   *
   * **使用场景**：中转页**没有主站登录态**（cookie/Bearer 不可用），用此字段作为鉴权凭证。
   * 后端实现要求：当请求 body 携带 auth_code 时，可绕过 Authorization header 校验，
   * 用 auth_code 反查 user_id；TTL 同二维码 TTL（≤10 分钟）。
   */
  auth_code?: string;
  /**
   * 国际站信用卡/签约支付：用户取消支付后的前端回跳地址（完整 HTTPS URL）。
   * ctl 不解析，仅透传给 trade → jifei cancelUrl。
   * 约束：稳定页面地址，不含 query/hash（避免 OAuth code/openid/一次性 ticket 带入回跳地址）。
   */
  cancel_url?: string;
  /**
   * 国际站信用卡/签约支付：用户完成支付后的前端回跳地址（完整 HTTPS URL）。
   * ctl 不解析，仅透传给 trade → jifei returnUrl。
   * 约束同 cancel_url：稳定页面地址，不含 query/hash。
   */
  return_url?: string;
}

/**
 * 拉支付 URL 结果（POST /v1/passes/order-url 与 POST /v1/passes/{id}/renew/order-url 共用）
 * — 联调文档 §2.2 / §3.3（v1.7.31 新增）
 *
 * 前端调起支付的优先级：
 *   1. need_charge === 0 → 零元订单已支付成功，无需跳支付
 *   2. token_id + midas_app_id 都存在 → 调 @tencent/tcb-jssdk wxSign / pay 拉起米大师签约/支付
 *   3. 否则 → 整页跳转 pay_url 作为兜底（jifei 灰度变更 / 错误回包路径）
 *
 * 协议外字段 D3 兜底契约：token_id / order_id / midas_app_id 来自 jifei
 * qcloud.margin.getMidasEarmarking 顶层字段，PDF 协议未列但实测稳定返。
 * jifei 未返时为 null，前端必须容忍并回退到 pay_url。
 */
export interface CreatePassOrderUrlResult {
  /** jifei 订单号（仅审计用；与入参 deal_names[0] 一致） */
  deal_name: string;
  /** jifei 支付页 URL（兜底跳转方案；当前优先用 token_id + midas_app_id 调 SDK） */
  pay_url: string;
  /** 米大师支付 token，前端调 tcb-jssdk 用；jifei 未返时为 null */
  token_id?: string | null;
  /** 米大师订单号（与 deal_name 不同源；客服排障 / 用户查单可展示）；jifei 未返时为 null */
  order_id?: string | null;
  /** 米大师商户 appid，前端调 tcb-jssdk 透传给米大师；jifei 未返时为 null */
  midas_app_id?: string | null;
  /** 1 = 需跳 Midas 支付页；0 = 零元订单已支付成功（前端可视为完成） */
  need_charge: number;
  /** 用户腾讯云 uin（来自 trade_order，便于前端展示 / 后续对账） */
  uin?: string;
  /** 用户腾讯云 appId（**不是米大师商户号**，米大师商户号见 midas_app_id） */
  app_id?: string;
}

/**
 * 新购下单+支付一体化结果（POST /v1/passes/order-and-pay）— 联调文档 §2.2
 *
 * ⚠️ 仅联调测试用，现网控制台禁止暴露此入口给真实用户。
 */
export interface CreatePassOrderAndPayResult {
  /** jifei 订单号 */
  deal_name: string;
  /** jifei 大订单号（用于 jifei 控制台反查支付状态） */
  big_order_id: string;
}

/** 点石活动专用下单并支付结果。 */
export interface CreateDianshiPassOrderAndPayResult {
  deal_name: string;
  big_order_id: string;
}

/**
 * 续费询价结果（POST /v1/passes/{pass_id}/renew/price）— 联调文档 §3.1
 *
 * - 单位：**分**（cents，float64），4900 = 49.00 元；与新购询价 BundlePrice 单位一致
 * - 询价无副作用 — 不下单、不付款、不写本地 pass
 *
 * v1.7.28 BUG-04 C 路径精简（2026-05-20）：删除 bundle_name / time_span / time_unit /
 * goods_num / product_code / sub_product_code / pid 7 个字段；价格字段类型从 string
 * → float64 与新购 BundlePrice 对齐。
 */
export interface PassRenewPrice {
  bundle_id: string;
  /** 标价（分） */
  price: number;
  /** 成本价（分） */
  total_cost: number;
  /** 实付价（分） */
  real_total_cost: number;
  /** 币种，固定 "CNY" */
  currency: string;
  /** jifei policyDetail.total 拍平值，100 = 无折扣 */
  discount: number;
}

/**
 * 销毁 pass 结果（POST /v1/passes/{pass_id}/delete）— 联调文档 §4.1
 *
 * deleted = true 仅表示同步调用成功；实际销毁是异步链路，
 * 前端必须轮询 GET /v1/passes 检测 pass 从列表消失才算销毁完成。
 */
export interface DeletePassResult {
  /** 同步调用成功标记，固定 true */
  deleted: boolean;
}
