"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { ProgressTrack, ProgressIndicator } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useProviders } from "@/lib/queries/use-providers";
import { formatTokens, statusVariant } from "@/lib/utils";

function quotaColor(pct: number): string {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 70) return "bg-yellow-500";
  return "bg-green-500";
}

export function ProviderOverview() {
  const { data, isLoading, error } = useProviders();
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);

  if (isLoading) {
    return (
      <Card>
        <CardHeader><CardTitle>供应商配额概览</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader><CardTitle>供应商配额概览</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">加载供应商失败</p>
        </CardContent>
      </Card>
    );
  }

  const providers = data?.items ?? [];
  const pageSize = 3;
  const totalPages = Math.max(1, Math.ceil(providers.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const visibleProviders = expanded
    ? providers.slice(safePage * pageSize, safePage * pageSize + pageSize)
    : providers.slice(0, pageSize);
  const visibleStart = providers.length === 0 ? 0 : (expanded ? safePage * pageSize + 1 : 1);
  const visibleEnd = providers.length === 0 ? 0 : visibleStart + visibleProviders.length - 1;
  const hiddenCount = Math.max(providers.length - pageSize, 0);
  const activeCount = providers.filter((provider) => provider.status === "active").length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>供应商配额概览</CardTitle>
            <div className="mt-1 text-sm text-muted-foreground">
              {providers.length === 0 ? "暂无供应商" : `共 ${providers.length} 个供应商，当前展示 ${visibleStart}-${visibleEnd}`}
            </div>
          </div>
          {providers.length > pageSize && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setExpanded((current) => {
                  const next = !current;
                  if (!next) setPage(0);
                  return next;
                });
              }}
            >
              {expanded ? "收起列表" : `展开全部 +${hiddenCount}`}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {providers.length === 0 && (
          <p className="text-sm text-muted-foreground">暂无供应商</p>
        )}
        {providers.length > 0 && (
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="text-xs">{activeCount} active</Badge>
            <Badge variant="outline" className="text-xs">{providers.length - activeCount} inactive</Badge>
            {expanded && totalPages > 1 ? (
              <Badge variant="outline" className="text-xs">第 {safePage + 1} / {totalPages} 页</Badge>
            ) : null}
          </div>
        )}
        {visibleProviders.map((p) => {
          const pct = p.total_quota > 0 ? (p.used_quota / p.total_quota) * 100 : 0;
          return (
            <div key={p.id} className="space-y-1.5 rounded-xl border border-border/60 bg-card/40 px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex items-center gap-2">
                  <Badge variant={statusVariant(p.status)} className="text-xs">{p.status}</Badge>
                  <span className="truncate font-medium">{p.name}</span>
                </div>
                <div className="shrink-0 rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-[11px] text-muted-foreground">
                  {p.provider_type} · P{p.priority}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <ProgressPrimitive.Root value={Math.min(pct, 100)} className="flex flex-1">
                  <ProgressTrack className="h-2">
                    <ProgressIndicator className={quotaColor(pct)} />
                  </ProgressTrack>
                </ProgressPrimitive.Root>
                <span className="w-12 text-right font-mono text-[11px] text-muted-foreground">
                  {pct.toFixed(0)}%
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span>已用 {formatTokens(p.used_quota)}</span>
                <span>总量 {formatTokens(p.total_quota)}</span>
                <span>使用率 {pct.toFixed(0)}%</span>
              </div>
            </div>
          );
        })}
        {expanded && totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-border/70 pt-3">
            <div className="text-xs text-muted-foreground">
              第 {safePage + 1} / {totalPages} 页
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={safePage === 0}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
              >
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
              >
                下一页
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
