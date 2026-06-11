import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { GrammarCanvas, GrammarPageIntro, GrammarSectionCard } from "@/components/site/homepage-grammar";
import { AGENTS_HOME_PATH } from "@/router/paths";

export const WorkspacePage = () => {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <GrammarCanvas className="mx-auto max-w-6xl">
        <div className="space-y-8 px-6 py-6 sm:px-8 sm:py-8">
          <GrammarPageIntro
            eyebrow={<p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--lw-fg-tertiary)" }}>Workspace</p>}
            title="Agent 工作空间"
            description="这块还是轻壳，但现在已经可以直接跳到真实的腾讯云 TAT 终端。后续 Agent 的消息、日志和运行态会继续在这里收口。"
            actions={(
              <>
                <Button asChild>
                  <Link to={id ? `/bots/${id}/terminal` : AGENTS_HOME_PATH}>进入终端</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link to={id ? `/bots/${id}/settings` : AGENTS_HOME_PATH}>Agent 设置</Link>
                </Button>
              </>
            )}
          />

          <GrammarSectionCard
            kicker="Live Access"
            title="现在已经可用的能力"
            description="Agent 页面现在不再只是占位。最小闭环已经成立：Agent -> sandbox -> TAT websocket terminal。"
          >
            <div className="space-y-3 text-sm leading-7" style={{ color: "var(--lw-fg-secondary)" }}>
              <p><strong>Agent ID:</strong> {id ?? "-"}</p>
              <p>点击上面的 <code>进入终端</code> 会直接为当前 Agent 绑定的 sandbox 创建 TAT session，并跳到单独的 terminal 页面。</p>
              <p>后续这里再继续接消息流、日志流和运行态面板即可，不需要再改终端接入方式。</p>
            </div>
          </GrammarSectionCard>
        </div>
      </GrammarCanvas>
    </div>
  );
};
