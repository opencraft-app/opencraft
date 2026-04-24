import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { PlanTier } from "@/domain/types";
import { PlanCard } from "@/components/domain/plan-card";
import { GrammarPageIntro, GrammarPanel } from "@/components/site/homepage-grammar";
import { Badge } from "@/components/ui/badge";
import { StatePanel } from "@/components/ui/state-panel";
import { useRepositories } from "@/contexts/repository-context";
import { useSession } from "@/contexts/session-context";
import { useAsyncResource } from "@/services/use-async-resource";

export const PlanSelectPage = () => {
  const navigate = useNavigate();
  const repositories = useRepositories();
  const { selectPlan } = useSession();
  const [confirming, setConfirming] = useState(false);

  const preview = useAsyncResource(() => repositories.plans.getPlanPreview(), [repositories.plans]);

  const selectedTier = useMemo<PlanTier>(() => preview.data?.currentCandidate ?? "free", [preview.data?.currentCandidate]);

  const onConfirm = async (tier: PlanTier) => {
    setConfirming(true);
    try {
      await selectPlan(tier);
      navigate("/subscribe", { replace: true });
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="space-y-5">
      <GrammarPageIntro
        eyebrow={<Badge variant="neutral">Plan selection</Badge>}
      title="选择你的 LightVela 档位"
        description="现在这一步更像首次设置，而不是注册尾声。先确认你要从哪种强度开始，再进入控制台。当前首版只开放免费体验。"
      />

      {preview.loading ? <StatePanel variant="loading" title="加载中" description="正在读取套餐信息。" /> : null}

      {preview.error ? (
        <StatePanel
          variant="error"
          title="加载失败"
          description={preview.error}
          action={{ label: "重试", onClick: () => void preview.reload() }}
        />
      ) : null}

      {preview.data ? (
        <div className="grid gap-4 xl:grid-cols-[0.82fr_1.18fr]">
          <GrammarPanel tone="muted" className="space-y-4">
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--lw-fg-tertiary)" }}>
                Why a plan comes first
              </p>
              <h2 className="text-2xl font-semibold tracking-[-0.05em]" style={{ color: "var(--lw-fg)" }}>
                先确认工作节奏，再决定控制台要露出什么。
              </h2>
            </div>
            <div className="space-y-3">
              {[
                "免费体验适合先把创建、调试、配置主链路跑通。",
                "Plus 和 Max 暂时保留卡位，让后续开放时仍在同一套页面结构里。",
                "选完计划后直接进入设置页，不再多跳一步。",
              ].map((item) => (
                <div key={item} className="rounded-[1.1rem] border px-4 py-3 text-sm leading-7" style={{ borderColor: "var(--lw-border)", background: "rgba(255,255,255,0.76)" }}>
                  {item}
                </div>
              ))}
            </div>
          </GrammarPanel>

          <div className="grid gap-4 lg:grid-cols-3">
            {preview.data.plans.map((plan) => (
              <PlanCard
                key={plan.tier}
                plan={plan}
                selected={plan.tier === selectedTier}
                loading={confirming && plan.tier === selectedTier}
                onSelect={plan.available ? () => void onConfirm(plan.tier) : undefined}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};
