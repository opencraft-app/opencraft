import type {
  AlertItem,
  AuthSessionSnapshot,
  AuditEvent,
  BillingSummary,
  Bundle,
  CurrentSubscription,
  Bot,
  BotBornCard,
  BotChannelConfigResult,
  BotTerminalSession,
  BotRuntime,
  BotVersion,
  DataMode,
  Deployment,
  InviteCodeValidation,
  KnowledgeSource,
  Pass,
  PlanOption,
  PlanTier,
  ToolBinding,
  User,
  WeixinLoginSession,
  WorkspaceMessage,
} from "@/domain/types";
import type { OAuthProvider } from "@/lib/oauth";

export interface RealnameVerifyResult {
  ok: boolean;
  verified: boolean;
  nameMasked: string;
  idCardMasked: string;
  requestId: string;
}

export interface AuthRepository {
  signInWithCode(input: { phone: string; code?: string; inviteCode?: string }): Promise<AuthSessionSnapshot>;
  prepareInviteCode(code: string): Promise<void>;
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
  /** 实名认证：POST /auth/realname/verify */
  verifyRealname(input: { name: string; idCard: string }): Promise<RealnameVerifyResult>;
  getOAuthStartUrl(provider: OAuthProvider): string | null;
  signInAsGuest(): Promise<AuthSessionSnapshot>;
  signOut(): Promise<void>;
}

export interface PlanRepository {
  getCurrentSubscription(): Promise<CurrentSubscription | null>;
  getPlanPreview(): Promise<{
    currentCandidate: PlanTier;
    plans: PlanOption[];
    confirmationNeeded: boolean;
  }>;
  updateSubscription(tier: PlanTier): Promise<CurrentSubscription | null>;
  /** 查询上线套餐（GET /v1/bundles） */
  listBundles(): Promise<Bundle[]>;
  /** 购买套餐（POST /v1/passes { bundle_id }） */
  createPass(bundleId: string): Promise<Pass>;
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

export interface BotRepository {
  getDashboardSnapshot(mode?: DataMode): Promise<DashboardSnapshot>;
  createBot(input?: { name?: string; soulTemplateId?: string }): Promise<Bot>;
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
  getBotBornCard(botId: string): Promise<BotBornCard>;
  configureQQChannel(botId: string, input: { appId: string; appSecret: string; account?: string }): Promise<BotChannelConfigResult>;
  createWeixinLoginSession(botId: string): Promise<{ sessionId: string; status: string }>;
  getWeixinLoginSession(botId: string, sessionId: string): Promise<WeixinLoginSession>;
  cancelWeixinLoginSession(botId: string, sessionId: string): Promise<WeixinLoginSession>;
  subscribeWeixinLoginSessionEvents(botId: string, sessionId: string, signal?: AbortSignal): AsyncIterable<{ event: string; data: unknown }>;
  listSoulTemplates(): Promise<SoulTemplate[]>;
  execDebugCommand(botId: string, command: string): Promise<{ status: string; exitCode: number; output: string }>;
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

export interface Repositories {
  auth: AuthRepository;
  plans: PlanRepository;
  bots: BotRepository;
}
