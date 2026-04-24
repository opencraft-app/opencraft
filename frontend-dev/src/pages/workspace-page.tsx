import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChatBubble } from "@/components/ui/chat-bubble";
import { ComposerPanel } from "@/components/ui/composer-panel";
import { Input } from "@/components/ui/input";
import { InsetPanel } from "@/components/ui/inset-panel";
import { GrammarPageIntro, GrammarPanel, GrammarSectionCard } from "@/components/site/homepage-grammar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { StatePanel } from "@/components/ui/state-panel";
import { useRepositories } from "@/contexts/repository-context";
import { useAsyncResource } from "@/services/use-async-resource";

export const WorkspacePage = () => {
  const { id } = useParams<{ id: string }>();
  const repositories = useRepositories();
  const botId = id ?? "";

  const [prompt, setPrompt] = useState("请模拟一次用户咨询退款政策的完整对话。");
  const [sending, setSending] = useState(false);

  const snapshot = useAsyncResource(() => repositories.bots.getWorkspaceSnapshot(botId, "live"), [repositories.bots, botId]);

  const canSend = useMemo(() => Boolean(prompt.trim()) && !sending && !!snapshot.data, [prompt, sending, snapshot.data]);

  const onSend = async () => {
    if (!canSend || !snapshot.data) {
      return;
    }

    setSending(true);
    try {
      await repositories.bots.sendWorkspaceMessage(snapshot.data.bot.id, prompt.trim());
      setPrompt("");
      await snapshot.reload();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-5">
      <GrammarPageIntro
        eyebrow={<Badge variant="neutral">Workspace</Badge>}
        title="工作台"
        description="这里是最靠近真实使用的一页。页面先说明你当前在调哪只 Bot，再把对话流和输入区放进同一块工作面。"
        actions={(
          <Button asChild variant="outline">
            <Link to={botId ? `/bots/${botId}/terminal` : "/dashboard"}>打开终端</Link>
          </Button>
        )}
      />

      {snapshot.loading ? <StatePanel variant="loading" title="加载中" description="正在读取会话数据。" /> : null}

      {snapshot.error ? (
        <StatePanel
          variant="error"
          title="工作台不可用"
          description={snapshot.error}
          action={{ label: "重试", onClick: () => void snapshot.reload() }}
        />
      ) : null}

      {snapshot.data && !snapshot.loading && !snapshot.error ? (
        <div className="grid gap-4 xl:grid-cols-[0.78fr_1.22fr]">
          <GrammarPanel tone="muted" className="space-y-4">
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--lw-fg-tertiary)" }}>
                Active context
              </p>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-semibold tracking-[-0.05em]" style={{ color: "var(--lw-fg)" }}>
                    {snapshot.data.bot.name}
                  </h2>
                  <p className="text-sm leading-7" style={{ color: "var(--lw-fg-secondary)" }}>
                    {snapshot.data.bot.template}
                  </p>
                </div>
                <Badge variant="success">{snapshot.data.bot.status}</Badge>
              </div>
            </div>
            <div className="space-y-3">
              {[
                "先用这里验证欢迎语、任务拆解和风格稳定性。",
                "系统消息、助手回复、用户输入应该看起来像同一个工作面里的不同声部。",
                "输入区保持紧凑，但父级容器必须保留首页那种温暖留白。",
              ].map((item) => (
                <div key={item} className="rounded-[1.1rem] border px-4 py-3 text-sm leading-7" style={{ borderColor: "var(--lw-border)", background: "rgba(255,255,255,0.76)" }}>
                  {item}
                </div>
              ))}
            </div>
          </GrammarPanel>

          <GrammarSectionCard kicker="Conversation bench" title="Live thread" description="工作台本身是一块被首页语法驯化过的 workbench：更密，但不冷。">
            {snapshot.data.messages.length ? (
              <InsetPanel className="min-h-[26rem] rounded-[1.5rem] bg-white">
                <div className="flex min-h-[26rem] flex-col p-4">
                  <ScrollArea className="min-h-0 flex-1">
                    <div className="space-y-3">
                      {snapshot.data.messages.map((message) => (
                        <ChatBubble
                          key={message.id}
                          tone={
                            message.role === "user"
                              ? "user"
                              : message.role === "system"
                                ? "system"
                                : "assistant"
                          }
                        >
                          {message.text}
                        </ChatBubble>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              </InsetPanel>
            ) : (
              <StatePanel variant="empty" title="暂无消息" description="发送第一条提示词即可开始测试。" className="flex-1" />
            )}

            <ComposerPanel>
                <Input
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="输入测试任务..."
                  aria-label="工作台提示词"
                  className="bg-[color-mix(in_oklab,var(--surface-base)_95%,white)]"
                />
                <Button onClick={onSend} disabled={!canSend} className="sm:w-auto">
                  {sending ? "发送中..." : "发送"} <Send className="size-4" />
                </Button>
            </ComposerPanel>
          </GrammarSectionCard>
        </div>
      ) : null}
    </div>
  );
};
