"use client";

import { useState } from "react";
import { use } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Copy, Check, Plus, Trash2, AlertTriangle, Gem, CalendarClock, WalletCards } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import {
  useUser,
  useUserSubscriptions,
  useUserApiKeys,
  useUserUsage,
  useUserUsageLogs,
  useAdjustTokens,
  useCreateApiKey,
  useCancelSubscription,
} from "@/lib/queries/use-users";
import { useRevokeApiKey } from "@/lib/queries/use-api-keys";
import { DEFAULT_API_KEY_STATUS_FILTER, type ApiKeyStatusFilter } from "@/lib/queries/api-key-status-filter";
import { getApiKeyStatusLabel } from "@/lib/queries/api-key-status-label";
import {
  getUsageLogsStateForRangeChange,
  getUserUsageLogsColumns,
  getUserUsageLogsRangeLabel,
  type UserUsageLogsFilters,
  type UserUsageLogsRange,
} from "@/lib/queries/user-usage-logs-query";
import { getUserStatusLabel } from "@/lib/queries/user-status-label";
import { ensureItems, ensureUsageLogsSummary } from "@/lib/page-null-guards";
import { formatTokens, formatDate, formatDateTime, formatNumber, statusVariant } from "@/lib/utils";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

export default function UserDetailPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = use(params);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [tokenDelta, setTokenDelta] = useState("");
  const [newKeyResult, setNewKeyResult] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [cancelSub, setCancelSub] = useState(false);
  const [copied, setCopied] = useState(false);
  const [apiKeyStatusFilter, setApiKeyStatusFilter] = useState<ApiKeyStatusFilter>(DEFAULT_API_KEY_STATUS_FILTER);
  const [showTechnicalFields, setShowTechnicalFields] = useState(false);
  const [usageLogsFilters, setUsageLogsFilters] = useState<UserUsageLogsFilters>({
    range: "7d",
    start: "",
    end: "",
    page: 1,
    pageSize: 20,
  });

  const user = useUser(userId);
  const subs = useUserSubscriptions(userId);
  const keys = useUserApiKeys(user.data?.user_id ?? "", apiKeyStatusFilter);
  const usage = useUserUsage(userId);
  const usageLogs = useUserUsageLogs(userId, usageLogsFilters);
  const adjustTokens = useAdjustTokens();
  const createKey = useCreateApiKey();
  const revokeKey = useRevokeApiKey();
  const cancelSubscription = useCancelSubscription();

  const activeSub = subs.data?.items?.find((s) => s.status === "active");
  const currentBalance = activeSub?.token_balance ?? 0;
  const delta = parseInt(tokenDelta) || 0;
  const newBalance = currentBalance + delta;
  const usageLogItems = ensureItems(usageLogs.data?.items);
  const usageLogSummary = ensureUsageLogsSummary(usageLogs.data?.summary);
  const usageLogTotal = usageLogs.data?.total ?? 0;
  const usageLogPage = usageLogs.data?.page ?? 1;
  const usageLogPageSize = usageLogs.data?.page_size ?? usageLogsFilters.pageSize;

  async function handleAdjustTokens() {
    if (!activeSub || delta === 0) return;
    try {
      await adjustTokens.mutateAsync({ subscriptionId: activeSub.id, delta });
      toast.success("Token 余额已调整");
      setTokenDialogOpen(false);
      setTokenDelta("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "调整 Token 失败");
    }
  }

  async function handleCreateKey() {
    try {
      const result = await createKey.mutateAsync(user.data?.user_id ?? "");
      setNewKeyResult(result.api_key);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建 API Key 失败");
    }
  }

  async function handleRevokeKey() {
    if (!revokeTarget) return;
    try {
      await revokeKey.mutateAsync(revokeTarget);
      toast.success("API Key 已撤销");
      setRevokeTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "撤销密钥失败");
    }
  }

  async function handleCancelSubscription() {
    try {
      await cancelSubscription.mutateAsync(userId);
      toast.success("订阅已取消");
      setCancelSub(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "取消订阅失败");
    }
  }

  function copyKey() {
    if (newKeyResult) {
      navigator.clipboard.writeText(newKeyResult);
      setCopied(true);
      toast.success("已复制");
      setTimeout(() => setCopied(false), 2000);
    }
  }

  if (user.isLoading) {
    return <div className="space-y-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-32" />)}</div>;
  }

  if (!user.data) {
    return <p className="text-muted-foreground">用户不存在</p>;
  }

  const u = user.data;
  const externalUid = u.user_id || "";
  const activePlanName = u.plan?.name ?? u.current_plan ?? "未订阅";
  const monthlyTokens = u.plan?.monthly_tokens;
  const isUnlimitedPlan = monthlyTokens === 0;
  const planQuotaLabel = isUnlimitedPlan ? "无限额度" : monthlyTokens ? `${formatTokens(monthlyTokens)}/月` : "已生效";
  const balanceDisplay = isUnlimitedPlan ? "∞" : formatTokens(activeSub?.token_balance ?? 0);
  const balanceCaption = isUnlimitedPlan
    ? "当前套餐不受 token 配额限制"
    : `${formatNumber(activeSub?.token_balance ?? 0)} tokens 剩余`;
  const pageTitle = u.nickname?.trim() && u.nickname.trim() !== externalUid
    ? `${u.nickname} (${externalUid || u.id})`
    : (externalUid || u.id);
  const apiKeyStatusOptions: Array<{ value: ApiKeyStatusFilter; label: string }> = [
    { value: "active", label: getApiKeyStatusLabel("active") },
    { value: "revoked", label: getApiKeyStatusLabel("revoked") },
    { value: "all", label: getApiKeyStatusLabel("all") },
  ];
  const selectedApiKeyStatusLabel = getApiKeyStatusLabel(apiKeyStatusFilter);
  const usageLogColumns = getUserUsageLogsColumns(showTechnicalFields);
  const totalUsageLogPages = Math.max(1, Math.ceil(usageLogTotal / usageLogPageSize));
  const needsCustomRange = usageLogsFilters.range === "custom" && (!usageLogsFilters.start || !usageLogsFilters.end);

  return (
    <div className="space-y-6">
      <PageHeader
        title={pageTitle}
        description={`网关用户 ID：${u.id}`}
      />

      {/* User Info */}
      <Card>
        <CardHeader><CardTitle>用户信息</CardTitle></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 text-sm">
          <div className="sm:col-span-2">
            <span className="text-muted-foreground">网关用户 ID：</span>
            <code className="ml-1 font-mono text-xs">{u.id}</code>
          </div>
          {externalUid ? (
            <div className="sm:col-span-2">
              <span className="text-muted-foreground">用户 ID：</span>
              <code className="ml-1 font-mono text-xs">{externalUid}</code>
            </div>
          ) : null}
          <div><span className="text-muted-foreground">状态：</span> <Badge variant={statusVariant(u.status)}>{getUserStatusLabel(u.status)}</Badge></div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">当前套餐：</span>
            <strong>{activePlanName}</strong>
            {activeSub ? (
              <Badge variant="outline" className="text-xs">
                {planQuotaLabel}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-xs text-muted-foreground">
                无活跃订阅
              </Badge>
            )}
          </div>
          <div><span className="text-muted-foreground">创建时间：</span> {formatDateTime(u.created_at)}</div>
        </CardContent>
      </Card>

      {/* Subscription */}
      {activeSub && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>活跃订阅</CardTitle>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setTokenDialogOpen(true)}>
                调整 Token
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setCancelSub(true)}
              >
                取消订阅
              </Button>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <div className="rounded-2xl border border-border/70 bg-gradient-to-br from-muted/60 via-card to-card p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-3">
                  <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground">
                    <Gem className="h-3.5 w-3.5" />
                    当前生效套餐
                  </div>
                  <div className="space-y-2">
                    <div className="text-xl font-semibold tracking-tight">{activePlanName}</div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className="rounded-full px-2.5 py-0.5 text-xs">
                        {planQuotaLabel}
                      </Badge>
                      <Badge variant={statusVariant(activeSub.status)} className="rounded-full px-2.5 py-0.5 text-xs">
                        {activeSub.status === "active" ? "活跃中" : activeSub.status}
                      </Badge>
                    </div>
                  </div>
                </div>
                <div className="rounded-2xl border border-border/60 bg-background/70 p-3 text-right">
                  <div className="text-xs text-muted-foreground">Token 余额</div>
                  <div className="mt-1 text-3xl font-semibold tracking-tight">{balanceDisplay}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{isUnlimitedPlan ? "无限额度" : "剩余可用"}</div>
                </div>
              </div>
              <div className="mt-4 grid gap-3 border-t border-border/60 pt-4 sm:grid-cols-3">
                <div className="rounded-xl border border-border/60 bg-background/40 p-3">
                  <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <CalendarClock className="h-3.5 w-3.5" />
                    到期时间
                  </div>
                  <div className="mt-2 text-base font-semibold text-foreground">{formatDate(activeSub.period_end)}</div>
                  <div className="mt-1 text-xs text-muted-foreground">订阅有效期截止</div>
                </div>
                <div className="rounded-xl border border-border/60 bg-background/40 p-3">
                  <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <WalletCards className="h-3.5 w-3.5" />
                    配额模式
                  </div>
                  <div className="mt-2 text-base font-semibold text-foreground">{planQuotaLabel}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{isUnlimitedPlan ? "按无限额度使用" : "当前套餐月度额度"}</div>
                </div>
                <div className="rounded-xl border border-border/60 bg-background/40 p-3">
                  <div className="text-xs text-muted-foreground">订阅状态</div>
                  <div className="mt-2">
                    <Badge variant={statusVariant(activeSub.status)} className="rounded-full px-2.5 py-0.5 text-xs">
                      {activeSub.status === "active" ? "活跃中" : activeSub.status === "expired" ? "已过期" : activeSub.status === "cancelled" ? "已取消" : activeSub.status}
                    </Badge>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">当前订阅生命周期状态</div>
                </div>
              </div>
            </div>
            <div className="grid gap-3 content-start">
              <div className="rounded-2xl border border-border/70 bg-card/80 p-5">
                <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Balance</div>
                <div className="mt-3 text-4xl font-semibold tracking-tight">{balanceDisplay}</div>
                <div className="mt-2 text-sm text-muted-foreground">{balanceCaption}</div>
              </div>
              <div className="rounded-2xl border border-border/70 bg-card/80 p-5">
                <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Subscription</div>
                <div className="mt-3 text-base font-semibold">{activePlanName}</div>
                <div className="mt-2 space-y-1.5 text-sm text-muted-foreground">
                  <div>额度规则：{planQuotaLabel}</div>
                  <div>到期时间：{formatDate(activeSub.period_end)}</div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* API Keys */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>API Key 列表</CardTitle>
          <div className="flex items-center gap-2">
            <Select
              value={apiKeyStatusFilter}
              onValueChange={(value) => {
                if (!value) return;
                setApiKeyStatusFilter(value);
              }}
            >
              <SelectTrigger className="w-32">
                <SelectValue placeholder="选择状态">
                  {selectedApiKeyStatusLabel}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {apiKeyStatusOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={handleCreateKey} disabled={createKey.isPending}>
              <Plus className="mr-1 h-4 w-4" /> 创建密钥
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {keys.isLoading && <Skeleton className="h-20" />}
          {keys.data?.items?.length === 0 && (
            <p className="text-sm text-muted-foreground">暂无 API Key</p>
          )}
          <div className="space-y-2">
            {keys.data?.items?.map((k) => (
              <div key={k.id} className="flex items-center justify-between rounded-md border p-3">
                <div className="text-sm">
                  <code className="font-mono">{k.key_prefix}...</code>
                  <span className="ml-2 text-muted-foreground">{formatDateTime(k.created_at)}</span>
                  {k.last_used_at && (
                    <span className="ml-2 text-muted-foreground">最后使用: {formatDateTime(k.last_used_at)}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={statusVariant(k.status)}>{k.status === "active" ? "活跃" : k.status === "revoked" ? "已撤销" : k.status}</Badge>
                  {k.status === "active" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setRevokeTarget(k.id)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Usage Chart */}
      {usage.data && (
        <Card>
          <CardHeader><CardTitle>使用量（近 7 天）</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={usage.data!.daily}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="date"
                  className="text-muted-foreground"
                  fontSize={12}
                  tickFormatter={(v) => v.slice(5)}
                  tick={{ fill: "currentColor" }}
                  axisLine={{ stroke: "currentColor", opacity: 0.35 }}
                />
                <YAxis
                  className="text-muted-foreground"
                  fontSize={12}
                  tickFormatter={formatTokens}
                  tick={{ fill: "currentColor" }}
                  axisLine={{ stroke: "currentColor", opacity: 0.35 }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--card)",
                    border: "1px solid var(--border)",
                    borderRadius: "6px",
                    color: "var(--card-foreground)",
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="total_tokens"
                  stroke="var(--chart-1)"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1">
              <CardTitle>Token 消耗证据清单</CardTitle>
              <p className="text-sm text-muted-foreground">
                以下为原始请求用量记录，不含内部计费折算逻辑。
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:items-end">
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={usageLogsFilters.range}
                  onValueChange={(value) => {
                    if (!value) return;
                    setUsageLogsFilters((current) => getUsageLogsStateForRangeChange(current, value as UserUsageLogsRange));
                  }}
                >
                  <SelectTrigger className="w-36">
                    <SelectValue placeholder="选择范围" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7d">近 7 天</SelectItem>
                    <SelectItem value="30d">近 30 天</SelectItem>
                    <SelectItem value="custom">自定义</SelectItem>
                  </SelectContent>
                </Select>
                {usageLogsFilters.range === "custom" ? (
                  <>
                    <Input
                      type="date"
                      value={usageLogsFilters.start}
                      onChange={(e) => setUsageLogsFilters((current) => ({
                        ...current,
                        start: e.target.value,
                        page: 1,
                      }))}
                      className="w-40"
                    />
                    <Input
                      type="date"
                      value={usageLogsFilters.end}
                      onChange={(e) => setUsageLogsFilters((current) => ({
                        ...current,
                        end: e.target.value,
                        page: 1,
                      }))}
                      className="w-40"
                    />
                  </>
                ) : null}
              </div>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Switch
                  checked={showTechnicalFields}
                  onCheckedChange={setShowTechnicalFields}
                />
                展开技术字段
              </label>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">当前范围</div>
              <div className="mt-1 font-medium">{getUserUsageLogsRangeLabel(usageLogsFilters)}</div>
            </div>
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">请求总数</div>
              <div className="mt-1 font-medium">{formatNumber(usageLogSummary.total_requests)}</div>
            </div>
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">原始 Token 总量</div>
              <div className="mt-1 font-medium">{formatNumber(usageLogSummary.total_tokens)}</div>
            </div>
          </div>

          {needsCustomRange ? (
            <p className="text-sm text-muted-foreground">请选择完整的开始日期和结束日期以查看自定义范围记录。</p>
          ) : null}

          {usageLogs.isLoading ? <Skeleton className="h-48" /> : null}

          {!needsCustomRange && !usageLogs.isLoading && usageLogItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">当前范围内暂无原始 usage 记录。</p>
          ) : null}

          {!needsCustomRange && usageLogItems.length > 0 ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    {usageLogColumns.map((column) => (
                      <TableHead key={column}>{column}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usageLogItems.map((item) => (
                    <TableRow key={`${item.request_id}-${item.created_at}`}>
                      <TableCell>{formatDateTime(item.created_at)}</TableCell>
                      <TableCell>{item.model}</TableCell>
                      <TableCell>1</TableCell>
                      <TableCell>{formatNumber(item.prompt_tokens)}</TableCell>
                      <TableCell>{formatNumber(item.completion_tokens)}</TableCell>
                      <TableCell>{formatNumber(item.total_tokens)}</TableCell>
                      <TableCell className="max-w-52 truncate font-mono text-xs">{item.request_id || "-"}</TableCell>
                      {showTechnicalFields ? (
                        <>
                          <TableCell>{item.status_code}</TableCell>
                          <TableCell>{formatNumber(item.latency_ms)} ms</TableCell>
                          <TableCell>{item.source || "-"}</TableCell>
                        </>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="flex flex-col gap-3 border-t pt-4 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="text-muted-foreground">
                  第 {usageLogPage} / {totalUsageLogPages} 页，共 {formatNumber(usageLogTotal)} 条
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={usageLogsFilters.page <= 1 || usageLogs.isFetching}
                    onClick={() => setUsageLogsFilters((current) => ({
                      ...current,
                      page: current.page - 1,
                    }))}
                  >
                    上一页
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={usageLogsFilters.page >= totalUsageLogPages || usageLogs.isFetching}
                    onClick={() => setUsageLogsFilters((current) => ({
                      ...current,
                      page: current.page + 1,
                    }))}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* Token Adjustment Dialog */}
      <Dialog open={tokenDialogOpen} onOpenChange={setTokenDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>调整 Token 余额</DialogTitle>
            <DialogDescription>
              输入正数增加 Token，输入负数减少 Token。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Input
              type="number"
              placeholder="例如：+50000 或 -10000"
              value={tokenDelta}
              onChange={(e) => setTokenDelta(e.target.value)}
            />
            {delta !== 0 && (
              <p className="text-sm">
                余额: {formatNumber(currentBalance)} → <strong>{formatNumber(newBalance)}</strong>
                {" "}({delta > 0 ? "+" : ""}{formatNumber(delta)})
              </p>
            )}
            {newBalance < 0 && (
              <p className="text-sm text-destructive">调整后余额不能为负数</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTokenDialogOpen(false)}>取消</Button>
            <Button
              onClick={handleAdjustTokens}
              disabled={delta === 0 || newBalance < 0 || adjustTokens.isPending}
            >
              {adjustTokens.isPending ? "调整中..." : "确认"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Key Result Dialog */}
      <Dialog open={!!newKeyResult} onOpenChange={(open) => !open && setNewKeyResult(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API Key 已创建</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-md border p-3">
              <code className="text-sm font-mono break-all">{newKeyResult}</code>
              <Button variant="ghost" size="icon" onClick={copyKey}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <div className="flex items-center gap-1 text-xs text-yellow-500">
              <AlertTriangle className="h-3 w-3" />
              <span>此密钥仅显示一次，请立即复制保存。</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Revoke Key Confirm */}
      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title="撤销 API Key"
        description="此操作将永久停用该 API Key。使用此密钥的应用将无法继续工作。"
        confirmLabel="撤销"
        variant="destructive"
        onConfirm={handleRevokeKey}
        loading={revokeKey.isPending}
      />

      {/* Cancel Subscription Confirm */}
      <ConfirmDialog
        open={cancelSub}
        onOpenChange={setCancelSub}
        title="取消订阅"
        description="确定要取消该用户的活跃订阅吗？取消后用户将无法继续使用 API 服务。"
        confirmLabel="取消订阅"
        variant="destructive"
        onConfirm={handleCancelSubscription}
        loading={cancelSubscription.isPending}
      />
    </div>
  );
}
