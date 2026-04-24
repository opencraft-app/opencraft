"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useTopUsers, useUserStats } from "@/lib/queries/use-stats";
import { getTopUserDetailHref } from "@/lib/queries/top-user-detail-href";
import { getUserStatusLabel } from "@/lib/queries/user-status-label";
import { cn, formatTokens, statusVariant } from "@/lib/utils";

export function UserOverview() {
  const { data, isLoading, error } = useUserStats();
  const topUsers = useTopUsers(5, 7);

  if (isLoading) return <Skeleton className="h-40" />;

  if (error) {
    return (
      <Card>
        <CardContent className="py-4">
          <p className="text-sm text-destructive">加载用户统计失败</p>
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const activeRate = data.total > 0 ? (data.active / data.total) * 100 : 0;
  const users = topUsers.data?.items ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm font-medium">用户概览</CardTitle>
            <div className="mt-1 text-sm text-muted-foreground">首页仅展示近 7 天 top 用量用户</div>
          </div>
          <Link
            href="/users"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            查看全部用户
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-4 text-sm">
          <span>总计: <strong>{data.total}</strong></span>
          <span className="text-green-500">活跃: {data.active}</span>
          <span className="text-muted-foreground">已禁用: {data.disabled}</span>
          <span className="text-yellow-500">已过期: {data.expired}</span>
        </div>
        <div className="flex items-center gap-3">
          <Progress value={activeRate} className="flex-1" />
          <span className="text-sm font-medium">{activeRate.toFixed(0)}% 活跃</span>
        </div>
        <div className="space-y-2 border-t border-border/70 pt-3">
          {topUsers.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-12 w-full rounded-xl" />
              ))}
            </div>
          ) : topUsers.error ? (
            <p className="text-sm text-muted-foreground">Top 用量用户暂时不可用</p>
          ) : users.length === 0 ? (
            <p className="text-sm text-muted-foreground">近 7 天暂无用户用量数据</p>
          ) : (
            users.map((user, index) => {
              const detailHref = getTopUserDetailHref(user);
              const displayName = user.nickname?.trim() || user.user_id;

              return (
                <div key={user.id} className="flex items-center justify-between rounded-xl border border-border/70 bg-card/70 px-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-muted-foreground">#{index + 1}</span>
                      {detailHref ? (
                        <Link href={detailHref} className="truncate font-medium hover:underline">
                          {displayName}
                        </Link>
                      ) : (
                        <span className="truncate font-medium">{displayName}</span>
                      )}
                      <Badge variant={statusVariant(user.status)} className="text-[10px]">
                        {getUserStatusLabel(user.status)}
                      </Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {user.user_id}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold">{formatTokens(user.total_tokens)}</div>
                    <div className="text-xs text-muted-foreground">{user.total_interactions} 次交互</div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}
