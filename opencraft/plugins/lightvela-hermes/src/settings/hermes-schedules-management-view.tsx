import { Suspense, lazy } from "react";

import type { LightVelaAccountService } from "../account/lightvela-account-service";
import { HermesAgentConsoleHost } from "./hermes-agent-console-host";

const HermesAgentAutomationsPanel = lazy(async () => {
  const module = await import("../upstream/mono2/pages/marketing/agent-automations-panel");
  return { default: module.HermesAgentAutomationsPanel };
});

export function HermesSchedulesManagementView({ botId }: {
  readonly account: LightVelaAccountService;
  readonly botId: string;
}) {
  return (
    <HermesAgentConsoleHost>
      <Suspense fallback={<div className="flex min-h-64 items-center justify-center text-sm text-black/45">正在加载定时任务...</div>}>
        <HermesAgentAutomationsPanel botId={botId} />
      </Suspense>
    </HermesAgentConsoleHost>
  );
}
