import { Suspense, lazy, useMemo, useState, useSyncExternalStore } from "react";
import type { AppServerProfileSkillsService } from "@opencraft/profile-skills-appserver";
import {
  SegmentedControl,
  type PlatformViewHost,
  type PlatformViewRegions,
  type PlatformToolbarSelectOption,
} from "@opencraft/extension-react";

import type { LightVelaAccountService } from "../account/lightvela-account-service";
import { HermesAgentConsoleHost } from "./hermes-agent-console-host";
import { RepositoryProvider } from "../upstream/mono2/contexts/repository-context";
import { createWorkbenchRepositories } from "../upstream/workbench-repositories";
import {
  createCatalogOnlySkillsDataLayer,
  createLocalDshSkillsDataLayer,
  createProfileSkillsDataLayer,
} from "./profile-skills-data-layer";
import { LIGHTVELA_HERMES_HOST_ID } from "./lightvela-hermes-settings-view";
const HermesAgentSkillsPanel = lazy(async () => {
  const module = await import("../upstream/mono2/pages/marketing/agent-skills-panel");
  return { default: module.HermesAgentSkillsPanel };
});

const EMPTY_DIRECTORY = Object.freeze({ entries: Object.freeze([]) });
const subscribeEmpty = (): (() => void) => () => undefined;
const getEmptyDirectory = () => EMPTY_DIRECTORY;

type SkillInstallTarget = {
  readonly id: string;
  readonly kind: "local-dsh" | "hermes-profile";
  readonly hostId: string;
  readonly label: string;
  readonly profileId?: string;
};

export interface HermesProfileDirectory {
  subscribe(listener: () => void): () => void;
  getSnapshot(): {
    readonly entries: readonly {
      readonly hostId: string;
      readonly bot: {
        readonly botId: string;
        readonly name: string;
        readonly status: "available" | "unavailable" | "disabled";
        readonly runtimeProfileId?: string;
      };
    }[];
  };
}

export function HermesSkillsManagementView({
  account,
  botId,
  profileSkills,
  profileDirectory,
  host,
  headerRegion,
  toolbarSelect: ToolbarSelect,
}: {
  readonly account: LightVelaAccountService;
  readonly botId: string;
  readonly profileSkills?: AppServerProfileSkillsService;
  readonly profileDirectory?: HermesProfileDirectory;
  readonly host: PlatformViewHost;
  readonly headerRegion?: PlatformViewRegions["Header"];
  readonly toolbarSelect?: PlatformViewRegions["ToolbarSelect"];
}) {
  const repositories = useMemo(() => createWorkbenchRepositories(account), [account]);
  const directory = useSyncExternalStore(
    profileDirectory?.subscribe ?? subscribeEmpty,
    profileDirectory?.getSnapshot ?? getEmptyDirectory,
    profileDirectory?.getSnapshot ?? getEmptyDirectory,
  );
  const targets = useMemo<readonly SkillInstallTarget[]>(() => {
    const local = host.profiles
      .filter((profile) => profile.hostKind === "local" && profile.enabled)
      .map((profile): SkillInstallTarget => ({
        id: `local-dsh:${profile.hostId}`,
        kind: "local-dsh",
        hostId: profile.hostId,
        label: "本机 DSH",
      }));
    const hermes = directory.entries
      .filter((entry) => entry.hostId === LIGHTVELA_HERMES_HOST_ID
        && entry.bot.status === "available"
        && entry.bot.runtimeProfileId !== undefined)
      .map((entry): SkillInstallTarget => ({
        id: `hermes-profile:${entry.hostId}:${entry.bot.runtimeProfileId}`,
        kind: "hermes-profile",
        hostId: entry.hostId,
        profileId: entry.bot.runtimeProfileId,
        label: `Hermes · ${entry.bot.runtimeProfileId}`,
      }));
    return [...local, ...hermes];
  }, [directory.entries, host.profiles]);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const selectedTarget = targets.find((target) => target.id === selectedTargetId) ?? targets[0] ?? null;
  const skillsDataLayer = useMemo(() => {
    if (profileSkills === undefined || selectedTarget === null) return createCatalogOnlySkillsDataLayer();
    if (selectedTarget.kind === "local-dsh") {
      return createLocalDshSkillsDataLayer(profileSkills, {
        hostId: selectedTarget.hostId,
        scope: { type: "local-dsh", root: "user" },
      }, host.ensureRuntimeReady === undefined ? undefined : {
        ensureReady: host.ensureRuntimeReady,
      });
    }
    return createProfileSkillsDataLayer(profileSkills, {
      hostId: selectedTarget.hostId,
      profileId: selectedTarget.profileId!,
    }, host.ensureRuntimeReady === undefined ? undefined : {
      ensureReady: host.ensureRuntimeReady,
    });
  }, [host.ensureRuntimeReady, profileSkills, selectedTarget]);
  const targetOptions = useMemo<readonly PlatformToolbarSelectOption[]>(() => targets.map((target) => ({
    value: target.id,
    label: target.label,
    textValue: target.label,
    visual: target.kind === "local-dsh" ? "local" : "remote",
  })), [targets]);
  const installTargetSelector = ToolbarSelect === undefined ? undefined : (
    <ToolbarSelect
      value={selectedTarget?.id ?? null}
      options={targetOptions}
      onValueChange={setSelectedTargetId}
      label="选择技能安装位置"
      title="Host"
      placeholder="暂无可用安装位置"
      disabled={targets.length === 0}
    />
  );

  return (
    <RepositoryProvider value={repositories}>
      <HermesAgentConsoleHost>
        <Suspense fallback={<div className="flex min-h-48 items-center justify-center text-sm text-black/45">正在加载...</div>}>
          <HermesAgentSkillsPanel
            key={selectedTarget?.id ?? "catalog-only"}
            botId={botId}
            profileId={selectedTarget?.kind === "hermes-profile" ? selectedTarget.profileId : undefined}
            execDebugCommand={account.execDebugCommand.bind(account)}
            headerEnd={installTargetSelector}
            headerRegion={headerRegion}
            renderHeaderNavigation={(navigation) => (
              <SegmentedControl
                value={navigation.value}
                options={navigation.options}
                onValueChange={navigation.onValueChange}
                label={navigation.label}
                disabled={navigation.disabled}
              />
            )}
            skillsDataLayer={skillsDataLayer}
            showHeader={false}
          />
        </Suspense>
      </HermesAgentConsoleHost>
    </RepositoryProvider>
  );
}
