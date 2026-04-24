"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useUsageTrend } from "@/lib/queries/use-stats";
import { cn, formatNumber, formatTokens } from "@/lib/utils";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const COLORS = [
  "#60a5fa",
  "#4ade80",
  "#facc15",
  "#fb923c",
  "#f472b6",
];

type UsageTrendPeriod = "7d" | "30d";

const PERIOD_OPTIONS: Array<{ value: UsageTrendPeriod; label: string }> = [
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
];

export function ModelDistribution() {
  const [period, setPeriod] = useState<UsageTrendPeriod>("7d");
  const { data, isLoading, error, refetch } = useUsageTrend(period);
  const selectedPeriod = PERIOD_OPTIONS.find((item) => item.value === period) ?? PERIOD_OPTIONS[0];
  const dailyRows = data?.model_daily_distribution ?? [];
  const modelKeys = Array.from(new Set(dailyRows.map((item) => item.model)));
  const chartRows = (data?.data ?? []).map((point) => {
    const row: Record<string, string | number> = { date: point.date };
    for (const model of modelKeys) {
      row[model] = 0;
    }
    for (const item of dailyRows.filter((entry) => entry.date === point.date)) {
      row[item.model] = item.tokens ?? 0;
    }
    return row;
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle>{selectedPeriod.label}模型使用结构</CardTitle>
            <div className="text-sm text-muted-foreground">
              查看近期 token 消耗主要集中在哪些模型。
            </div>
          </div>
          <Select
            value={period}
            onValueChange={(value) => {
              if (value === "7d" || value === "30d") {
                setPeriod(value);
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-[160px]">
              <SelectValue>{selectedPeriod.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">近 7 天</SelectItem>
              <SelectItem value="30d">近 30 天</SelectItem>
            </SelectContent>
          </Select>
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
        {data && !error && (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div className="min-h-[300px]">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={chartRows} margin={{ top: 12, right: 12, left: 8, bottom: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis
                    dataKey="date"
                    stroke="#a1a1aa"
                    tickLine={false}
                    axisLine={false}
                    interval={0}
                    angle={-12}
                    textAnchor="end"
                    height={48}
                  />
                  <YAxis
                    stroke="#a1a1aa"
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value: number) => formatTokens(value)}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#0f172a",
                      border: "1px solid #334155",
                      borderRadius: "6px",
                      color: "#f8fafc",
                    }}
                    formatter={(value: number) => formatTokens(value)}
                    labelFormatter={(value) => `时间：${value}`}
                  />
                  {modelKeys.map((model, index) => (
                    <Bar
                      key={model}
                      dataKey={model}
                      name={model}
                      stackId="tokens"
                      fill={COLORS[index % COLORS.length]}
                      radius={index === modelKeys.length - 1 ? [6, 6, 0, 0] : [0, 0, 0, 0]}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead className="text-right">消耗</TableHead>
                  <TableHead className="text-right">请求数</TableHead>
                  <TableHead className="text-right">占比</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dailyRows.map((item, index) => {
                  return (
                    <TableRow key={`${item.date}-${item.model}-${index}`}>
                      <TableCell className="font-mono text-xs">{item.date}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span
                            className="size-2 rounded-full"
                            style={{ backgroundColor: COLORS[index % COLORS.length] }}
                          />
                          <span className={cn("font-medium", item.tokens === 0 && "text-muted-foreground")}>
                            {item.model || "未知模型"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">{formatTokens(item.tokens ?? 0)}</TableCell>
                      <TableCell className="text-right">{formatNumber(item.requests ?? 0)}</TableCell>
                      <TableCell className={cn("text-right", item.share === 0 && "text-muted-foreground")}>
                        {(item.share ?? 0).toFixed(1)}%
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
