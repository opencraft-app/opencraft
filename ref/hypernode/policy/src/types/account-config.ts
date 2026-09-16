import type { AppServerConnection } from "./appserver.ts";
import type { HostUserRecord } from "./host-policy.ts";

export interface CodexAccountRecord {
  type: string;
  email?: string | null;
  planType?: string | null;
}

export interface CodexAccountProfile {
  id: string;
  name: string;
  email: string | null;
  planType: string | null;
  accountIdentity: string;
}

export interface CodexProfileSource {
  list(user: HostUserRecord): CodexAccountProfile[];
  activate(user: HostUserRecord, profileId: string): unknown;
}

export interface CodexFallbackSource {
  available(user: HostUserRecord): boolean;
}

export type CodexAccountBoundListener = (
  userId: string,
  account: CodexAccountRecord,
) => void;

export interface CodexAccountBindingPort {
  onBound(listener: CodexAccountBoundListener): () => boolean;
  begin(
    connection: AppServerConnection,
    threadId: string,
    options?: { forceNew?: boolean },
  ): string;
}

export interface AccountCatalogPort {
  render(connection: AppServerConnection): string;
  add(connection: AppServerConnection, threadId?: string | null): string;
  list(connection: AppServerConnection): Array<{
    userId?: string;
    username: string;
    bindingState?: string;
    authMode: string | null;
    email: string | null;
    planType: string | null;
    boundAtMs?: number | null;
    lastVerifiedAtMs?: number | null;
    remoteControlStatus: string;
    profiles?: readonly CodexAccountProfile[];
    activeProfileId?: string | null;
  }>;
  profilesForUser(user: HostUserRecord | null): CodexAccountProfile[];
  activateProfile(user: HostUserRecord, profileId: string): unknown;
  onBeforeProfileActivated(listener: (user: HostUserRecord) => void): () => boolean;
  onProfileActivated(listener: (user: HostUserRecord) => void): () => boolean;
  codexProfileForIdentity(
    user: HostUserRecord | null,
    accountIdentity: string | null,
  ): CodexAccountProfile | null;
  selectProfile(
    connection: AppServerConnection,
    params: Record<string, unknown>,
  ): {
    profile: { profileId: string };
    runtimeRefresh: RuntimeRefreshResult;
  };
}

export interface RemoteControlStatusPort {
  statusForUser(userId: string): { status?: string } | null;
}

export type ExecutionProfileKind = "api" | "codex" | "public";

export interface ExecutionProfileSelection {
  kind: ExecutionProfileKind;
  profileId: string;
}

export interface ModelProviderRecord extends Record<string, unknown> {
  id?: string;
  providerId: string;
  displayName?: string;
  endpoint?: string;
  model?: string | null;
  visibility?: string;
  metadataProvider?: string | null;
  inputModalities?: readonly unknown[];
}

export interface RuntimeRefreshResult {
  retired: number;
  deferred: number;
}

export interface SubscriptionSelectionResult {
  profile: {
    kind: "codex";
    id: string;
    name: string;
  };
  runtimeRefresh: RuntimeRefreshResult;
}
