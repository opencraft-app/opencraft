import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/t";
import { useTatHermesProxyBroker } from "@/components/domain/use-tat-hermes-proxy-broker";

interface TatHermesWebPanelProps {
  botId: string;
}

export const TatHermesWebPanel = ({ botId }: TatHermesWebPanelProps) => {
  const t = useT();
  const { diagnostic, error, frameUrl, reload, reloadKey, status } = useTatHermesProxyBroker(botId);

  const openInNewTab = () => {
    window.open(frameUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="overflow-hidden rounded-lg border border-black/[0.08] bg-white shadow-[0_8px_28px_rgba(15,23,42,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/[0.06] px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-black/90">{t("Hermes WebUI")}</h2>
          <p className="mt-0.5 text-xs text-black/45">
            {t("通过 TAT 访问当前 Agent 内的 127.0.0.1:9119。")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={reload} disabled={status !== "ready"}>
            <RefreshCw className="mr-1.5 size-3.5" />
            {t("刷新")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={openInNewTab} disabled={status !== "ready"}>
            <ExternalLink className="mr-1.5 size-3.5" />
            {t("新窗口")}
          </Button>
        </div>
      </div>

      {status === "ready" && (diagnostic.pending > 0 || diagnostic.lastError || diagnostic.lastStatus) && (
        <div
          className="border-b border-black/[0.06] px-4 py-2 text-xs"
          style={{
            background: diagnostic.lastError ? "rgba(220,38,38,0.06)" : "rgba(15,23,42,0.035)",
            color: diagnostic.lastError ? "#b91c1c" : "rgba(0,0,0,0.58)",
          }}
        >
          <span className="font-medium">
            {diagnostic.pending > 0 ? t("代理请求中") : diagnostic.lastError ? t("代理失败") : t("代理正常")}
          </span>
          {diagnostic.lastUrl && <span className="ml-2 font-mono">{diagnostic.lastUrl}</span>}
          {diagnostic.lastStatus && <span className="ml-2">HTTP {diagnostic.lastStatus}</span>}
          {diagnostic.lastSize !== null && <span className="ml-2">{diagnostic.lastSize} bytes</span>}
          {diagnostic.lastError && <span className="ml-2 font-mono">{diagnostic.lastError}</span>}
        </div>
      )}

      {status !== "ready" && (
        <div className="flex h-[560px] flex-col items-center justify-center gap-3 p-6 text-center text-sm text-black/55">
          {status === "error" ? null : <Loader2 className="size-5 animate-spin" />}
          <p>{status === "error" ? error : t("正在启动 Hermes WebUI 代理...")}</p>
        </div>
      )}

      {status === "ready" && (
        <iframe
          key={reloadKey}
          title={t("Hermes WebUI")}
          src={frameUrl}
          className="block h-[clamp(560px,calc(100vh-230px),980px)] w-full border-0 bg-white"
        />
      )}
    </div>
  );
};
