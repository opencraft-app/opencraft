import { LiquidGlassBackdrop } from "@opencraft/design-system-web/liquid-glass";
import { SettingsGearIcon } from "@opencraft/design-system-web/action-icons";
import * as Tooltip from "@radix-ui/react-tooltip";
import { GaugeIcon as Gauge, LoginIcon as LogIn, LogoutIcon as LogOut, PersonIcon as User } from "@opencraft/design-system-web/action-icons";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import type { IntlShape } from "@opencraft/i18n";
import { useEffect, useState } from "react";
import { AvatarImage, type PlatformAccountSnapshot } from "@opencraft/extension-react";
import { shellNavigationLabels } from "./navigation-labels";
import { NavigationIcon, type NavigationAction } from "./navigation-action";

export interface ShellAccount {
  readonly providerId?: string;
  readonly signIn?: ShellSignIn | null;
  readonly snapshot: PlatformAccountSnapshot;
  readonly onOpen: () => void;
  readonly onRefresh: () => Promise<unknown>;
  readonly onSignOut?: (() => Promise<void>) | undefined;
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
  readonly layout?: "unified";
  readonly actions: readonly NavigationAction[];
  readonly account: ShellAccount | null;
  readonly onOpenSettings: () => void;
  readonly settingsActive?: boolean;
  readonly onOpenUpdates?: () => void;
  readonly updatesActive?: boolean;
  readonly allowDock?: boolean;
}

export function isAnonymousShellAccount(account: ShellAccount | null): boolean {
  return account?.snapshot.phase === "anonymous";
}

export function shellAccountEntranceLabel(account: ShellAccount | null, intl: IntlShape): string | null {
  if (account === null) return null;
  if (isAnonymousShellAccount(account)) {
    if (account.signIn?.pending) return intl.formatMessage({ id: "account.signingIn", defaultMessage: "Signing in…" });
    if (account.signIn?.error) return intl.formatMessage({ id: "account.signInIncomplete", defaultMessage: "Sign-in incomplete" });
    if (account.snapshot.anonymousLabelMessage) return intl.formatMessage(account.snapshot.anonymousLabelMessage);
    if (account.snapshot.anonymousLabel) return account.snapshot.anonymousLabel;
    return intl.formatMessage({ id: "account.signIn", defaultMessage: "Sign in" });
  }
  return account.snapshot.name || intl.formatMessage({ id: "account.title", defaultMessage: "Account" });
}

export function AccountAvatar({ account }: { account: ShellAccount | null }) {
  return <span className="sidebar-account__avatar" aria-hidden="true">
    <AvatarImage src={account?.snapshot.avatarUrl ?? null} fallback={account?.snapshot.name?.trim()[0] || <User size={16} />} />
  </span>;
}

export function AccountLeadingVisual({ account }: { account: ShellAccount | null }) {
  return isAnonymousShellAccount(account)
    ? <LogIn aria-hidden="true" size={16} />
    : <AccountAvatar account={account} />;
}

/** The same content is placed in a rail or a transient surface by the Shell. */
export function NavigationContent({ config, surface, compact = false, includeSettings = true, onInvoke }: {
  config: ShellNavigationConfig;
  surface: "applications" | "account";
  compact?: boolean;
  includeSettings?: boolean;
  onInvoke: (action: () => void) => void;
}) {
  const intl = useIntl();
  return surface === "applications" ? <Tooltip.Provider delayDuration={350} disableHoverableContent><nav aria-label={intl.formatMessage({ id: "navigation.applications", defaultMessage: "Applications" })} className="shell-navigation__items shell-navigation__items--applications">
    {config.actions.map(action => {
      const { full: title, short } = shellNavigationLabels(action, intl);
      const badge = action.badge === undefined ? null : <small className="shell-navigation__beta">{action.badge}</small>;
      return <Tooltip.Root key={action.id}><Tooltip.Trigger asChild><button type="button"
        data-action-id={action.id} aria-label={title} aria-current={action.active ? "page" : undefined} onClick={() => onInvoke(action.onInvoke)}>
        <LiquidGlassBackdrop /><NavigationIcon name={action.icon} selected={action.active} />
        <span className="shell-navigation__item-label">
          {config.layout === "unified" ? <>
            <span className="shell-navigation__item-label--short">{short}</span>
            <span className="shell-navigation__item-label--full">{title}{badge}</span>
          </> : <>{title}{!compact ? badge : null}</>}
        </span>
      </button></Tooltip.Trigger>{compact ? <Tooltip.Portal><Tooltip.Content className="shell-navigation-tooltip" side="right" sideOffset={8}>{title}</Tooltip.Content></Tooltip.Portal> : null}</Tooltip.Root>;
    })}
    {includeSettings ? <button type="button" aria-current={config.settingsActive ? "page" : undefined} title={compact ? intl.formatMessage({ id: "settings.title", defaultMessage: "Settings" }) : undefined} onClick={() => onInvoke(config.onOpenSettings)}><NavigationIcon name="settings" selected={config.settingsActive} /><span className="shell-navigation__item-label"><FormattedMessage id="settings.title" defaultMessage="Settings" /></span></button> : null}
  </nav></Tooltip.Provider> : <AccountContent compact={compact} config={config} onInvoke={onInvoke} />;
}

function AccountContent({ config, compact, onInvoke }: {
  config: ShellNavigationConfig;
  compact: boolean;
  onInvoke: (action: () => void) => void;
}) {
  const intl = useIntl();
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
        <LogIn size={16} /><span>{account.snapshot.anonymousLabel ?? <FormattedMessage id="account.signIn" defaultMessage="Sign in" />}</span>
      </button>
    </div>;
  }
  return <div className="shell-navigation__items">
    <>
      <button type="button" title={compact ? account.snapshot.name || "Account" : undefined} onClick={() => onInvoke(account.onOpen)}>
        <AccountAvatar account={account} /><span className="shell-navigation__identity">
          <strong>{account.snapshot.name || "OpenCraft"}</strong>
          <small>{account.snapshot.planLabel || "Account Settings"}</small>
        </span>
      </button>
      {account.snapshot.usageRemainingPercent === null ? null : <button type="button" onClick={() => onInvoke(account.onOpen)}>
        <Gauge size={16} /><span><FormattedMessage id="account.usage" defaultMessage="Usage" /></span><small><FormattedMessage id="account.remaining" defaultMessage="{remaining, number, percent} left" values={{ remaining: account.snapshot.usageRemainingPercent / 100 }} /></small>
      </button>}
      <button type="button" onClick={() => onInvoke(account.onOpen)}><User size={16} /><span><FormattedMessage id="account.title" defaultMessage="Account" /></span></button>
    </>
    <button type="button" onClick={() => onInvoke(config.onOpenSettings)}><SettingsGearIcon size={16} /><span><FormattedMessage id="settings.title" defaultMessage="Settings" /></span></button>
    {account.onSignOut ? <button type="button" disabled={signingOut} onClick={async () => {
      setSigningOut(true);
      setError(null);
      try { await account.onSignOut?.(); onInvoke(() => undefined); }
      catch { setError("Could not sign out. Please try again."); }
      finally { setSigningOut(false); }
    }}><LogOut size={16} /><span>{intl.formatMessage(signingOut ? { id: "account.signingOut", defaultMessage: "Signing out…" } : { id: "account.signOut", defaultMessage: "Sign out" })}</span></button> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
