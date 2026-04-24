import type {
  AlertItem,
  AuthSessionSnapshot,
  AuditEvent,
  BillingSummary,
  CurrentSubscription,
  Bot,
  BotChannelConfigResult,
  BotTerminalSession,
  BotRuntime,
  BotVersion,
  DataMode,
  Deployment,
  InviteCodeValidation,
  KnowledgeSource,
  PlanOption,
  PlanTier,
  ToolBinding,
  User,
  VerificationCodeRequest,
  WorkspaceMessage,
} from "@/domain/types";

export interface AuthRepository {
  signInWithCode(input: { phone: string; code: string; inviteCode?: string }): Promise<AuthSessionSnapshot>;
  sendVerificationCode(input: VerificationCodeRequest): Promise<{ cooldownSeconds: number }>;
  prepareInviteCode(code: string): Promise<void>;
  signUpWithCode(input: {
    name: string;
    phone: string;
    code: string;
    inviteCode?: string;
  }): Promise<AuthSessionSnapshot>;
  validateInviteCode(code: string): Promise<InviteCodeValidation>;
  getSession(): Promise<AuthSessionSnapshot | null>;
  getProfile(): Promise<User>;
  updateProfile(input: { name: string }): Promise<User>;
  uploadAvatar(file: File): Promise<User>;
  deleteAccount(): Promise<void>;
  getOAuthStartUrl(provider: "qq"): string | null;
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

export interface BotRepository {
  getDashboardSnapshot(mode?: DataMode): Promise<DashboardSnapshot>;
  createBot(input?: { name?: string }): Promise<Bot>;
  destroyBot(botId: string): Promise<void>;
  updateBotProfile(
    botId: string,
    patch: Partial<Pick<Bot, "name" | "type" | "template" | "mission" | "scenario" | "status">>,
  ): Promise<Bot>;
  getWorkspaceSnapshot(botId: string, mode?: DataMode): Promise<WorkspaceSnapshot>;
  sendWorkspaceMessage(botId: string, text: string): Promise<WorkspaceMessage[]>;
  getSettingsSnapshot(botId: string, mode?: DataMode): Promise<SettingsSnapshot>;
  getTerminalSession(botId: string): Promise<BotTerminalSession>;
  configureQQChannel(botId: string, input: { appId: string; appSecret: string; account?: string }): Promise<BotChannelConfigResult>;
}

export interface Repositories {
  auth: AuthRepository;
  plans: PlanRepository;
  bots: BotRepository;
}
