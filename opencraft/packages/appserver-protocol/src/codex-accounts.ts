export interface CodexAccountLimitWindowView {
  readonly slot: "primary" | "secondary";
  readonly windowMinutes: number | null;
  readonly utilization: number | null;
  readonly resetAt: number | null;
  readonly observedAt: number;
}

export interface CodexAccountView {
  readonly id: string;
  readonly label: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly credentialConfigured: boolean;
  readonly email: string | null;
  readonly subscriptionType: string | null;
  readonly rateLimitTier: string | null;
  readonly status: "disabled" | "ready" | "held" | "exhausted" | "error";
  readonly observedAt: number | null;
  readonly heldUntil: number | null;
  readonly lastUsedAt: number | null;
  readonly lastUsedHostId: string | null;
  readonly limitWindows: readonly CodexAccountLimitWindowView[];
}

export interface CodexDeviceLoginView {
  readonly sessionId: string;
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly expiresAt: number;
}

export type CodexDeviceLoginPollView =
  | { readonly status: "pending" }
  | { readonly status: "complete"; readonly account: CodexAccountView }
  | { readonly status: "error"; readonly message: string };

export interface AppServerCodexAccountMethodMap {
  "opencraft/codex/accounts/list": {
    params: Record<string, never>;
    result: { readonly accounts: readonly CodexAccountView[] };
  };
  "opencraft/codex/accounts/setEnabled": {
    params: { readonly accountId: string; readonly enabled: boolean };
    result: { readonly accounts: readonly CodexAccountView[] };
  };
  "opencraft/codex/accounts/reorder": {
    params: { readonly accountIds: readonly string[] };
    result: { readonly accounts: readonly CodexAccountView[] };
  };
  "opencraft/codex/accounts/remove": {
    params: { readonly accountId: string };
    result: { readonly accounts: readonly CodexAccountView[] };
  };
  "opencraft/codex/accounts/refresh": {
    params: { readonly accountId: string };
    result: { readonly accounts: readonly CodexAccountView[] };
  };
  "opencraft/codex/accounts/import": {
    params: Record<string, never>;
    result: { readonly account: CodexAccountView };
  };
  "opencraft/codex/accounts/deviceLogin/start": {
    params: Record<string, never>;
    result: CodexDeviceLoginView;
  };
  "opencraft/codex/accounts/deviceLogin/poll": {
    params: { readonly sessionId: string };
    result: CodexDeviceLoginPollView;
  };
  "opencraft/codex/accounts/deviceLogin/cancel": {
    params: { readonly sessionId: string };
    result: { readonly cancelled: boolean };
  };
}
