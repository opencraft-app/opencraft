import { Suspense, lazy, useMemo } from "react";
import type { AppServerProfileSkillsService } from "@opencraft/profile-skills-appserver";

import type { LightVelaAccountService } from "../account/lightvela-account-service";
import { HermesAgentConsoleHost } from "./hermes-agent-console-host";
import { RepositoryProvider } from "../upstream/mono2/contexts/repository-context";
import { createWorkbenchRepositories } from "../upstream/workbench-repositories";
import { createProfileSkillsDataLayer } from "./profile-skills-data-layer";
import { LIGHTVELA_HERMES_HOST_ID } from "./lightvela-hermes-settings-view";

const HermesAgentSkillsPanel = lazy(async () => {
  const module = await import("../upstream/mono2/pages/marketing/agent-skills-panel");
  return { default: module.HermesAgentSkillsPanel };
});

export function HermesSkillsManagementView({ account, botId, profileSkills }: {
  readonly account: LightVelaAccountService;
  readonly botId: string;
  readonly profileSkills?: AppServerProfileSkillsService;
}) {
  const repositories = useMemo(() => createWorkbenchRepositories(account), [account]);
  const skillsDataLayer = useMemo(() => profileSkills === undefined
    ? undefined
    : createProfileSkillsDataLayer(profileSkills, { hostId: LIGHTVELA_HERMES_HOST_ID, profileId: "default" }),
  [profileSkills]);
  if (skillsDataLayer === undefined) {
    return <div className="p-6 text-sm text-black/50">Profile Skills protocol is unavailable for this Host.</div>;
  }
  return (
    <RepositoryProvider value={repositories}>
      <HermesAgentConsoleHost>
        <Suspense fallback={<div className="flex min-h-48 items-center justify-center text-sm text-black/45">正在加载...</div>}>
          <HermesAgentSkillsPanel
            botId={botId}
            execDebugCommand={account.execDebugCommand.bind(account)}
            skillsDataLayer={skillsDataLayer}
          />
        </Suspense>
      </HermesAgentConsoleHost>
    </RepositoryProvider>
  );
}
