import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GrammarPageIntro, GrammarPanel, GrammarSectionCard } from "@/components/site/homepage-grammar";
import { StatePanel } from "@/components/ui/state-panel";
import { StatTile } from "@/components/ui/stat-tile";
import { useRepositories } from "@/contexts/repository-context";
import { useSession } from "@/contexts/session-context";
import { useAsyncResource } from "@/services/use-async-resource";

export const DashboardPage = () => {
  const navigate = useNavigate();
  const repositories = useRepositories();
  const { session, setFirstBotId } = useSession();
  const [creating, setCreating] = useState(false);
  const [destroying, setDestroying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const snapshot = useAsyncResource(() => repositories.bots.getDashboardSnapshot("live"), [repositories.bots]);

  useEffect(() => {
    if (snapshot.data?.bots.length && !session.firstBotId) {
      setFirstBotId(snapshot.data.bots[0]?.id ?? null);
    }
  }, [session.firstBotId, setFirstBotId, snapshot.data?.bots]);

  const onCreateBot = async () => {
    setCreating(true);
    setNotice(null);
    setError(null);
    try {
      const bot = await repositories.bots.createBot();
      setFirstBotId(bot.id);
      await snapshot.reload();
      navigate(`/bots/${bot.id}/settings`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "创建实例失败。");
    } finally {
      setCreating(false);
    }
  };

  const onDestroyBot = async () => {
    const activeBot = snapshot.data?.bots[0];
    if (!activeBot) {
      return;
    }

    const confirmed = window.confirm(`销毁 ${activeBot.name} 后将删除对应实例，且无法恢复。确定继续吗？`);
    if (!confirmed) {
      return;
    }

    setDestroying(true);
    setNotice(null);
    setError(null);
    try {
      await repositories.bots.destroyBot(activeBot.id);
      if (session.firstBotId === activeBot.id) {
        setFirstBotId(null);
      }
      await snapshot.reload();
      setNotice("实例已发起销毁。");
    } catch (destroyError) {
      setError(destroyError instanceof Error ? destroyError.message : "销毁实例失败。");
    } finally {
      setDestroying(false);
    }
  };

  return (
    <div className="space-y-5">
      <GrammarPageIntro
        eyebrow={<Badge variant="neutral">Dashboard</Badge>}
        title="总览"
        description="先看今天这套系统的运行态势，再决定是创建新 Bot、继续调试，还是回到已有工作台。"
        actions={
          <Button onClick={onCreateBot} disabled={creating}>
            <Plus className="size-4" /> {creating ? "创建中..." : "创建 Bot"}
          </Button>
        }
      />

      {snapshot.loading ? <StatePanel variant="loading" title="加载中" description="正在读取 Bot 数据。" /> : null}

      {snapshot.error ? (
        <StatePanel
          variant="error"
          title="加载失败"
          description={snapshot.error}
          action={{ label: "重试", onClick: () => void snapshot.reload() }}
        />
      ) : null}

      {notice ? <p className="text-sm text-[var(--text-secondary)]">{notice}</p> : null}
      {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}

      {snapshot.data && !snapshot.loading && !snapshot.error ? (
        !snapshot.data.bots.length ? (
          <GrammarSectionCard
            kicker="First operator move"
            title="还没有 Bot"
            description="先创建一个 Bot，再去 Workspace 对话测试。第一批页面不应该用空白惩罚用户，而应该把下一步说清楚。"
            tone="muted"
          >
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => void onCreateBot()} disabled={creating}>
                {creating ? "创建中..." : "创建第一个 Bot"}
              </Button>
            </div>
          </GrammarSectionCard>
        ) : (
          <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
            <GrammarSectionCard
              kicker="Active lead bot"
              title={snapshot.data.bots[0]?.name ?? "Bot"}
              description={`${snapshot.data.bots[0]?.template} · ${snapshot.data.bots[0]?.type}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Badge variant={snapshot.data.bots[0]?.status === "active" ? "success" : "warning"}>
                  {snapshot.data.bots[0]?.status}
                </Badge>
                <div className="flex flex-wrap gap-3">
                  <Button onClick={() => navigate(`/bots/${snapshot.data?.bots[0]?.id}/workspace`)}>
                    进入 Workspace
                    <ArrowRight className="size-4" />
                  </Button>
                  <Button variant="outline" onClick={() => navigate(`/bots/${snapshot.data?.bots[0]?.id}/terminal`)}>
                    打开终端
                  </Button>
                  <Button variant="outline" onClick={() => navigate(`/bots/${snapshot.data?.bots[0]?.id}/settings`)}>
                    打开 Settings
                  </Button>
                  <Button variant="destructive" onClick={() => void onDestroyBot()} disabled={destroying}>
                    {destroying ? "销毁中..." : "销毁 Bot"}
                  </Button>
                </div>
              </div>
              {snapshot.data.runtime ? (
                <div className="grid gap-3 sm:grid-cols-3">
                  <StatTile label="延迟" value={`${snapshot.data.runtime.latencyMs}ms`} />
                  <StatTile label="在线会话" value={String(snapshot.data.runtime.activeSessions)} />
                  <StatTile label="吞吐" value={`${snapshot.data.runtime.throughputPerMinute}/min`} />
                </div>
              ) : (
                <p className="text-sm leading-7 text-[var(--text-secondary)]">暂无运行数据，发送消息后会更新。</p>
              )}
            </GrammarSectionCard>

            <GrammarPanel tone="muted" className="space-y-5">
              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--lw-fg-tertiary)" }}>
                  Operator read
                </p>
                <h2 className="text-xl font-semibold tracking-[-0.04em]" style={{ color: "var(--lw-fg)" }}>
                  当前页首先回答三个问题
                </h2>
              </div>
              <div className="grid gap-3">
                <div className="rounded-[1.1rem] border px-4 py-4" style={{ borderColor: "var(--lw-border)", background: "rgba(255,255,255,0.76)" }}>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--lw-fg-tertiary)" }}>
                    What is running
                  </p>
                  <p className="mt-2 text-sm leading-7" style={{ color: "var(--lw-fg-secondary)" }}>
                    谁是当前主 Bot，它处于什么状态。
                  </p>
                </div>
                <div className="rounded-[1.1rem] border px-4 py-4" style={{ borderColor: "var(--lw-border)", background: "rgba(255,255,255,0.76)" }}>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--lw-fg-tertiary)" }}>
                    How it feels
                  </p>
                  <p className="mt-2 text-sm leading-7" style={{ color: "var(--lw-fg-secondary)" }}>
                    延迟、活跃会话和吞吐是否还在健康范围。
                  </p>
                </div>
                <div className="rounded-[1.1rem] border px-4 py-4" style={{ borderColor: "var(--lw-border)", background: "rgba(255,255,255,0.76)" }}>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--lw-fg-tertiary)" }}>
                    What to do next
                  </p>
                  <p className="mt-2 text-sm leading-7" style={{ color: "var(--lw-fg-secondary)" }}>
                    进入 workspace 调试，或者回到 settings 继续完善定义。
                  </p>
                </div>
              </div>
            </GrammarPanel>
          </div>
        )
      ) : null}
    </div>
  );
};
