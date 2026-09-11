import { lazy, Suspense, useMemo } from "react";

import type { LightVelaAccountService } from "../account/lightvela-account-service";
import { HermesAgentConsoleHost } from "./hermes-agent-console-host";
import { RepositoryProvider } from "../upstream/mono2/contexts/repository-context";
import { createWorkbenchRepositories } from "../upstream/workbench-repositories";

const TatFileManagerPanel = lazy(async () => {
  const module = await import("../upstream/mono2/components/domain/tat-file-manager-panel");
  return { default: module.TatFileManagerPanel };
});

export function HermesStorageManagementView({ account, botId }: {
  readonly account: LightVelaAccountService;
  readonly botId: string;
}) {
  const repositories = useMemo(() => createWorkbenchRepositories(account), [account]);
  return (
    <RepositoryProvider value={repositories}>
      <HermesAgentConsoleHost>
        <Suspense fallback={<div className="flex min-h-48 items-center justify-center text-sm text-black/45">正在加载...</div>}>
          <TatFileManagerPanel botId={botId} />
        </Suspense>
      </HermesAgentConsoleHost>
    </RepositoryProvider>
  );
}
