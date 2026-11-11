export type OnboardingAgentId = "codex" | "cursor" | "claude" | "codebuddy";

export interface OnboardingActivity {
  readonly kind: "sign-in" | "install";
  readonly phase: "running" | "failed";
  readonly message: string | null;
  readonly url: string | null;
  readonly userCode: string | null;
  readonly log: string;
}

export interface OnboardingAgentSnapshot {
  readonly id: OnboardingAgentId;
  /** Agent identity used by model/list. Optional for older Hosts. */
  readonly engineId?: string;
  readonly displayName?: string;
  readonly installed: boolean;
  readonly version: string | null;
  readonly authenticated: boolean | null;
  readonly account: string | null;
  readonly installUrl: string;
  readonly canInstallPackage: boolean;
  readonly activity: OnboardingActivity | null;
}

export interface OnboardingSnapshot {
  readonly agents: readonly OnboardingAgentSnapshot[];
}

export interface OnboardingAgentModel {
  readonly id: string;
  readonly name: string;
}

export interface AgentOnboardingMethodMap {
  "opencraft/agents/onboarding/status": { params: Record<string, never>; result: OnboardingSnapshot };
  "opencraft/agents/onboarding/act": {
    params: { id: string; action: "sign-in" | "install" | "cancel" };
    result: OnboardingSnapshot;
  };
  "opencraft/agents/onboarding/models": {
    params: { id: string };
    result: { models: readonly OnboardingAgentModel[] };
  };
}
