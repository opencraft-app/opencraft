"use client";

import { ProviderOverview } from "@/components/dashboard/provider-overview";
import { TokenPool } from "@/components/dashboard/token-pool";
import { UserOverview } from "@/components/dashboard/user-overview";
import { StatsCards } from "@/components/dashboard/stats-cards";
import { TokenChart } from "@/components/dashboard/token-chart";
import { ModelDistribution } from "@/components/dashboard/model-distribution";

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">业务总览</h2>
          <p className="text-sm text-muted-foreground">
            先看今天的业务结果，再判断是否需要下钻到资源和分布分析。
          </p>
        </div>
        <StatsCards />
        <TokenChart />
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">资源健康与风险</h2>
          <p className="text-sm text-muted-foreground">
            业务结果由哪些资源支撑、哪些供应商或用户值得进一步排查。
          </p>
        </div>
        <TokenPool />
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
          <ProviderOverview />
          <UserOverview />
        </div>
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">趋势与结构分析</h2>
          <p className="text-sm text-muted-foreground">
            当首屏业务或资源出现异常时，再看模型使用结构做进一步分析。
          </p>
        </div>
        <ModelDistribution />
      </section>
    </div>
  );
}
