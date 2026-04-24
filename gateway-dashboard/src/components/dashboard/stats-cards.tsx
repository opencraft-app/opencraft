"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useUsageStats } from "@/lib/queries/use-stats";
import { useProviders } from "@/lib/queries/use-providers";
import { useApiKeys } from "@/lib/queries/use-api-keys";
import { formatTokens, formatNumber, formatPercentChange } from "@/lib/utils";
import { Activity, Coins, Plug, KeyRound } from "lucide-react";

export function StatsCards() {
  const usage = useUsageStats();
  const providers = useProviders();
  const apiKeys = useApiKeys();

  const isLoading = usage.isLoading || providers.isLoading || apiKeys.isLoading;

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  }

  const cards = [
    {
      label: "今日交互次数",
      value: formatNumber(usage.data?.total_interactions ?? 0),
      change: usage.data?.interactions_change_pct,
      icon: Activity,
    },
    {
      label: "今日Token消耗",
      value: formatTokens(usage.data?.total_tokens ?? 0),
      change: usage.data?.tokens_change_pct,
      icon: Coins,
    },
    {
      label: "活跃供应商",
      value: `${providers.data?.active_count ?? 0} / ${providers.data?.total ?? 0}`,
      icon: Plug,
    },
    {
      label: "活跃密钥",
      value: formatNumber(apiKeys.data?.active_count ?? 0),
      icon: KeyRound,
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <Card key={card.label}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {card.label}
              </CardTitle>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{card.value}</div>
              {card.change !== undefined && (
                <p className="text-xs text-muted-foreground">
                  {formatPercentChange(card.change)} 较昨日
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
