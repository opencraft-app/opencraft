import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { MessageCircleMore } from "lucide-react";
import { ConfigSection } from "@/components/domain/config-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatePanel } from "@/components/ui/state-panel";
import { GrammarCanvas, GrammarPageIntro, GrammarSectionCard } from "@/components/site/homepage-grammar";
import { useRepositories } from "@/contexts/repository-context";
import { useAsyncResource } from "@/services/use-async-resource";

export const SettingsPage = () => {
  const { id } = useParams<{ id: string }>();
  const repositories = useRepositories();
  const botId = id ?? "";
  const snapshot = useAsyncResource(() => repositories.bots.getSettingsSnapshot(botId, "live"), [repositories.bots, botId]);
  const [qqAppId, setQqAppId] = useState("");
  const [qqAppSecret, setQqAppSecret] = useState("");
  const [qqAccount, setQqAccount] = useState("");
  const [channelSaving, setChannelSaving] = useState(false);
  const [channelNotice, setChannelNotice] = useState<string | null>(null);

  useEffect(() => {
    setChannelNotice(null);
  }, [botId]);

  const saveQQChannel = async () => {
    if (!botId) {
      return;
    }

    setChannelSaving(true);
    setChannelNotice(null);
    try {
      const result = await repositories.bots.configureQQChannel(botId, {
        appId: qqAppId,
        appSecret: qqAppSecret,
        account: qqAccount || undefined,
      });
      setChannelNotice(result.gatewayRestarted ? "QQ channel 已配置，gateway 已重启。" : "QQ channel 已配置，但 gateway 未确认重启。");
    } catch (error) {
      setChannelNotice(error instanceof Error ? error.message : "QQ channel 配置失败");
    } finally {
      setChannelSaving(false);
    }
  };

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <GrammarCanvas className="mx-auto max-w-6xl">
        <div className="space-y-8 px-6 py-6 sm:px-8 sm:py-8">
          <GrammarPageIntro
            eyebrow={<p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--lw-fg-tertiary)" }}>Settings</p>}
            title="Bot 运行设置"
            description="当前设置页先保留成轻量入口，但把真实终端操作提前露出来。需要排障或手工运维时，直接跳去 terminal 即可。"
            actions={(
              <>
                <Button asChild>
                  <Link to={id ? `/bots/${id}/terminal` : "/dashboard/settings"}>打开终端</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link to={id ? `/bots/${id}/workspace` : "/dashboard/settings"}>返回工作台</Link>
                </Button>
              </>
            )}
          />

          {snapshot.loading ? <StatePanel variant="loading" title="加载中" description="正在读取 bot 设置。" /> : null}

          {snapshot.error ? (
            <StatePanel
              variant="error"
              title="设置页加载失败"
              description={snapshot.error}
              action={{ label: "重试", onClick: () => void snapshot.reload() }}
            />
          ) : null}

          <GrammarSectionCard
            kicker="Current Scope"
            title="设置页暂存位"
            description="这部分后续会接版本、工具和知识源。终端入口先放在这里，是为了让 bot 的运维动作不再悬空。"
          >
            <div className="space-y-3 text-sm leading-7" style={{ color: "var(--lw-fg-secondary)" }}>
              <p><strong>Bot ID:</strong> {id ?? "-"}</p>
              <p>终端页面会根据当前 bot 关联的 <code>sandbox_id</code> 调用 <code>/sandboxes/:sandboxID/tat/session</code> 创建腾讯云 TAT PTY 会话。</p>
              <p>如果 bot 还没分配到 sandbox，终端页会直接报清晰错误，而不是静默失败。</p>
            </div>
          </GrammarSectionCard>

          {snapshot.data ? (
            <ConfigSection
              title="QQ Channel"
              description="把 Bot 接到 QQ 机器人通道。前端会把 App ID 和 App Secret 组装成 ctl 需要的 token。"
              icon={<MessageCircleMore className="size-4 text-[var(--brand-600)]" />}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="qq-app-id">QQ App ID</Label>
                  <Input
                    id="qq-app-id"
                    value={qqAppId}
                    onChange={(event) => setQqAppId(event.target.value)}
                    placeholder="请输入 QQ 机器人的 App ID"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="qq-app-secret">QQ App Secret</Label>
                  <Input
                    id="qq-app-secret"
                    type="password"
                    value={qqAppSecret}
                    onChange={(event) => setQqAppSecret(event.target.value)}
                    placeholder="请输入 QQ 机器人的 App Secret"
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="qq-account">QQ Account（可选）</Label>
                  <Input
                    id="qq-account"
                    value={qqAccount}
                    onChange={(event) => setQqAccount(event.target.value)}
                    placeholder="同通道多账号时可填写 bot1 之类的标识"
                  />
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button onClick={saveQQChannel} disabled={channelSaving || !qqAppId.trim() || !qqAppSecret.trim()}>
                  {channelSaving ? "配置中..." : "保存 QQ Channel"}
                </Button>
                <Button asChild variant="outline">
                  <a href="https://q.qq.com/qqbot/openclaw/login.html" target="_blank" rel="noreferrer">查看 QQ 开放平台</a>
                </Button>
                {channelNotice ? <p className="text-sm text-[var(--lw-fg-secondary)]">{channelNotice}</p> : null}
              </div>
            </ConfigSection>
          ) : null}
        </div>
      </GrammarCanvas>
    </div>
  );
};
