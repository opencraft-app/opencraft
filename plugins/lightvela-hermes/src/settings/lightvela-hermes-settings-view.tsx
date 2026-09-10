import { Bot, RefreshCw } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import {
  SettingsButton,
  SettingsGroup,
  SettingsListItem,
  SettingsNotice,
  SettingsPageHeader,
  SettingsSection,
  type ExtensionSettingsViewProps,
} from "@opencraft/extension-react";

import type { LightVelaAccountService } from "../account/lightvela-account-service";
import { LIGHTVELA_HERMES_HOST_ID } from "../host/lightvela-hermes-host-identity";

export { LIGHTVELA_HERMES_HOST_ID };

export function createLightVelaHermesSettingsView(account: LightVelaAccountService) {
  return function LightVelaHermesSettingsView({ host }: ExtensionSettingsViewProps) {
    const accountSnapshot = useSyncExternalStore(account.subscribe, account.getSnapshot, account.getSnapshot);
    const [pendingBotId, setPendingBotId] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const installed = host.profiles.find((profile) => profile.hostId === LIGHTVELA_HERMES_HOST_ID) ?? null;

    useEffect(() => {
      if (account.hasStoredSession()) void account.refreshBots().catch(() => undefined);
    }, []);

    const attach = async (botId: string) => {
      if (pendingBotId !== null || accountSnapshot.activeBotId === botId) return;
      setPendingBotId(botId);
      setActionError(null);
      try {
        account.selectBot(botId);
        if (installed === null) {
          await host.provisionHost({
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
          });
        }
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setPendingBotId(null);
      }
    };

    return (
      <>
        <SettingsPageHeader title="Overview" description="Manage the selected Hermes Agent and its current Host deployment." />

        {accountSnapshot.phase === "authenticated" ? (
          <SettingsSection
            title="Agent deployment"
            description={<>Bind the selected Hermes Agent to the stable Host <code>{LIGHTVELA_HERMES_HOST_ID}</code>.</>}
            action={(
              <SettingsButton
                type="button"
                onClick={() => void account.refreshBots().catch(() => undefined)}
              >
                <RefreshCw size={14} /> Refresh
              </SettingsButton>
            )}
          >
            <SettingsGroup>
              {accountSnapshot.bots.map((bot) => {
                const selected = accountSnapshot.activeBotId === bot.instanceId;
                return (
                  <SettingsListItem
                    key={bot.instanceId}
                    icon={<Bot size={16} />}
                    label={bot.name}
                    description={bot.instanceId}
                    metadata={selected ? "velahermes0 · Installed" : "Hermes over Tencent TAT"}
                    actions={<SettingsButton
                      type="button"
                      disabled={pendingBotId !== null || selected}
                      onClick={() => void attach(bot.instanceId)}
                    >
                      {pendingBotId === bot.instanceId ? "Adding…" : selected ? "Installed" : "Use Host"}
                    </SettingsButton>}
                  />
                );
              })}
            </SettingsGroup>
            {actionError !== null ? <SettingsNotice tone="error">{actionError}</SettingsNotice> : null}
          </SettingsSection>
        ) : null}
      </>
    );
  };
}
