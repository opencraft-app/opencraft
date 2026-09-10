import {
  Check,
  Copy,
  CreditCard,
  LogOut,
  Pencil,
  RefreshCw,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  SettingsButton,
  SettingsNotice,
  SettingsTextInput,
  type ExtensionSettingsViewProps,
} from "@opencraft/extension-react";

import type { LightVelaAccountService } from "./lightvela-account-service";

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function daysRemaining(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 86_400_000));
}

function publicAccountUrl(region: "cn" | "intl", suffix = ""): string {
  return `${region === "cn" ? "https://lightvela.com" : "https://lightvela.ai"}/account${suffix}`;
}

/** Product account content; the Workbench owns only the surrounding modal. */
export function createLightVelaAccountView(account: LightVelaAccountService) {
  return function LightVelaAccountView({ host }: ExtensionSettingsViewProps) {
    const snapshot = useSyncExternalStore(account.subscribe, account.getSnapshot, account.getSnapshot);
    const details = snapshot.details;
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState("");
    const [saving, setSaving] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [copied, setCopied] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const fileInput = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
      if (account.hasStoredSession()) void account.refreshAccountDetails().catch(() => undefined);
    }, []);

    useEffect(() => {
      if (!editing) setName(details.profile?.pendingName || details.profile?.name || "");
    }, [details.profile, editing]);

    const pass = details.pass;
    const total = pass?.creditsTotal ?? 0;
    const used = pass === null ? 0 : Math.max(0, pass.creditsTotal - pass.creditsAvailable);
    const usedPercent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
    const remainingDays = daysRemaining(pass?.expiresAt ?? details.subscription?.currentPeriodEnd ?? null);
    const planLabel = pass?.bundleName || details.subscription?.code || "No subscription";
    const initial = useMemo(() => (details.profile?.name.trim()[0] || "L").toLocaleUpperCase(), [details.profile?.name]);

    const saveName = async () => {
      if (saving || !name.trim()) return;
      setSaving(true);
      setActionError(null);
      try {
        await account.updateProfileName(name);
        setEditing(false);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setSaving(false);
      }
    };

    const uploadAvatar = async (file: File | undefined) => {
      if (!file || uploading) return;
      setUploading(true);
      setActionError(null);
      try {
        const processed = await host.prepareImageUpload?.(file) ?? file;
        const upload = processed === file
          ? file
          : new File([processed], file.name, {
              type: processed.type || file.type,
              lastModified: file.lastModified,
            });
        await account.uploadProfileAvatar(upload);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setUploading(false);
        if (fileInput.current) fileInput.current.value = "";
      }
    };

    if (snapshot.phase === "anonymous" && !account.hasStoredSession()) {
      return (
        <div className="account-center account-center--empty">
          <h2>Account Settings</h2>
          <p>Sign in to LightVela to view your profile and subscription.</p>
        </div>
      );
    }

    return (
      <div className="account-center">
        <header className="account-center__header">
          <div>
            <h2>Account Settings</h2>
            <p>Your LightVela profile, subscription and model-credit usage.</p>
          </div>
          <SettingsButton
            type="button"
            variant="ghost"
            disabled={details.phase === "loading"}
            onClick={() => void account.refreshAccountDetails().catch(() => undefined)}
          >
            <RefreshCw size={14} className={details.phase === "loading" ? "is-spinning" : undefined} />
            Refresh
          </SettingsButton>
        </header>

        {details.error ? <SettingsNotice tone="error">{details.error}</SettingsNotice> : null}
        {actionError ? <SettingsNotice tone="error">{actionError}</SettingsNotice> : null}

        <section className="account-center__card account-center__profile-card">
          <button
            type="button"
            className="account-center__avatar"
            aria-label="Change avatar"
            disabled={uploading || details.profile === null}
            onClick={() => fileInput.current?.click()}
          >
            {details.profile?.avatarUrl
              ? <img src={details.profile.avatarUrl} alt="" />
              : <span>{initial}</span>}
            <i aria-hidden="true"><Upload size={13} /></i>
          </button>
          <input
            ref={fileInput}
            hidden
            type="file"
            accept="image/png,image/jpeg"
            onChange={(event) => void uploadAvatar(event.currentTarget.files?.[0])}
          />
          <div className="account-center__identity">
            {editing ? (
              <form onSubmit={(event) => { event.preventDefault(); void saveName(); }}>
                <SettingsTextInput
                  autoFocus
                  value={name}
                  maxLength={80}
                  aria-label="Display name"
                  onChange={(event) => setName(event.currentTarget.value)}
                />
                <SettingsButton type="submit" variant="primary" disabled={saving || !name.trim()}>
                  <Check size={14} /> {saving ? "Saving…" : "Save"}
                </SettingsButton>
                <SettingsButton type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</SettingsButton>
              </form>
            ) : (
              <div className="account-center__name">
                <strong>{details.profile?.pendingName || details.profile?.name || "Loading account…"}</strong>
                <button type="button" aria-label="Edit display name" disabled={details.profile === null} onClick={() => setEditing(true)}>
                  <Pencil size={14} />
                </button>
                {details.profile?.nameAuditStatus === "pending" ? <small>Pending review</small> : null}
              </div>
            )}
            {details.profile ? (
              <button
                className="account-center__user-id"
                type="button"
                title="Copy account ID"
                onClick={() => void navigator.clipboard.writeText(details.profile!.id).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1_500);
                }).catch(() => undefined)}
              >
                <span>id: {details.profile.id}</span>{copied ? <Check size={13} /> : <Copy size={13} />}
              </button>
            ) : null}
          </div>
          <SettingsButton
            type="button"
            variant="secondary"
            onClick={() => void account.signOut().catch((error) => setActionError(error instanceof Error ? error.message : String(error)))}
          >
            <LogOut size={14} /> Sign out
          </SettingsButton>
        </section>

        <section className="account-center__card account-center__subscription">
          <header>
            <h3>Subscription plans</h3>
            <SettingsButton
              type="button"
              variant="primary"
              onClick={() => window.open(publicAccountUrl(snapshot.region, "?tab=billing#renew"), "_blank", "noopener,noreferrer")}
            >
              <CreditCard size={14} /> Renew now
            </SettingsButton>
          </header>
          <dl>
            <div>
              <dt>{planLabel}</dt>
              <dd><span className="account-center__badge">Current plan</span></dd>
            </div>
            <div>
              <dt>Subscription period</dt>
              <dd>
                {formatDate(pass?.createdAt ?? details.subscription?.currentPeriodStart ?? null)}
                {" — "}
                {formatDate(pass?.expiresAt ?? details.subscription?.currentPeriodEnd ?? null)}
                {remainingDays === null ? null : <span className="account-center__badge account-center__badge--success">{remainingDays} days left</span>}
              </dd>
            </div>
            {total > 0 ? (
              <div className="account-center__credits">
                <dt>Credits used</dt>
                <dd><strong>{used.toLocaleString()}</strong> / {total.toLocaleString()} <span>{usedPercent}%</span></dd>
                <div className="account-center__progress" aria-label={`${usedPercent}% of model credits used`}>
                  <i style={{ width: `${usedPercent}%` }} data-level={usedPercent > 95 ? "danger" : usedPercent >= 80 ? "warning" : "normal"} />
                </div>
                {usedPercent > 95 ? (
                  <p>
                    Model credits {usedPercent >= 100 ? "have been exhausted" : "are almost exhausted"}.{" "}
                    <a href="/settings/lightvela.hermes.models">Configure model now</a>
                  </p>
                ) : null}
              </div>
            ) : null}
          </dl>
        </section>
      </div>
    );
  };
}
