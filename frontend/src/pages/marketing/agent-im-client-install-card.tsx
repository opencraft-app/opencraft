import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/t";
import { buildImClientInstallStartCommand, IM_CLIENT_INSTALL_STATUS_COMMAND, VELA_IM_CLIENT_RELEASE } from "@/lib/vela-im-client-install";
import type { BotRepository } from "@/repositories/types";

export function AgentImClientInstallCard({ botId, bots }: { botId: string; bots: Pick<BotRepository, "execDebugCommand"> }) {
  const t = useT();
  const [phase, setPhase] = useState<"idle" | "installing" | "installed" | "failed">("idle");
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setPhase("idle");
    return () => { generation.current += 1; };
  }, [botId]);
  const install = async () => {
    if (!VELA_IM_CLIENT_RELEASE.published || phase === "installing") return;
    const current = generation.current;
    setPhase("installing");
    try {
      const result = await bots.execDebugCommand(botId, buildImClientInstallStartCommand(), { timeoutMs: 30_000 });
      if (result.exitCode !== 0 || !result.output.split(/\r?\n/).includes("VELA_IM_INSTALL_STARTED")) throw new Error("Installation did not start");
      const deadline = Date.now() + 360_000;
      while (current === generation.current && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
        if (current !== generation.current) return;
        const status = await bots.execDebugCommand(botId, IM_CLIENT_INSTALL_STATUS_COMMAND, { timeoutMs: 30_000 });
        if (current !== generation.current) return;
        if (status.exitCode !== 0) throw new Error("Installation status unavailable");
        const state = status.output.trim();
        if (state === "installed" || state === "failed") { setPhase(state); return; }
      }
      if (current === generation.current) setPhase("failed");
    } catch {
      if (current === generation.current) setPhase("failed");
    }
  };
  return <section className="mb-6 rounded-lg border border-[var(--border)] p-4">
    <h2 className="font-semibold">{t("IM 客户端")}</h2>
    <p className="my-2 text-sm text-[var(--text-secondary)]">{t("首次安装协作聊天客户端，已安装时直接复用。")}</p>
    <Button size="sm" onClick={() => void install()} disabled={!VELA_IM_CLIENT_RELEASE.published || phase === "installing" || phase === "installed"}>
      {phase === "installing" ? t("正在安装…") : phase === "installed" ? t("已安装") : t("安装客户端")}
    </Button>
    {!VELA_IM_CLIENT_RELEASE.published && <p role="status" className="mt-2 text-sm">{t("安装包尚未发布。")}</p>}
    {phase === "failed" && <p role="alert" className="mt-2 text-sm">{t("安装失败，请重试。")}</p>}
  </section>;
}
