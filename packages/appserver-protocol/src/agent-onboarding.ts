import type { NativeConversationProject } from "./native-conversation-project";
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

export interface LocalAgentConversation {
  readonly id: string;
  readonly title: string | null;
  readonly cwd: string;
  readonly updatedAt: string | null;
  readonly imported: boolean;
  readonly nativeProject?: NativeConversationProject;
}

export interface OnboardingSnapshot {
  readonly historyImport?: boolean;
  readonly agents: readonly OnboardingAgentSnapshot[];
}

export interface OnboardingAgentModel {
  readonly id: string;
  readonly name: string;
}

export interface AgentConversationContinuation {
  readonly id: string;
  readonly sourceThreadId: string;
  readonly title: string | null;
  readonly cwd: string;
  readonly uri: string;
  readonly transcriptPath: string;
  readonly archivePath: string;
  readonly turnCount: number;
}

export interface AgentOnboardingMethodMap {
  "opencraft/agent-session/export-context": {
    params: { threadId: string };
    result: AgentConversationContinuation & { collaborationSpaceId: string };
  };
  "opencraft/agent-session/status": {
    params: { threadId: string };
    result: { fork: boolean; release: boolean; loaded: boolean };
  };
  "opencraft/agent-session/release": {
    params: { threadId: string };
    result: { released: boolean };
  };
  "opencraft/agents/onboarding/history": {
    params: { id: "codex" | "cursor"; cursor?: string };
    result: { conversations: readonly LocalAgentConversation[]; nextCursor: string | null };
  };
  "opencraft/agents/onboarding/import": {
    params: { id: "codex" | "cursor"; conversationIds: readonly string[] };
    result: { imported: readonly { id: string; threadId: string }[]; failed: readonly string[] };
  };
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
