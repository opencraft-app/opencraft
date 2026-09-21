import { Suspense, lazy, useMemo } from "react";

import type { LightVelaAccountService } from "../account/lightvela-account-service";
import { createLighthouseConfig } from "../upstream/mono2/pages/marketing/agent-config/product-config";
import { createLocalCommandExecutor } from "../upstream/mono2/pages/marketing/agent-config/local-command-executor";
import { createWorkbenchRepositories } from "../upstream/workbench-repositories";
import { HermesAgentConsoleHost } from "./hermes-agent-console-host";

const ChannelPanel = lazy(async () => {
  const module = await import("../upstream/mono2/pages/marketing/agent-channel-panel");
  return { default: module.ChannelPanel };
});

const HERMES_FEATURE_FLAGS = Object.freeze({
  gateway: true,
  channel: true,
  wecomChannel: true,
  adpChannel: false,
  wecomLongConn: true,
  yuanbaoChannel: false,
  weixinChannel: true,
  qrConfig: true,
  skills: true,
  webUI: false,
  memoryManagement: false,
  memoryV2: false,
  qqbotplugin: false,
});

export function HermesChannelsManagementView({ account, botId }: {
  readonly account: LightVelaAccountService;
  readonly botId: string;
}) {
  const isGlobalRegion = account.getSnapshot().region === "intl";
  const repositories = useMemo(() => createWorkbenchRepositories(account), [account]);
  const commandExecutor = useMemo(
    () => createLocalCommandExecutor({ repositories, botId }),
    [botId, repositories],
  );
  const productConfig = useMemo(() => ({
    ...createLighthouseConfig({
      agentType: "hermes",
      supportsTencentCloudApi: false,
      isI18n: isGlobalRegion,
    }),
    acliProduct: "lightvela" as const,
  }), [isGlobalRegion]);

  return (
    <HermesAgentConsoleHost>
      <Suspense fallback={<div className="flex min-h-48 items-center justify-center text-sm text-black/45">正在加载...</div>}>
        <ChannelPanel
          instance={{ InstanceId: botId, RegionId: 1 }}
          featureFlags={HERMES_FEATURE_FLAGS}
          productConfig={productConfig}
          commandExecutor={commandExecutor}
        />
      </Suspense>
    </HermesAgentConsoleHost>
  );
}
