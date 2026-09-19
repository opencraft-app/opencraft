import { Gauge, LogIn, LogOut, Settings, User } from "lucide-react";
import { useEffect, useState } from "react";
import type { PlatformAccountSnapshot } from "@opencraft/extension-react";
import { NavigationIcon, type NavigationAction } from "./navigation-action";

export interface ShellAccount {
  readonly signIn?: ShellSignIn | null;
  readonly snapshot: PlatformAccountSnapshot;
  readonly onOpen: () => void;
  readonly onRefresh: () => Promise<unknown>;
  readonly onSignOut: () => Promise<void>;
}

export interface ShellSignIn {
  readonly options: readonly { readonly id: string; readonly label: string; readonly description: string }[];
  readonly pending: boolean;
  readonly error: string | null;
  select(optionId: string): void;
  cancel(): void;
  retry(): void;
}

export interface ShellNavigationConfig {
  readonly actions: readonly NavigationAction[];
  readonly account: ShellAccount | null;
  readonly onOpenSettings: () => void;
  readonly settingsActive?: boolean;
  readonly allowDock?: boolean;
}

export function isAnonymousShellAccount(account: ShellAccount | null): boolean {
  return account?.snapshot.phase === "anonymous";
}

export function shellAccountEntranceLabel(account: ShellAccount | null): string | null {
  if (account === null) return null;
  if (isAnonymousShellAccount(account)) {
    if (account.signIn?.pending) return "正在登录…";
    if (account.signIn?.error) return "登录未完成";
    return "Sign in";
  }
  return account.snapshot.name || "Account";
}

export function AccountAvatar({ account }: { account: ShellAccount | null }) {
  return <span className="sidebar-account__avatar" aria-hidden="true">
    {account?.snapshot.avatarUrl
      ? <img src={account.snapshot.avatarUrl} alt="" />
      : (account?.snapshot.name?.trim()[0] || <User size={16} />)}
  </span>;
}

export function AccountLeadingVisual({ account }: { account: ShellAccount | null }) {
  return isAnonymousShellAccount(account)
    ? <LogIn aria-hidden="true" size={16} />
    : <AccountAvatar account={account} />;
}

/** The same content is placed in a rail or a transient surface by the Shell. */
export function NavigationContent({ config, surface, compact = false, onInvoke }: {
  config: ShellNavigationConfig;
  surface: "applications" | "account";
  compact?: boolean;
  onInvoke: (action: () => void) => void;
}) {
  return surface === "applications" ? <nav aria-label="Applications" className="shell-navigation__items">
    {config.actions.map(action => <button type="button" key={action.id}
      aria-current={action.active ? "page" : undefined} title={compact ? action.title : undefined} onClick={() => onInvoke(action.onInvoke)}>
      <NavigationIcon name={action.icon} /><span className="shell-navigation__item-label">{action.title}</span>
    </button>)}
    <button type="button" aria-current={config.settingsActive ? "page" : undefined} title={compact ? "Settings" : undefined} onClick={() => onInvoke(config.onOpenSettings)}><Settings size={16} /><span className="shell-navigation__item-label">Settings</span></button>
  </nav> : <AccountContent compact={compact} config={config} onInvoke={onInvoke} />;
}

function AccountContent({ config, compact, onInvoke }: {
  config: ShellNavigationConfig;
  compact: boolean;
  onInvoke: (action: () => void) => void;
}) {
  const account = config.account;
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void account?.onRefresh().catch(() => undefined);
  }, [account?.onRefresh]);
  if (account === null) return null;
  if (isAnonymousShellAccount(account)) {
    return <div className="shell-navigation__items">
      <button type="button" onClick={() => onInvoke(account.onOpen)}>
        <LogIn size={16} /><span>Sign in to LightVela</span>
      </button>
    </div>;
  }
  return <div className="shell-navigation__items">
    <>
      <button type="button" title={compact ? account.snapshot.name || "Account" : undefined} onClick={() => onInvoke(account.onOpen)}>
        <AccountAvatar account={account} /><span className="shell-navigation__identity">
          <strong>{account.snapshot.name || "LightVela"}</strong>
          <small>{account.snapshot.planLabel || "Account Settings"}</small>
        </span>
      </button>
      {account.snapshot.usageRemainingPercent === null ? null : <button type="button" onClick={() => onInvoke(account.onOpen)}>
        <Gauge size={16} /><span>Usage</span><small>{account.snapshot.usageRemainingPercent}% left</small>
      </button>}
      <button type="button" onClick={() => onInvoke(account.onOpen)}><User size={16} /><span>Account</span></button>
    </>
    <button type="button" onClick={() => onInvoke(config.onOpenSettings)}><Settings size={16} /><span>Settings</span></button>
    <button type="button" disabled={signingOut} onClick={async () => {
      setSigningOut(true);
      setError(null);
      try { await account.onSignOut(); onInvoke(() => undefined); }
      catch { setError("Could not sign out. Please try again."); }
      finally { setSigningOut(false); }
    }}><LogOut size={16} /><span>{signingOut ? "Signing out…" : "Sign out"}</span></button>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
