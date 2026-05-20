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
  /** 读取 bot workspace 下的某个文件（如 SOUL.md），缺失时返回 null */
  getWorkspaceFile(botId: string, name: string): Promise<{ name: string; content: string } | null>;
  /** 写入/覆盖 bot workspace 下的某个文件（如 SOUL.md） */
  updateWorkspaceFile(botId: string, name: string, content: string): Promise<{ name: string; updatedAt: number }>;
}

export interface Repositories {
  auth: AuthRepository;
  plans: PlanRepository;
  bots: BotRepository;
}
