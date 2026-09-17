import {
  Activity,
  Brain,
  CalendarClock,
  Cloud,
  Cpu,
  MessageCircle,
  ServerCog,
  Sparkles,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import {
  SettingsGroup,
  SettingsButton,
  SettingsListItem,
  SettingsNotice,
  SettingsPageHeader,
  SettingsSection,
  type ExtensionSettingsViewProps,
} from "@opencraft/extension-react";

import type { LightVelaAccountService } from "../account/lightvela-account-service";
import type { AppServerProfileSkillsService } from "@opencraft/profile-skills-appserver";
import { HermesChannelsManagementView } from "./hermes-channels-management-view";
import { HermesDiagnosticsManagementView } from "./hermes-diagnostics-management-view";
import { HermesMemoryManagementView } from "./hermes-memory-management-view";
import { HermesModelsManagementView } from "./hermes-models-management-view";
import { HermesSchedulesManagementView } from "./hermes-schedules-management-view";
import {
  HermesSkillsManagementView,
  type HermesProfileDirectory,
} from "./hermes-skills-management-view";
import { HermesStorageManagementView } from "./hermes-storage-management-view";
import { LightVelaLoginOptions } from "./lightvela-login-options";

export type LightVelaHermesManagementPage =
  | "channels"
  | "models"
  | "skills"
  | "memory"
  | "schedules"
  | "runtime"
  | "storage"
  | "diagnostics";

const PAGE_COPY: Record<LightVelaHermesManagementPage, {
  readonly title: string;
  readonly description: string;
  readonly sectionTitle: string;
}> = {
  channels: {
    title: "Channels",
    description: "Connect the selected Hermes Agent to the places where it works.",
    sectionTitle: "Agent channels",
  },
  models: {
    title: "Models",
    description: "Configure the primary model, fallback chain, providers, and credentials for this Agent.",
    sectionTitle: "Model configuration",
  },
  skills: {
    title: "Skills",
    description: "Manage the reusable capabilities available to this Agent.",
    sectionTitle: "Installed skills",
  },
  memory: {
    title: "Soul & Memory",
    description: "Shape this Agent's identity and the durable context it retains.",
    sectionTitle: "Agent identity",
  },
  schedules: {
    title: "Scheduled tasks",
    description: "Create and inspect recurring work owned by this Agent.",
    sectionTitle: "Schedules",
  },
  runtime: {
    title: "Runtime & connection",
    description: "Inspect the Host transport and the Agent deployment bound to it.",
    sectionTitle: "Host runtime",
  },
  storage: {
    title: "Cloud Storage",
    description: "Manage files and persistent storage attached to this Hermes Host.",
    sectionTitle: "Storage",
  },
  diagnostics: {
    title: "Diagnostics",
    description: "Inspect control-plane health and runtime capabilities for this deployment.",
    sectionTitle: "Health",
  },
};

function pageIcon(page: LightVelaHermesManagementPage) {
  const Icon = page === "channels" ? MessageCircle
    : page === "models" ? Brain
      : page === "skills" ? Sparkles
        : page === "memory" ? Cpu
          : page === "schedules" ? CalendarClock
            : page === "storage" ? Cloud
              : page === "diagnostics" ? Activity
                : ServerCog;
  return <Icon size={16} />;
}

/**
 * One route entry per Agent/Host responsibility. The Workbench owns this
 * page's navigation and viewport; LightVela remains the source of truth.
 */
export function createLightVelaHermesManagementView(
  account: LightVelaAccountService,
  page: LightVelaHermesManagementPage,
  profileSkills?: AppServerProfileSkillsService,
  profileDirectory?: HermesProfileDirectory,
) {
  const copy = PAGE_COPY[page];
  if (page === "skills") {
    return function HermesProfileSkillsManagementView(props: ExtensionSettingsViewProps) {
      const snapshot = useSyncExternalStore(account.subscribe, account.getSnapshot, account.getSnapshot);
      const activeBot = snapshot.bots.find((bot) => bot.instanceId === snapshot.activeBotId) ?? null;

      return (
        <div className="lightvela-management-page">
          <div className="lightvela-management-page__content">
            {snapshot.phase === "loading" ? <SettingsNotice>Loading the Hermes control plane…</SettingsNotice> : null}
            {snapshot.error !== null ? <SettingsNotice tone="error">{snapshot.error}</SettingsNotice> : null}
            <HermesSkillsManagementView
              account={account}
              botId={activeBot?.instanceId ?? ""}
              profileSkills={profileSkills}
              profileDirectory={profileDirectory}
              host={props.host}
              headerRegion={props.regions?.Header}
              toolbarSelect={props.regions?.ToolbarSelect}
            />
          </div>
        </div>
      );
    };
  }
  if (page === "storage") {
    return function HermesStorageSettingsView(props: ExtensionSettingsViewProps) {
      const snapshot = useSyncExternalStore(account.subscribe, account.getSnapshot, account.getSnapshot);
      const activeBot = snapshot.bots.find((bot) => bot.instanceId === snapshot.activeBotId) ?? null;

      useEffect(() => {
        account.bootstrapOAuthFragment();
        if (account.hasStoredSession() && snapshot.session.status === "anonymous") {
          void account.refreshBots().catch(() => undefined);
        }
      }, []);

      return (
        <div className="lightvela-management-page">
          <SettingsPageHeader title={copy.title} />
          <div className="lightvela-management-page__content">
            {snapshot.phase === "loading" ? <SettingsNotice>Loading the Hermes control plane…</SettingsNotice> : null}
            {snapshot.error !== null ? <SettingsNotice tone="error">{snapshot.error}</SettingsNotice> : null}
            {snapshot.session.status !== "authenticated" ? (
              <SettingsSection
                title="Connect LightVela"
                description="Sign in to browse files stored on your LightVela environment."
              >
                <SettingsGroup>
                  <div className="lightvela-management-page__sign-in">
                    <LightVelaLoginOptions
                      account={account}
                      snapshot={snapshot}
                      authentication={props.host.authentication}
                      reason="account-entry"
                    />
                  </div>
                </SettingsGroup>
              </SettingsSection>
            ) : activeBot === null ? (
              <SettingsNotice>Select a running Bot from Overview first.</SettingsNotice>
            ) : (
              <HermesStorageManagementView account={account} botId={activeBot.instanceId} />
            )}
          </div>
        </div>
      );
    };
  }
  return function LightVelaHermesManagementView(_props: ExtensionSettingsViewProps) {
    const snapshot = useSyncExternalStore(account.subscribe, account.getSnapshot, account.getSnapshot);
    const activeBot = snapshot.bots.find((bot) => bot.instanceId === snapshot.activeBotId) ?? null;

    useEffect(() => {
      account.bootstrapOAuthFragment();
      if (account.hasStoredSession() && snapshot.phase === "anonymous") {
        void account.refreshBots().catch(() => undefined);
      }
    }, []);

    const isAgentConsolePage = page === "channels"
      || page === "models"
      || page === "memory"
      || page === "schedules"
      || page === "diagnostics";

    return (
      <>
        {!isAgentConsolePage ? <SettingsPageHeader title={copy.title} description={copy.description} /> : null}
        {snapshot.phase === "loading" ? <SettingsNotice>Loading the Hermes control plane…</SettingsNotice> : null}
        {snapshot.error !== null ? <SettingsNotice tone="error">{snapshot.error}</SettingsNotice> : null}
        {snapshot.phase !== "authenticated" ? (
          <SettingsNotice>Sign in from Overview before managing this Agent.</SettingsNotice>
        ) : activeBot === null ? (
          <SettingsNotice>Select a running Bot from Overview first.</SettingsNotice>
        ) : (
          <>
            {!isAgentConsolePage ? (
              <SettingsSection title="Agent deployment" description="The selected Agent is the authority for this page; velahermes0 is only its current execution Host.">
                <SettingsGroup>
                  <SettingsListItem icon={pageIcon(page)} label={activeBot.name} description={activeBot.instanceId} metadata={`via velahermes0 · ${activeBot.status}`} />
                </SettingsGroup>
              </SettingsSection>
            ) : null}
            {page === "channels" ? (
              <HermesChannelsManagementView account={account} botId={activeBot.instanceId} />
            ) : page === "models" ? (
              <HermesModelsManagementView account={account} botId={activeBot.instanceId} />
            ) : page === "memory" ? (
              <HermesMemoryManagementView account={account} botId={activeBot.instanceId} />
            ) : page === "schedules" ? (
              <HermesSchedulesManagementView account={account} botId={activeBot.instanceId} />
            ) : page === "diagnostics" ? (
              <HermesDiagnosticsManagementView
                account={account}
                botId={activeBot.instanceId}
                botName={activeBot.name}
                botStatus={activeBot.status}
              />
            ) : page === "runtime" ? (
              <SettingsSection title={copy.sectionTitle} icon={pageIcon(page)}><HermesCommandPanel account={account} botId={activeBot.instanceId} command="hermes --version" actionLabel="Inspect runtime" /></SettingsSection>
            ) : null}
          </>
        )}
      </>
    );
  };
}

function HermesCommandPanel({
  account,
  botId,
  command,
  actionLabel,
}: {
  readonly account: LightVelaAccountService;
  readonly botId: string;
  readonly command: string;
  readonly actionLabel: string;
}) {
  const [pending, setPending] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = () => {
    if (pending) return;
    setPending(true);
    setError(null);
    void account.execDebugCommand(botId, command, { timeoutMs: 120_000 })
      .then((result) => {
        const normalized = result.output.trim() || result.status || "No output";
        setOutput(normalized.length > 8_000 ? `${normalized.slice(0, 8_000)}\n…` : normalized);
        if (result.exitCode !== 0) setError(`Hermes exited with code ${result.exitCode}.`);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(false));
  };
  return (
    <div className="lightvela-management-command">
      <SettingsButton type="button" disabled={pending} onClick={run}>
        {pending ? "Loading…" : actionLabel}
      </SettingsButton>
      {error !== null ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
      {output !== null ? <pre>{output}</pre> : null}
    </div>
  );
}
