import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Bot, MessageCircleMore, Settings2, Sparkles } from "lucide-react";
import { ConfigSection } from "@/components/domain/config-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GrammarPageIntro, GrammarSectionCard } from "@/components/site/homepage-grammar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatePanel } from "@/components/ui/state-panel";
import { Textarea } from "@/components/ui/textarea";
import { useRepositories } from "@/contexts/repository-context";
import { useAsyncResource } from "@/services/use-async-resource";

export const SettingsPage = () => {
  const { id } = useParams<{ id: string }>();
  const botId = id ?? "";
  const repositories = useRepositories();

  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [qqChannel, setQqChannel] = useState({
    appId: "",
    appSecret: "",
    account: "",
  });
  const [channelSaving, setChannelSaving] = useState(false);
  const [channelNotice, setChannelNotice] = useState<string | null>(null);
  const [profile, setProfile] = useState({
    name: "",
    status: "draft" as "draft" | "active" | "paused",
    mission: "",
    scenario: "",
    template: "",
    type: "support" as "sales" | "support" | "ops" | "research",
    prompt: "",
  });

  const snapshot = useAsyncResource(() => repositories.bots.getSettingsSnapshot(botId, "live"), [repositories.bots, botId]);

  useEffect(() => {
    if (!snapshot.data) {
      return;
    }

    setProfile({
      name: snapshot.data.bot.name,
      status: snapshot.data.bot.status,
      mission: snapshot.data.bot.mission ?? "提升消费者咨询响应效率",
      scenario: snapshot.data.bot.scenario ?? "ToC 服务咨询",
      template: snapshot.data.bot.template,
      type: snapshot.data.bot.type,
      prompt: "你是 Lightclaw 的消费者场景助手。回答要准确、简洁并可执行。",
    });
    setNotice(null);
    setChannelNotice(null);
  }, [snapshot.data]);

  const saveProfile = async () => {
    if (!snapshot.data) {
      return;
    }

    setSaving(true);
    setNotice(null);
    try {
      await repositories.bots.updateBotProfile(snapshot.data.bot.id, {
        name: profile.name,
        status: profile.status,
        mission: profile.mission,
        scenario: profile.scenario,
        template: profile.template,
        type: profile.type,
      });
      await snapshot.reload();
      setNotice("已保存");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const saveQQChannel = async () => {
    if (!botId) {
      return;
    }

    setChannelSaving(true);
    setChannelNotice(null);
    try {
      const result = await repositories.bots.configureQQChannel(botId, {
        appId: qqChannel.appId,
        appSecret: qqChannel.appSecret,
        account: qqChannel.account || undefined,
      });
      setChannelNotice(result.gatewayRestarted ? "QQ channel 已配置，gateway 已重启。" : "QQ channel 已配置，但 gateway 未确认重启。");
    } catch (error) {
      setChannelNotice(error instanceof Error ? error.message : "QQ channel 配置失败");
    } finally {
      setChannelSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <GrammarPageIntro
        eyebrow={<Badge variant="neutral">Bot settings</Badge>}
        title="设置"
        description="在这里定义 Bot 的基本身份、任务边界和回答语气。页面结构沿用首页的章节感，而不是把字段直接堆成后台表单。"
        actions={(
          <Button asChild variant="outline">
            <Link to={botId ? `/bots/${botId}/terminal` : "/dashboard"}>打开终端</Link>
          </Button>
        )}
      />

      {snapshot.loading ? <StatePanel variant="loading" title="加载中" description="读取配置数据中。" /> : null}

      {snapshot.error ? (
        <StatePanel
          variant="error"
          title="设置页加载失败"
          description={snapshot.error}
          action={{ label: "重试", onClick: () => void snapshot.reload() }}
        />
      ) : null}

      {snapshot.data && !snapshot.loading && !snapshot.error ? (
        <div className="space-y-4">
          <ConfigSection title="基础信息" description="名称和运行状态" icon={<Bot className="size-4 text-[var(--brand-600)]" />}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Bot 名称</Label>
                <Input value={profile.name} onChange={(event) => setProfile((curr) => ({ ...curr, name: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>状态</Label>
                <Select
                  value={profile.status}
                  onValueChange={(value) => setProfile((curr) => ({ ...curr, status: value as typeof curr.status }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">active</SelectItem>
                    <SelectItem value="draft">draft</SelectItem>
                    <SelectItem value="paused">paused</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </ConfigSection>

          <ConfigSection title="Bot 定义" description="补齐 mission、场景和类型" icon={<Sparkles className="size-4 text-[var(--brand-600)]" />}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label>Mission</Label>
                <Input value={profile.mission} onChange={(event) => setProfile((curr) => ({ ...curr, mission: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Scenario</Label>
                <Input value={profile.scenario} onChange={(event) => setProfile((curr) => ({ ...curr, scenario: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Template</Label>
                <Input value={profile.template} onChange={(event) => setProfile((curr) => ({ ...curr, template: event.target.value }))} />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>Type</Label>
                <Select
                  value={profile.type}
                  onValueChange={(value) => setProfile((curr) => ({ ...curr, type: value as typeof curr.type }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sales">sales</SelectItem>
                    <SelectItem value="support">support</SelectItem>
                    <SelectItem value="ops">ops</SelectItem>
                    <SelectItem value="research">research</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </ConfigSection>

          <ConfigSection title="Prompt" description="控制回答语气和边界" icon={<Settings2 className="size-4 text-[var(--brand-600)]" />}>
            <div className="space-y-2">
              <Label>System Prompt</Label>
              <Textarea
                value={profile.prompt}
                onChange={(event) => setProfile((curr) => ({ ...curr, prompt: event.target.value }))}
              />
            </div>
          </ConfigSection>

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
                  value={qqChannel.appId}
                  onChange={(event) => setQqChannel((curr) => ({ ...curr, appId: event.target.value }))}
                  placeholder="请输入 QQ 机器人的 App ID"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="qq-app-secret">QQ App Secret</Label>
                <Input
                  id="qq-app-secret"
                  type="password"
                  value={qqChannel.appSecret}
                  onChange={(event) => setQqChannel((curr) => ({ ...curr, appSecret: event.target.value }))}
                  placeholder="请输入 QQ 机器人的 App Secret"
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="qq-account">QQ Account（可选）</Label>
                <Input
                  id="qq-account"
                  value={qqChannel.account}
                  onChange={(event) => setQqChannel((curr) => ({ ...curr, account: event.target.value }))}
                  placeholder="同通道多账号时可填写 bot1 之类的标识"
                />
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                onClick={saveQQChannel}
                disabled={channelSaving || !qqChannel.appId.trim() || !qqChannel.appSecret.trim()}
              >
                {channelSaving ? "配置中..." : "保存 QQ Channel"}
              </Button>
              <Button asChild variant="outline">
                <a href="https://q.qq.com/qqbot/openclaw/login.html" target="_blank" rel="noreferrer">查看 QQ 开放平台</a>
              </Button>
              {channelNotice ? <p className="text-sm text-[var(--text-secondary)]">{channelNotice}</p> : null}
            </div>
          </ConfigSection>

          <GrammarSectionCard
            kicker="Commit changes"
            title="保存变更"
            description="当前版本只保存核心字段，更多配置后续开放。"
            tone="muted"
          >
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={saveProfile} disabled={saving}>
                {saving ? "保存中..." : "保存设置"}
              </Button>
              {notice ? <p className="text-sm text-[var(--text-secondary)]">{notice}</p> : null}
            </div>
          </GrammarSectionCard>
        </div>
      ) : null}
    </div>
  );
};
