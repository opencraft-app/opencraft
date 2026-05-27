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
  email?: string;
  phone?: string;
  avatarUrl?: string;
  inviteRequired: boolean;
  /** 是否已完成实名认证，后端 /auth/session /auth/profile 下发 */
  realnameVerified?: boolean;
  createdAt: string;
}

export interface Bot {
  id: string;
  sandboxId?: string;
  name: string;
  type: "sales" | "support" | "ops" | "research";
  template: string;
  mission?: string;
  scenario?: string;
  createdAt: string;
  status: "draft" | "provisioning" | "active" | "paused" | "failed" | "deleting";
}

export interface BotBornCard {
  instanceId: string;
  userId: string;
  sandboxId?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  timeoutAt?: string;
  bornDateForChina: string;
  bornNumberForChina: number;
}

export interface BotTerminalSession {
  sandboxId: string;
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
export type BundleTimeUnit = "d" | "m";

export interface BundleDescriptionEntry {
  Key: string;
  Value: string;
}

export interface Bundle {
  bundle_id: string;
  bundle_name: string;
  description: BundleDescriptionEntry[];
  bundle_state: BundleState;
  agent_quota: number;
  /** 积分数量（套餐包含多少 AI 积分） */
  credit: number;
  /** 价格（人民币元），0 表示免费版；后端未返回时前端按免费处理 */
  price?: number;
  time_span: number;
  time_unit: BundleTimeUnit;
  bundle_sales_available_count: number;
  bundle_sales_total_count: number;
  bundle_sales_state: BundleSalesState;
  created_time?: string;
  updated_time?: string;
}

export interface Pass {
  pass_id: string;
  user_id: string;
  bundle_id: string;
  bundle_name: string;
  uin?: number;
  app_id?: number;
  created_time: string;
  expired_time: string;
  isolated_time?: string | null;
  deleted_time?: string | null;
  updated_time?: string;
  credit_total: number;
  credit_available: number;
}
