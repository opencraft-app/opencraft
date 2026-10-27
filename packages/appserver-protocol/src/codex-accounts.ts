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
  /** Absent on older Hosts which cannot configure this policy. */
  readonly allowCredits?: boolean;
  readonly credentialConfigured: boolean;
  readonly email: string | null;
  readonly subscriptionType: string | null;
  readonly rateLimitTier: string | null;
  /** Absent on older Hosts; null when the service has not reported a count. */
  readonly resetCredits?: { readonly availableCount: number; readonly observedAt: number } | null;
  /** Only present when the account owner implements both explicit credit methods. */
  readonly resetCreditActions?: boolean;
  readonly status: "disabled" | "ready" | "held" | "exhausted" | "error";
  readonly observedAt: number | null;
  readonly heldUntil: number | null;
  readonly lastUsedAt: number | null;
  readonly lastUsedHostId: string | null;
  readonly limitWindows: readonly CodexAccountLimitWindowView[];
}

export interface CodexResetCreditView {
  readonly id: string;
  readonly title: string | null;
  readonly status: "available" | "redeeming" | "redeemed" | "unknown";
  readonly resetType: string;
  readonly supportedByPlan: boolean;
  readonly grantedAt: number | null;
  /** Milliseconds, unlike the raw HTTP endpoint's ISO string. */
  readonly expiresAt: number | null;
  /** Distinguishes explicit no-expiry from absent or malformed expiry metadata. */
  readonly expiryKnown: boolean;
}

export interface CodexResetCreditsView {
  readonly availableCount: number | null;
  readonly observedAt: number;
  readonly credits: readonly CodexResetCreditView[];
}

export type CodexResetCreditOutcome = "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed" | "unknown";

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
  "opencraft/codex/accounts/resetCredits/list": {
    params: { readonly accountId: string };
    result: CodexResetCreditsView;
  };
  "opencraft/codex/accounts/resetCredits/consume": {
    params: { readonly accountId: string; readonly creditId: string; readonly idempotencyKey: string; readonly confirmed: true };
    result: {
      readonly outcome: CodexResetCreditOutcome;
      readonly credits: CodexResetCreditsView | null;
      readonly usageRefreshed: boolean;
      readonly accounts: readonly CodexAccountView[];
    };
  };
  "opencraft/codex/accounts/list": {
    params: Record<string, never>;
    result: { readonly accounts: readonly CodexAccountView[] };
  };
  "opencraft/codex/accounts/setEnabled": {
    params: { readonly accountId: string; readonly enabled: boolean };
    result: { readonly accounts: readonly CodexAccountView[] };
  };
  "opencraft/codex/accounts/setAllowCredits": {
    params: { readonly accountId: string; readonly allowCredits: boolean };
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
