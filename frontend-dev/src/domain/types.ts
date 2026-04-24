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
  status: "draft" | "active" | "paused";
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
}

export interface BotChannelConfigResult {
  status: string;
  channel: string;
  gatewayRestarted: boolean;
  output?: string;
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

export interface VerificationCodeRequest {
  phone: string;
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
