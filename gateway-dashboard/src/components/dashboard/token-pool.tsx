"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useTokenPool } from "@/lib/queries/use-stats";
import { formatTokens, formatPercentChange } from "@/lib/utils";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";

export function TokenPool() {
  const { data, isLoading, error } = useTokenPool();

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-6">
          <p className="text-sm text-destructive">加载Token池失败</p>
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const metrics = [
    { label: "总分配", value: data.total_distributed },
    {
      label: "总消耗",
      value: data.total_consumed,
      change: data.consumed_change_7d_pct,
    },
    { label: "全局剩余", value: data.global_remaining },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {metrics.map((m) => (
        <Card key={m.label}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {m.label}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatTokens(m.value)}</div>
            <p className="text-xs text-muted-foreground">Token</p>
            {m.change !== undefined && (
              <div className="flex items-center gap-1 mt-1">
                {m.change >= 0 ? (
                  <ArrowUpRight className="h-3 w-3 text-red-500" />
                ) : (
                  <ArrowDownRight className="h-3 w-3 text-green-500" />
                )}
                <span className="text-xs text-muted-foreground">
                  {formatPercentChange(m.change)} 较7天前
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
