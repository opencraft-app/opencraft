import { Suspense, lazy, useMemo } from "react";

import type { LightVelaAccountService } from "../account/lightvela-account-service";
import { createLighthouseConfig } from "../upstream/mono2/pages/marketing/agent-config/product-config";
import { useModelProviders } from "../upstream/mono2/pages/marketing/agent-config/hooks/useModelProviders";
import { resolveProductModelProviderOptions } from "../upstream/mono2/pages/marketing/agent-model-config/product-provider-adapter";
import { HermesAgentConsoleHost } from "./hermes-agent-console-host";

const AgentModelConfigPanel = lazy(async () => {
  const module = await import("../upstream/mono2/pages/marketing/agent-model-config/agent-model-config-panel");
  return { default: module.AgentModelConfigPanel };
});

export function HermesModelsManagementView({ account, botId }: {
  readonly account: LightVelaAccountService;
  readonly botId: string;
}) {
  const isGlobalRegion = account.getSnapshot().region === "intl";
  const modelProviders = useModelProviders({
    isI18n: isGlobalRegion,
    useEnglish: isGlobalRegion,
    app: "lighthouse",
  });
  const providers = useMemo(() => {
    const productConfig = createLighthouseConfig({
      agentType: "hermes",
      supportsTencentCloudApi: false,
      isI18n: isGlobalRegion,
      modelProviders,
    });
    return resolveProductModelProviderOptions(productConfig, modelProviders, { regionId: 1 });
  }, [isGlobalRegion, modelProviders]);

  return (
    <HermesAgentConsoleHost>
      <Suspense fallback={<div className="flex min-h-48 items-center justify-center text-sm text-black/45">正在加载...</div>}>
        <AgentModelConfigPanel
          botId={botId}
          execDebugCommand={account.execDebugCommand.bind(account)}
          providers={providers}
          isGlobalRegion={isGlobalRegion}
        />
      </Suspense>
    </HermesAgentConsoleHost>
  );
}
