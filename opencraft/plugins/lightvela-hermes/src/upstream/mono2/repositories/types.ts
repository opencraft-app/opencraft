// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import type {
  AlertItem,
  AuthSessionSnapshot,
  AuditEvent,
  AutoRenewFlag,
  BillingSummary,
  Bundle,
  CreateDianshiPassOrderAndPayResult,
  CreatePassOrderAndPayResult,
  CreatePassOrderResult,
  CreatePassOrderUrlInput,
  CreatePassOrderUrlResult,
  CurrentSubscription,
  DeletePassResult,
  Bot,
  BotChannelConfigResult,
  BotTerminalSession,
  BotRuntime,
  BotVersion,
  BundleTimeUnit,
  DataMode,
  Deployment,
  InviteCodeValidation,
  KnowledgeSource,
  Pass,
  PassModifyBundles,
  PassModifyOrder,
  PassModifyCheckout,
  PassOrderStatus,
  PassRenewPrice,
  PlanOption,
  PlanTier,
  ToolBinding,
  User,
  WeixinLoginSession,
  WorkspaceMessage,
} from "../domain/types";
import type {
  CreditOrderResult,
  CreditOrderUrlInput,
  CreditOrderUrlResult,
  CreditPackageItem,
  CreditProduct,
  CreditQuote,
} from "../domain/credit-pack";
import type { OAuthProvider, WeChatOAuthMode } from "../lib/oauth";

export interface OAuthStartOptions {
  switchAccount?: boolean;
  wechatMode?: WeChatOAuthMode;
  /** Validated relying-party location that owns the browser login result. */
  returnTo?: string;
}

export interface FederationAuthorizationInput {
  clientId: string;
  redirectUri: string;
  state: string;
}

export interface OIDCAuthorizationInput {
  clientId: string;
  redirectUri: string;
  state: string;
  responseType: "code";
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  nonce: string;
}

export interface FederationSessionSummary {
  user: {
    id: string;
    name: string;
    email?: string;
    phone?: string;
    avatarUrl?: string;
  };
}

export interface FederationAuthorizationContext extends FederationAuthorizationInput {
  clientDisplayName: string;
  currentSession: FederationSessionSummary | null;
}

export interface FederationTicketResult {
  redirectUrl: string;
  expiresAt: string;
}

export interface OIDCAuthorizationContext extends OIDCAuthorizationInput {
  clientDisplayName: string;
  currentSession: FederationSessionSummary | null;
}

export interface OIDCAuthorizationResult {
  redirectUrl: string;
  expiresAt: string;
}

export interface RealnameVerifyResult {
  ok: boolean;
  verified: boolean;
  nameMasked: string;
  idCardMasked: string;
  requestId: string;
  phoneVerificationRequired: boolean;
  phoneVerificationSkipped?: boolean;
  realnameLevel?: string;
  shadowBindingStatus?: string;
}

export type RealnameFaceIdAttemptState =
  | "pending"
  | "face_succeeded"
  | "phone_pending"
  | "shadow_pending"
  | "succeeded"
  | "failed"
  | "expired";

export interface RealnameFaceIdAttempt {
  attemptId: string;
  state: RealnameFaceIdAttemptState;
  verificationUrl?: string;
  expiresAt?: string;
}

export interface RealnamePhoneVerifyResult {
  ok: boolean;
  realnameLevel: string;
  realnameSyncStatus?: "pending" | "failed" | "succeeded";
  shadowBindingStatus: string;
}

export interface RealnameSyncRetryResult {
  ok: boolean;
  user: User;
  realnameSyncStatus: "pending" | "failed" | "succeeded";
  shadowBindingStatus: string;
}

export interface SendSmsCodeResult {
  cooldownSeconds: number;
}

export interface TatDeviceBindResult {
  status: string;
  ticket: string;
  callbackUrl: string;
  redirectUrl: string;
  expiresAt: string;
  registrationCode?: string | null;
  registration?: {
    region: string;
    registerCodeId: string;
    registerCodeValue: string;
    requestId: string;
  };
}

export interface TencentCloudRedirectResult {
  redirectUrl: string;
  expiresAt: string;
}

export type PaymentMethodLanguageCode = "en" | "zh" | "hk";

export interface PaymentMethod {
  contractCode: string;
  maskedNumber: string;
  payerName: string;
  type: string;
  isDefault: boolean;
}

export interface PaymentMethodList {
  total: number;
  items: PaymentMethod[];
}

export interface PaymentMethodSignOrder {
  contractCode: string;
  redirectUrl: string;
}

export interface ReferralOverview {
  code: string;
  url: string;
  campaignId: string;
  campaignName: string;
  startsAt: string;
  endsAt: string;
}

export interface ReferralStats {
  successfulReferrals: number;
  grantedCredits: number;
  pendingRewards: number;
  grantedRewards: number;
}

export interface AuthRepository {
  signInWithCode(input: { phone: string; code?: string; inviteCode?: string }): Promise<AuthSessionSnapshot>;
  prepareInviteCode(code: string): Promise<void>;
  prepareReferralCode(code: string): Promise<void>;
  issueReferralCode(): Promise<ReferralOverview>;
  getReferralStats(): Promise<ReferralStats>;
  activateInviteCode(code: string): Promise<User>;
  signUpWithCode(input: {
    name: string;
    phone: string;
    code?: string;
    inviteCode?: string;
  }): Promise<AuthSessionSnapshot>;
  validateInviteCode(code: string): Promise<InviteCodeValidation>;
  getSession(): Promise<AuthSessionSnapshot | null>;
  getProfile(): Promise<User>;
  updateProfile(input: { name: string }): Promise<User>;
  uploadAvatar(file: File): Promise<User>;
  deleteAccount(): Promise<void>;
  startRealnameFaceIdAttempt(input: { name: string; idCard: string; consent: boolean }): Promise<RealnameFaceIdAttempt>;
  getCurrentRealnameFaceIdAttempt(): Promise<RealnameFaceIdAttempt>;
  getRealnameFaceIdAttempt(attemptId: string): Promise<RealnameFaceIdAttempt>;
  sendRealnameFaceIdPhoneCode(attemptId: string, input?: { phone?: string }): Promise<SendSmsCodeResult>;
  verifyRealnameFaceIdPhone(attemptId: string, input: { code: string; phone?: string }): Promise<RealnameFaceIdAttempt>;
  finalizeRealnameFaceIdAttempt(attemptId: string): Promise<RealnameFaceIdAttempt>;
  /** 实名认证：POST /auth/realname/verify */
  verifyRealname(input: { name: string; idCard: string }): Promise<RealnameVerifyResult>;
  sendSmsCode(input: { phone: string }): Promise<SendSmsCodeResult>;
  verifyRealnamePhone(input: { code: string }): Promise<RealnamePhoneVerifyResult>;
  retryRealnameSync(): Promise<RealnameSyncRetryResult>;
  sendPhoneChangeCode(input: { phone: string }): Promise<SendSmsCodeResult>;
  verifyPhoneChange(input: { phone: string; code: string }): Promise<User>;
  /** 邮箱绑定：POST /auth/email/bind/request */
  requestEmailBind(input: { email: string }): Promise<{ cooldownSeconds: number }>;
  createTatDeviceBind(input: { callbackUrl: string; deviceName?: string }): Promise<TatDeviceBindResult>;
  createTencentCloudRedirect(targetPath?: string): Promise<TencentCloudRedirectResult>;
  listPaymentMethods(): Promise<PaymentMethodList>;
  createPaymentMethodSignOrder(languageCode: PaymentMethodLanguageCode): Promise<PaymentMethodSignOrder>;
  setDefaultPaymentMethod(contractCode: string): Promise<void>;
  deletePaymentMethod(contractCode: string): Promise<void>;
  getFederationAuthorizationContext(input: FederationAuthorizationInput): Promise<FederationAuthorizationContext>;
  issueFederationTicket(input: FederationAuthorizationInput): Promise<FederationTicketResult>;
  getOIDCAuthorizationContext(input: OIDCAuthorizationInput): Promise<OIDCAuthorizationContext>;
  authorizeOIDC(input: OIDCAuthorizationInput): Promise<OIDCAuthorizationResult>;
  prepareFederationSwitch(): Promise<void>;
  cancelFederationSwitch(): Promise<void>;
  getOAuthStartUrl(provider: OAuthProvider, options?: OAuthStartOptions): string | null;
  signInAsGuest(): Promise<AuthSessionSnapshot>;
  signOut(): Promise<void>;
}

export interface PlanRepository {
  listModifyBundles(passId: string): Promise<PassModifyBundles>;
  getModifyCheckout(passId: string): Promise<PassModifyCheckout>;
  createModifyOrder(passId: string, input: { target_bundle_id: string }): Promise<PassModifyOrder>;
  getModifyOrderUrl(passId: string, input: CreatePassOrderUrlInput): Promise<CreatePassOrderUrlResult>;
  refreshModifyPaymentAuthorization(passId: string, input: { deal_names: string[] }): Promise<{ auth_code: string }>;
  getOrderStatus(dealName: string): Promise<PassOrderStatus>;
  getCurrentSubscription(): Promise<CurrentSubscription | null>;
  getPlanPreview(): Promise<{
    currentCandidate: PlanTier;
    plans: PlanOption[];
    confirmationNeeded: boolean;
  }>;
  updateSubscription(tier: PlanTier): Promise<CurrentSubscription | null>;
  /**
   * 查询上线套餐（GET /v1/bundles）
   *
   * - 不传 query：仅返回 bundle 元数据（price 为 null）；适合未登录访客 / 历史调用
   * - 传 query：附带询价参数，已登录用户会拿到 BundlePrice 嵌套对象
   * - 与联调文档 codesign/ctl-frontend-billing-api.md §1.1 对齐
   */
  listBundles(query?: { time_span?: number; time_unit?: BundleTimeUnit }): Promise<Bundle[]>;
  getCreatePrerequisites(): Promise<{
    site_kind: string;
    shadow_account_enabled: boolean;
    shadow_bound: boolean;
  }>;
  sendShadowBindingSms(input: { country_code: string; phone_number: string; lang?: string }): Promise<void>;
  verifyShadowBindingPhone(input: { country_code: string; phone_number: string; phone_verify_code: string }): Promise<void>;
  /**
   * 创建试用 Pass（POST /v1/passes）— 国际站继续使用，国内站走 createPassOrder
   *
   * ⚠️ 此入口为「试用 pass」，由 ctl 内部规则决定是否允许，不走 jifei 计费。
   * 国内站新购请使用 createPassOrder，详见联调文档 §5.2。
   */
  createPass(bundleId: string): Promise<Pass>;
  /**
   * 国内站新购下单（POST /v1/passes/order）— 联调文档 §2.1（v1.7.31 拆分）
   *
   * 仅返 { deal_names }；拿到后需再调 getPassOrderUrl 拉支付 URL（§2.2）。
   * 拆分动机：前端需在拉支付 URL 前注入额外参数（如微信 wx_open_id、platform=mobile）。
   */
  createPassOrder(input: {
    bundle_id: string;
    period: number;
    time_unit: BundleTimeUnit;
    /** 自动续费标记（国际站支持）。取值：auto_renew / notify_and_manual_renew / no_notify_and_manual_renew；不传默认手动续费 */
    auto_renew_flag?: AutoRenewFlag;
  }): Promise<CreatePassOrderResult>;
  /**
   * 拉取新购支付 URL（POST /v1/passes/order-url）— 联调文档 §2.2（v1.7.31 + CodeBuddy AuthCode）
   *
   * 调用模式：
   *   PC 端：    `{ deal_names, platform: "pc" }`（依赖主站 Bearer）
   *   中转页：   `{ deal_names, platform: "mobile", wx_code, auth_code }`
   *               （**无主站 token**，靠 auth_code 鉴权）
   *
   * @param init.headers 可选：代质调用场景传入自定义 header（保留重建 Authorization 能力）。
   */
  getPassOrderUrl(
    input: CreatePassOrderUrlInput,
    init?: { headers?: Record<string, string> },
  ): Promise<CreatePassOrderUrlResult>;
  /**
   * 国内站新购下单+支付一体化（POST /v1/passes/order-and-pay）— 联调文档 §2.2
   *
   * ⚠️ 仅联调测试用，现网禁止暴露给真实用户。
   */
  createPassOrderAndPay(input: { bundle_id: string; period: number; time_unit: BundleTimeUnit }): Promise<CreatePassOrderAndPayResult>;
  /** 点石活动套餐专用下单并支付入口，不接受支付方式或自动续费参数。 */
  createDianshiPassOrderAndPay(input: {
    bundle_id: string;
    period: number;
    time_unit: BundleTimeUnit;
  }): Promise<CreateDianshiPassOrderAndPayResult>;
  /**
   * 续费询价（POST /v1/passes/{pass_id}/renew/price）— 联调文档 §3.1
   *
   * 询价无副作用，仅返回价格用于前端展示。前端确认后再调 createRenewOrder 走真实下单。
   */
  getRenewPrice(passId: string, input: { period: number; time_unit: BundleTimeUnit }): Promise<PassRenewPrice>;
  /**
   * 续费下单（POST /v1/passes/{pass_id}/renew/order）— 联调文档 §3.2（v1.7.31 拆分）
   *
   * 仅返 { deal_names }；拿到后需再调 getRenewOrderUrl 拉支付 URL（§3.3）。
   */
  createRenewOrder(passId: string, input: { period: number; time_unit: BundleTimeUnit }): Promise<CreatePassOrderResult>;
  /**
   * 拉取续费支付 URL（POST /v1/passes/{pass_id}/renew/order-url）— 联调文档 §3.3（v1.7.31 + CodeBuddy AuthCode）
   *
   * 调用模式与 getPassOrderUrl 一致：PC 端 Bearer / 中转页 auth_code。
   * @param init.headers 可选：代质调用场景传入自定义 header。
   */
  getRenewOrderUrl(
    passId: string,
    input: CreatePassOrderUrlInput,
    init?: { headers?: Record<string, string> },
  ): Promise<CreatePassOrderUrlResult>;
  /**
   * 续费下单+支付一体化（POST /v1/passes/{pass_id}/renew/order-and-pay）— 联调文档 §3.3
   *
   * ⚠️ 仅联调测试用。
   */
  createRenewOrderAndPay(passId: string, input: { period: number; time_unit: BundleTimeUnit }): Promise<CreatePassOrderAndPayResult>;
  /**
   * 销毁 pass（POST /v1/passes/{pass_id}/delete）— 联调文档 §4.1
   *
   * 前置条件：pass 状态必须是 isolated。同步成功后前端需轮询 listMyPasses 直到 pass 消失。
   */
  deletePass(passId: string): Promise<DeletePassResult>;
  /** 查询当前用户的权益列表（GET /v1/passes） */
  listMyPasses(): Promise<Pass[]>;
}

export interface DashboardSnapshot {
  runtime: BotRuntime | null;
  alerts: AlertItem[];
  bots: Bot[];
  deployments: Deployment[];
  releases: BotVersion[];
  billing: BillingSummary;
}

export interface WorkspaceSnapshot {
  bot: Bot;
  runtime: BotRuntime | null;
  messages: WorkspaceMessage[];
  quickActions: string[];
}

export interface SettingsSnapshot {
  bot: Bot;
  versions: BotVersion[];
  tools: ToolBinding[];
  knowledge: KnowledgeSource[];
  auditEvents: AuditEvent[];
  billing: BillingSummary;
}

export interface SoulTemplate {
  id: string;
  name: string;
  description: string;
}

/**
 * 重置实例配置 / 轮换 API Key 返回的运行时配置。
 *
 * 后端流程：生成新 API Key、持久化新 key_id、撤销旧 key。
 * 前端拿到 `config` 后需把它下发到实例（具体下发命令由调用方决定）。
 * 若下发失败，用户可再 reset 一次拿新配置——服务端每次都会重新轮换。
 */
export interface BotInstanceConfig {
  /** 上游模型供应商标识，如 `custom` */
  providerName: string;
  /** 上游模型 base URL */
  baseUrl: string;
  /** 上游模型 ID */
  modelId: string;
  /** API 类型，如 `chat_completions` */
  api: string;
  /** 新生成的 API Key 明文（仅本次返回，前端用完即丢，不持久化） */
  apiKey: string;
}

export interface BotInstanceConfigResetResult {
  /** 新 key 的 ID，服务端已持久化 */
  keyId: string;
  /** 新 key 的可展示前缀，如 `sk-xxxx` */
  keyPrefix: string;
  /** 新一轮的实例运行时配置，调用方需自行下发到实例 */
  config: BotInstanceConfig;
}

export interface WorkerActionStartResult {
  actionRunId: string;
  workflowId: string;
  runId?: string;
  action: string;
  botId: string;
  status: string;
}

export interface WorkerActionStatusLog {
  time?: string;
  phase?: string;
  message: string;
  level?: string;
}

export interface WorkerActionStatusResult {
  workflowId?: string;
  runId?: string;
  phase: string;
  error?: string;
  dryRun?: boolean;
  logs: WorkerActionStatusLog[];
}

export interface BotRepository {
  getDashboardSnapshot(mode?: DataMode): Promise<DashboardSnapshot>;
  createBot(input?: {
    name?: string;
    description?: string;
    soulTemplateId?: string;
    createMode?: "blank" | "clone";
    sourceBotId?: string;
    initialSoul?: string;
  }): Promise<Bot>;
  retryBot(botId: string): Promise<Bot | null>;
  destroyBot(botId: string): Promise<void>;
  renameBot(botId: string, name: string): Promise<Bot>;
  updateBotProfile(
    botId: string,
    patch: Partial<Pick<Bot, "name" | "type" | "template" | "mission" | "scenario" | "status">>,
  ): Promise<Bot>;
  getWorkspaceSnapshot(botId: string, mode?: DataMode): Promise<WorkspaceSnapshot>;
  sendWorkspaceMessage(botId: string, text: string): Promise<WorkspaceMessage[]>;
  getSettingsSnapshot(botId: string, mode?: DataMode): Promise<SettingsSnapshot>;
  getTerminalSession(botId: string): Promise<BotTerminalSession>;
  configureQQChannel(botId: string, input: { appId: string; appSecret: string; account?: string }): Promise<BotChannelConfigResult>;
  claimUniqueChannel(botId: string, channel: "weixin"): Promise<void>;
  confirmUniqueChannel(botId: string, channel: "weixin"): Promise<void>;
  releaseUniqueChannel(botId: string, channel: "weixin"): Promise<void>;
  createWeixinLoginSession(botId: string): Promise<{ sessionId: string; status: string }>;
  getWeixinLoginSession(botId: string, sessionId: string): Promise<WeixinLoginSession>;
  cancelWeixinLoginSession(botId: string, sessionId: string): Promise<WeixinLoginSession>;
  subscribeWeixinLoginSessionEvents(botId: string, sessionId: string, signal?: AbortSignal): AsyncIterable<{ event: string; data: unknown }>;
  listSoulTemplates(): Promise<SoulTemplate[]>;
  execDebugCommand(
    botId: string,
    command: string,
    options?: { timeoutMs?: number },
  ): Promise<{ status: string; exitCode: number; output: string }>;
  execDebugCommandStream(
    botId: string,
    command: string,
    onChunk: (event: { stream: string; chunk: string }) => void,
    options?: { timeoutMs?: number },
  ): Promise<{ status: string; exitCode: number; output: string }>;
  startRescueExport(botId: string): Promise<WorkerActionStartResult>;
  getRescueExportStatus(botId: string): Promise<WorkerActionStatusResult | null>;
  importHermesWorkspace(botId: string, file: File): Promise<WorkerActionStartResult>;
  getHermesImportStatus(botId: string): Promise<WorkerActionStatusResult | null>;
  /**
   * 重置实例配置（轮换 API Key）。
   *
   * `POST /v1/instances/:botId/config/reset`，无请求体。
   *
   * 该接口保证：成功返回 = 服务端新 key 已生效、旧 key 已撤销。
   * 前端需把 `config` 下发到实例；下发失败时再次调用即可拿新一轮 config。
   */
  resetInstanceConfig(botId: string): Promise<BotInstanceConfigResetResult>;
}

/**
 * 积分包仓储。
 *
 * 对应 credit 服务（credit/internal/httpapi/server.go:35-53），
 * 接口契约见 docs/frontend-credit-package-integration.md。
 *
 * ⚠️ 禁止接入 POST /v1/credit/packages/order-and-pay —— 该接口仅限内部联调
 * 与自动化测试，控制台不得调用（联调文档 §1）。
 */
export interface CreditRepository {
  /** `GET /v1/credit/products` —— 在售积分包商品。 */
  listCreditProducts(): Promise<CreditProduct[]>;
  /**
   * `POST /v1/credit/inquiry` —— 单个商品询价。
   *
   * 按商品逐个询价：产品要求单卡询价失败只禁用该卡、不影响其他卡，
   * 因此调用方并发调用并单独处理每个 Promise 的失败。
   */
  inquireCreditPrice(productId: string): Promise<CreditQuote>;
  /**
   * `POST /v1/credit/packages/order` —— 创建待支付订单。
   *
   * 商品与周期必须与询价一致。响应为 camelCase（`dealName`），
   * 下一步 order-url 请求则用 snake_case 的 `deal_name`。
   */
  createCreditOrder(productId: string): Promise<CreditOrderResult>;
  /**
   * `POST /v1/credit/packages/order-url` —— 获取已创建订单的支付链接。
   *
   * `need_charge=1` 时跳转 `pay_url`；`need_charge=0` 时无需支付，直接刷新积分包。
   * 订单不存在、归属不匹配或类型不匹配时后端返回 404。
   */
  createCreditOrderUrl(input: CreditOrderUrlInput): Promise<CreditOrderUrlResult>;
  /** `GET /v1/credit/packages` —— 当前用户的有效积分包。 */
  listCreditPackages(): Promise<CreditPackageItem[]>;
}

export interface Repositories {
  auth: AuthRepository;
  plans: PlanRepository;
  bots: BotRepository;
  credit: CreditRepository;
}
