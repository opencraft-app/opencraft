import { ArrowUpRight, Copy, LogOut, Pencil, RefreshCw, Upload } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  SettingsAvatarEditor, SettingsButton, SettingsCopyButton, SettingsEditableText,
  SettingsGroup, SettingsIconButton, SettingsNotice, SettingsPanel, SettingsRow, SettingsUsageMeter,
  type ExtensionSettingsViewProps,
} from "@opencraft/extension-react";
import type { LightVelaAccountService } from "./lightvela-account-service";
import { LightVelaLoginOptions } from "../settings/lightvela-login-options";

function formatDate(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
}
function daysRemaining(value: string | null): number | null {
  return value && Number.isFinite(Date.parse(value)) ? Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 86_400_000)) : null;
}

/** Account business supplies values and actions to the shared utility-window controls. */
export function createLightVelaAccountView(account: LightVelaAccountService) {
  return function LightVelaAccountView({ host }: ExtensionSettingsViewProps) {
    const snapshot = useSyncExternalStore(account.subscribe, account.getSnapshot, account.getSnapshot);
    const details = snapshot.details;
    const [avatarError, setAvatarError] = useState<string | null>(null);
    const [signOutError, setSignOutError] = useState<string | null>(null);
    const [signingOut, setSigningOut] = useState(false);
    const billingReturn = useRef(false);
    const lastRefresh = useRef(0);
    const refresh = () => {
      lastRefresh.current = Date.now();
      void account.refreshAccountDetails().catch(() => undefined);
    };
    useEffect(() => {
      if (account.hasStoredSession()) refresh();
      const onFocus = () => {
        if (!account.hasStoredSession() || document.visibilityState !== "visible") return;
        if (billingReturn.current || Date.now() - lastRefresh.current >= 30_000) {
          billingReturn.current = false; refresh();
        }
      };
      window.addEventListener("focus", onFocus);
      document.addEventListener("visibilitychange", onFocus);
      return () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
    }, []);

    const pass = details.pass;
    const total = pass?.creditsTotal ?? 0;
    const used = pass === null ? 0 : Math.max(0, total - pass.creditsAvailable);
    const exhausted = total > 0 && used >= total;
    const warning = total > 0 && used / total >= .8;
    const expiresAt = pass?.expiresAt ?? details.subscription?.currentPeriodEnd ?? null;
    const remaining = daysRemaining(expiresAt);
    const planLabel = pass?.bundleName || details.subscription?.code || "No subscription";
    const name = details.profile?.pendingName || details.profile?.name || (details.phase === "error" ? "Account unavailable" : "Loading account…");
    const initialLoading = details.profile === null && (details.phase === "loading" || details.phase === "idle");
    const anonymous = snapshot.session.status === "anonymous";

    const uploadAvatar = async (file: File) => {
      const processed = await host.prepareImageUpload?.(file) ?? file;
      await account.uploadProfileAvatar(processed === file ? file : new File([processed], file.name, {
        type: processed.type || file.type, lastModified: file.lastModified,
      }));
    };

    return <SettingsPanel title={anonymous ? "Sign in" : "Account"}
      actions={anonymous ? undefined : <SettingsIconButton label={details.phase === "loading" ? "Refreshing account" : "Refresh account"}
        disabled={details.phase === "loading"} onClick={refresh}><RefreshCw size={16} /></SettingsIconButton>}
      footer={anonymous ? undefined : <>
        <SettingsButton type="button" variant="quiet" disabled={signingOut} onClick={() => {
          setSigningOut(true); setSignOutError(null);
          void account.signOut().catch(error => setSignOutError(error instanceof Error ? error.message : "Could not sign out."))
            .finally(() => setSigningOut(false));
        }}><LogOut size={14} aria-hidden="true" />{signingOut ? "Signing out…" : "Sign out"}</SettingsButton>
        {signOutError ? <SettingsNotice tone="error">{signOutError}</SettingsNotice> : null}
      </>}>
      {anonymous ? <LightVelaLoginOptions account={account} snapshot={snapshot} authentication={host.authentication} reason="account-settings" /> : <>
        {details.error ? <SettingsNotice tone="error">{details.error}</SettingsNotice> : null}
        <section className="account-profile" aria-label="Profile" aria-busy={initialLoading}>
          <SettingsAvatarEditor src={details.profile?.avatarUrl ?? null} name={name} icon={<Upload size={12} />}
            disabled={details.profile === null} onUpload={uploadAvatar} onError={setAvatarError} />
          <div className="account-profile__copy">
            {initialLoading ? <span className="settings-skeleton" aria-label="Loading account" /> : <SettingsEditableText
              label="Display name" value={name} icon={<Pencil size={14} />} disabled={details.profile === null}
              onSave={async value => { await account.updateProfileName(value); }} />}
            <span className="account-profile__metadata">{snapshot.region === "cn" ? "China account" : "International account"}
              {details.profile?.nameAuditStatus === "pending" ? " · Name pending review" : ""}</span>
            {details.profile ? <SettingsCopyButton label="Copy account ID" value={details.profile.id} icon={<Copy size={12} />} />
              : initialLoading ? <span className="settings-skeleton settings-skeleton--action" aria-hidden="true" /> : null}
          </div>
          {avatarError ? <div className="account-profile__error"><SettingsNotice tone="error">{avatarError}</SettingsNotice></div> : null}
        </section>
        <SettingsGroup appearance="plain" aria-label="Subscription">
          <SettingsRow label="Subscription" controlWidth="wide">
            <div className="account-value-action">
              {initialLoading ? <span className="settings-skeleton" /> : <span>{planLabel}</span>}
              <SettingsButton type="button" disabled={initialLoading} onClick={() => {
                billingReturn.current = true;
                window.open(`https://${snapshot.region === "cn" ? "lightvela.com" : "lightvela.ai"}/account?tab=billing#renew`, "_blank", "noopener,noreferrer");
              }}>Manage subscription<ArrowUpRight size={14} aria-hidden="true" /></SettingsButton>
            </div>
          </SettingsRow>
          <SettingsRow label="Valid until" controlWidth="wide">
            <span className="account-secondary-value">{initialLoading ? "Loading…" : formatDate(expiresAt)}
              {!initialLoading && remaining !== null ? ` · ${remaining === 0 ? "Expired" : `${remaining} days left`}` : ""}</span>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup appearance="plain" aria-label="Model credits">
          <SettingsRow label="Model credits" controlWidth="wide">
            <div className="account-value-action">
              <span className="account-numeric-value">{initialLoading ? "Loading…" : total > 0 ? `${used.toLocaleString()} / ${total.toLocaleString()}` : "No included credits"}</span>
              {exhausted ? <span className="settings-status" data-tone="warning">Exhausted</span> : warning ? <span className="settings-status" data-tone="warning">Running low</span> : null}
            </div>
          </SettingsRow>
          {initialLoading ? <div className="account-usage" aria-busy="true">
            <SettingsUsageMeter label="Loading model credits" value={0} maximum={1} />
            <div className="account-value-action account-usage__hint"><span className="settings-skeleton settings-skeleton--action" aria-hidden="true" /></div>
          </div> : total > 0 ? <div className="account-usage">
            <SettingsUsageMeter label="Model credits used" value={used} maximum={total} tone={warning ? "warning" : "neutral"} />
            {warning ? <div className="account-value-action account-usage__hint">
              <span>{exhausted ? "Credits exhausted. Use your own model to continue." : "Credits are running low."}</span>
              <SettingsButton type="button" onClick={() => host.openSettings ? host.openSettings("lightvela.hermes.models") : host.openView("lightvela.hermes.models-view")}>Configure model</SettingsButton>
            </div> : null}
          </div> : null}
        </SettingsGroup>
      </>}
    </SettingsPanel>;
  };
}
