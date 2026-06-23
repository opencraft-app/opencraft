import { lazy, Suspense, type ComponentProps } from "react";

import { useT } from "@/i18n/t";

// AgentChat carries side-effect CSS. Keep it out of the agents shell until the chat tab is actually rendered.
const LightVelaPanel = lazy(() =>
  import("@tencent/agentchat-lightvela-panel").then((module) => ({ default: module.LightVelaPanel })),
);

type AgentChatPanelProps = {
  accountId: string;
  commandExecutor: ComponentProps<typeof LightVelaPanel>["commandExecutor"];
  instanceId: string;
  launchToken: string | null;
  launchTokenError: string | null;
  launchTokenStatus: "idle" | "loading" | "ready" | "error";
  onRetryLaunchToken: () => void;
};

export const AgentChatPanel = ({
  accountId,
  commandExecutor,
  instanceId,
  launchToken,
  launchTokenError,
  launchTokenStatus,
  onRetryLaunchToken,
}: AgentChatPanelProps) => {
  const t = useT();

  return (
    <div className="h-[clamp(516px,calc(100vh-220px),960px)] overflow-hidden rounded-lg border border-black/[0.08] bg-white [&>*]:h-full">
      {(launchTokenStatus === "idle" || launchTokenStatus === "loading") && (
        <div className="flex h-full items-center justify-center p-6 text-sm text-black/60">
          {t("正在获取 AgentChat 启动 token…")}
        </div>
      )}
      {launchTokenStatus === "error" && (
        <div className="flex h-full flex-col items-center justify-center p-6 text-center text-sm">
          <p className="text-red-500">
            {t("获取 AgentChat 启动 token 失败：{{message}}", { message: launchTokenError || t("未知错误") })}
          </p>
          <button
            type="button"
            onClick={onRetryLaunchToken}
            className="mt-3 inline-flex items-center rounded-md border border-black/[0.12] bg-white px-3 py-1.5 text-xs font-medium text-black/80 hover:bg-black/[0.04]"
          >
            {t("重试")}
          </button>
        </div>
      )}
      {launchTokenStatus === "ready" && launchToken && accountId && (
        <Suspense
          fallback={(
            <div className="flex h-full items-center justify-center p-6 text-sm text-black/60">
              {t("正在加载 AgentChat…")}
            </div>
          )}
        >
          <LightVelaPanel
            instanceIds={[instanceId]}
            instanceId={instanceId}
            region="ap-guangzhou"
            userId={accountId}
            product="lightvela"
            lightvelaApiParams={{
              businessCode: "lightvela",
              token: launchToken,
            }}
            commandExecutor={commandExecutor}
            features={{
              autoActivate: true,
              nativeWsGray: true,
            }}
          />
        </Suspense>
      )}
    </div>
  );
};
