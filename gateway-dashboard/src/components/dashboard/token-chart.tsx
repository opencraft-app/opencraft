"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useUsageTrend } from "@/lib/queries/use-stats";
import { formatTokens } from "@/lib/utils";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

export function TokenChart() {
  const [period, setPeriod] = useState<"7d" | "30d">("7d");
  const [metric, setMetric] = useState<"interactions" | "tokens">("interactions");
  const { data, isLoading, error, refetch } = useUsageTrend(period);
  const dataKey = metric === "interactions" ? "total_interactions" : "total_tokens";
  const title = metric === "interactions" ? "交互次数趋势" : "Token消耗趋势";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="space-y-1">
          <CardTitle>{title}</CardTitle>
          <div className="text-sm text-muted-foreground">
            默认优先看交互走势，必要时再切换到 Token 消耗。
          </div>
        </div>
        <div className="flex gap-3">
          <div className="flex gap-1">
            <Button
              variant={metric === "interactions" ? "default" : "ghost"}
              size="sm"
              onClick={() => setMetric("interactions")}
            >
              交互
            </Button>
            <Button
              variant={metric === "tokens" ? "default" : "ghost"}
              size="sm"
              onClick={() => setMetric("tokens")}
            >
              Token
            </Button>
          </div>
          <div className="flex gap-1">
            <Button
              variant={period === "7d" ? "default" : "ghost"}
              size="sm"
              onClick={() => setPeriod("7d")}
            >
              7d
            </Button>
            <Button
              variant={period === "30d" ? "default" : "ghost"}
              size="sm"
              onClick={() => setPeriod("30d")}
            >
              30d
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && <Skeleton className="h-[300px]" />}
        {error && (
          <div className="flex flex-col items-center justify-center h-[300px] gap-2">
            <p className="text-sm text-destructive">加载图表数据失败</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              重试
            </Button>
          </div>
        )}
        {data && (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data.data}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis
                dataKey="date"
                className="text-muted-foreground"
                fontSize={12}
                tickFormatter={(v) => v.slice(5)}
                tick={{ fill: "currentColor" }}
                axisLine={{ stroke: "currentColor", opacity: 0.3 }}
              />
              <YAxis
                className="text-muted-foreground"
                fontSize={12}
                tickFormatter={metric === "interactions" ? (value) => `${value}` : formatTokens}
                tick={{ fill: "currentColor" }}
                axisLine={{ stroke: "currentColor", opacity: 0.3 }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(222.2 84% 4.9%)",
                  border: "1px solid hsl(217.2 32.6% 17.5%)",
                  borderRadius: "6px",
                  color: "hsl(210 40% 98%)",
                }}
                formatter={(value: number) =>
                  metric === "interactions"
                    ? [value, "交互次数"]
                    : [formatTokens(value), "Token"]
                }
              />
              <Line
                type="monotone"
                dataKey={dataKey}
                stroke="hsl(217.2 91.2% 59.8%)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
