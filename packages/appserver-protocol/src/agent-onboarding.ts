import type { NativeConversationProject } from "./native-conversation-project";
export type OnboardingAgentId = "codex" | "cursor" | "claude" | "gemini" | "codebuddy" | "codebuddy-ide" | "pi" | "dsh";

export type HistoryImportAgentId = OnboardingAgentId;

export interface OnboardingActivity {
  readonly kind: "sign-in" | "install" | "upgrade";
  readonly phase: "running" | "failed";
  readonly message: string | null;
  readonly url: string | null;
  readonly userCode: string | null;
  readonly awaitingCode?: boolean;
  readonly log: string;
}

export interface OnboardingAgentSnapshot {
  readonly id: OnboardingAgentId;
  /** Agent identity used by model/list. Optional for older Hosts. */
  readonly engineId?: string;
  readonly displayName?: string;
  /** Native history can be listed, read and resumed by this Host. */
  readonly historyImport?: boolean;
  /** Opaque native account/project identity; scopes import UI caches. */
  readonly historyScope?: string;
  readonly installed: boolean;
  readonly version: string | null;
  readonly authenticated: boolean | null;
  /** Native desktop client requires its explicit bridge connection. */
  readonly connectionRequired?: boolean;
  readonly workspaceTrusted?: boolean;
  readonly account: string | null;
  readonly installUrl: string;
  readonly canInstallPackage: boolean;
  /** Interactive native setup must run in a terminal on this machine. */
  readonly setupCommand?: string;
  readonly activity: OnboardingActivity | null;
}

export interface LocalAgentConversation {
  readonly id: string;
  readonly title: string | null;
  readonly cwd: string;
  readonly updatedAt: string | null;
  readonly createdAt?: string;
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
  "opencraft/agents/onboarding/history-agents": {
    params: Record<string, never>;
    /** Local executable observations and connected IDE metadata; no login probes. */
    result: OnboardingSnapshot;
  };
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
  "opencraft/agents/onboarding/history-sources": {
    params: { id: HistoryImportAgentId };
    result: {sources: readonly {id:string;path:string;configured:boolean;hasNames:boolean}[]};
  };
  "opencraft/agents/onboarding/history": {
    params: { id: HistoryImportAgentId; cursor?: string; archived?: boolean; sourceId?: string };
    result: { conversations: readonly LocalAgentConversation[]; nextCursor: string | null; supportsArchived?: boolean };
  };
  "opencraft/agents/onboarding/import": {
    params: { id: HistoryImportAgentId; conversationIds: readonly string[]; sourceId?: string };
    result: { imported: readonly { id: string; threadId: string }[]; failed: readonly string[] };
  };
  "opencraft/agents/onboarding/status": { params: Record<string, never>; result: OnboardingSnapshot };
  "opencraft/agents/onboarding/package-versions": {
    params: { force?: boolean };
    result: { versions: Readonly<Record<string, string | null>>; checkedAt: number };
  };
  "opencraft/agents/onboarding/act": {
    params: { id: string; action: "sign-in" | "install" | "upgrade" | "cancel" | "submit-code"; code?: string };
    result: OnboardingSnapshot;
  };
  "opencraft/agents/onboarding/models": {
    params: { id: string };
    result: { models: readonly OnboardingAgentModel[] };
  };
}
