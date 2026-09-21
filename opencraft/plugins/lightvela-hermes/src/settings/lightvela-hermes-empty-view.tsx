import { Bot, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { ExtensionSettingsViewProps } from "@opencraft/extension-react";

import type { LightVelaAccountService } from "../account/lightvela-account-service";
import { projectLightVelaBotOnboarding } from "../onboarding";
import { LIGHTVELA_HERMES_HOST_ID } from "./lightvela-hermes-settings-view";
import { LightVelaLoginOptions } from "./lightvela-login-options";

/**
 * Intervention for an explicitly selected LightVela Host. Account state alone
 * never mounts this view or owns the application's workspace entrance.
 */
export function createLightVelaHermesEmptyView(account: LightVelaAccountService) {
  return function LightVelaHermesEmptyView({ host }: ExtensionSettingsViewProps) {
    const snapshot = useSyncExternalStore(account.subscribe, account.getSnapshot, account.getSnapshot);
    const started = useRef(false);
    const provisioning = useRef(false);
    const [provisionError, setProvisionError] = useState<string | null>(null);
    const installed = host.profiles.some((profile) => profile.hostId === LIGHTVELA_HERMES_HOST_ID);

    useEffect(() => {
      if (started.current) return;
      started.current = true;
      if (!account.hasStoredSession()) {
        return;
      }
      void account.refreshBots().catch(() => undefined);
    }, []);

    useEffect(() => {
      const bot = snapshot.bots[0];
      if (snapshot.phase !== "authenticated" || bot === undefined || installed || provisioning.current) return;
      provisioning.current = true;
      setProvisionError(null);
      void host.provisionHost({
        hostId: LIGHTVELA_HERMES_HOST_ID,
        displayName: "My Hermes",
        providerId: "lightvela.hermes",
        providerConfig: {},
        hostKind: "remote-control",
        autoConnect: false,
        includeInSidebar: true,
        credentialRef: "lightvela.browser-session",
        transportEndpoint: "LightVela",
        executionLocation: "LightVela",
        workspaceBrowseRoots: [],
      }).catch((error) => {
        provisioning.current = false;
        setProvisionError(error instanceof Error ? error.message : String(error));
      });
    }, [host, installed, snapshot]);

    const error = provisionError ?? (snapshot.phase === "anonymous" ? null : snapshot.error);
    const onboarding = projectLightVelaBotOnboarding({
      region: snapshot.region,
      phase: snapshot.phase,
      botCount: snapshot.bots.length,
      error,
    });
    const waiting = onboarding.kind === "loading"
      || (onboarding.kind === "ready" && !installed && error === null);

    if (onboarding.kind === "bot-required") {
      return (
        <section className="hostless-empty-view">
          <h1>当前环境不可用</h1>
          <p>此账号暂无可连接的云端实例。你可以选择本机或其他已有环境。</p>
          <div className="hostless-empty-view__actions">
            {host.openSettings ? <button type="button" onClick={() => host.openSettings?.("connections")}>选择运行环境</button> : null}
          </div>
        </section>
      );
    }

    return (
      <section className="hostless-empty-view" aria-live="polite">
        <span className="hostless-empty-view__icon" aria-hidden="true"><Bot size={20} /></span>
        <h1>{waiting ? "Connecting to LightVela" : "LightVela"}</h1>
        <p>
          {waiting
            ? "Restoring your Hermes workspace…"
            : onboarding.kind === "error"
              ? onboarding.error
              : error ?? (onboarding.kind === "ready"
                ? "Your Hermes Bot is ready. Reconnecting…"
                : "Sign in to continue to your Hermes workspace.")}
        </p>
        {!waiting ? (
          <div className="hostless-empty-view__actions">
            {onboarding.kind === "error" || onboarding.kind === "ready" ? (
              <button type="button" onClick={() => void account.refreshBots().catch(() => undefined)}>
                <RefreshCw size={15} /> Refresh
              </button>
            ) : (
              <LightVelaLoginOptions account={account} snapshot={snapshot} authentication={host.authentication} />
            )}
          </div>
        ) : <i className="hostless-empty-view__spinner" aria-hidden="true" />}
      </section>
    );
  };
}
