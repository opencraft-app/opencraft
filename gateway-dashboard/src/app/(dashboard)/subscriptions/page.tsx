"use client";

import { useCallback, useMemo, useState } from "react";
import { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, RefreshCw, ScrollText, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { DataTable } from "@/components/shared/data-table";
import { PageHeader } from "@/components/shared/page-header";
import {
  type SubscriptionAdminPlan,
  type SubscriptionAdminRecord,
  useSubscriptionAdminCancel,
  useSubscriptionAdminDeletePlan,
  useSubscriptionAdminEvents,
  useSubscriptionAdminPlans,
  useSubscriptionAdminResync,
  useSubscriptionAdminSet,
  useSubscriptionAdminSubscriptions,
  useSubscriptionAdminUpsertPlan,
} from "@/lib/queries/use-subscription-admin";
import { ensureItems } from "@/lib/page-null-guards";
import { formatDateTime, statusVariant } from "@/lib/utils";

function planLabel(code: string) {
  if (!code) return "—";
  return code.toUpperCase();
}

export default function SubscriptionsPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [code, setCode] = useState<string>("all");
  const [setTarget, setSetTarget] = useState<SubscriptionAdminRecord | null>(null);
  const [setCodeValue, setSetCodeValue] = useState<string>("");
  const [cancelTarget, setCancelTarget] = useState<SubscriptionAdminRecord | null>(null);
  const [eventTarget, setEventTarget] = useState<SubscriptionAdminRecord | null>(null);
  const [planEditorOpen, setPlanEditorOpen] = useState(false);
  const [planEditorTarget, setPlanEditorTarget] = useState<SubscriptionAdminPlan | null>(null);
  const [planCodeValue, setPlanCodeValue] = useState("");
  const [planDescriptionValue, setPlanDescriptionValue] = useState("");
  const [planMaxBotCountValue, setPlanMaxBotCountValue] = useState("0");
  const [deletePlanTarget, setDeletePlanTarget] = useState<SubscriptionAdminPlan | null>(null);

  const plans = useSubscriptionAdminPlans();
  const planItems = plans.data?.items ?? [];
  const { data, isLoading } = useSubscriptionAdminSubscriptions(
    search || undefined,
    status === "all" ? undefined : status,
    code === "all" ? undefined : code,
    200
  );
  const events = useSubscriptionAdminEvents(eventTarget?.externalUserId, 100);
  const eventItems = ensureItems(events.data?.items);
  const setSubscription = useSubscriptionAdminSet();
  const resyncSubscription = useSubscriptionAdminResync();
  const cancelSubscription = useSubscriptionAdminCancel();
  const upsertPlan = useSubscriptionAdminUpsertPlan();
  const deletePlan = useSubscriptionAdminDeletePlan();

  function openPlanEditor(plan?: SubscriptionAdminPlan) {
    setPlanEditorOpen(true);
    setPlanEditorTarget(plan ?? null);
    setPlanCodeValue(plan?.code ?? "");
    setPlanDescriptionValue(plan?.description ?? "");
    setPlanMaxBotCountValue(String(plan?.maxBotCount ?? 0));
  }

  async function handleSetSubscription() {
    if (!setTarget) {
      return;
    }
    try {
      await setSubscription.mutateAsync({
        externalUserId: setTarget.externalUserId,
        code: setCodeValue,
      });
      toast.success("订阅已更新");
      setSetTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新订阅失败");
    }
  }

  async function handleCancelSubscription() {
    if (!cancelTarget) {
      return;
    }
    try {
      await cancelSubscription.mutateAsync(cancelTarget.externalUserId);
      toast.success("订阅已取消");
      setCancelTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "取消订阅失败");
    }
  }

  const handleResyncSubscription = useCallback(async (record: SubscriptionAdminRecord) => {
    try {
      await resyncSubscription.mutateAsync(record.externalUserId);
      toast.success("已重新同步到 AI Gateway");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重同步失败");
    }
  }, [resyncSubscription]);

  async function handleSavePlan() {
    const normalizedCode = planCodeValue.trim().toLowerCase();
    const maxBotCount = Number(planMaxBotCountValue);
    if (!normalizedCode) {
      toast.error("套餐 code 不能为空");
      return;
    }
    if (!Number.isInteger(maxBotCount) || maxBotCount < 0) {
      toast.error("最大 Bot 数量必须是大于等于 0 的整数");
      return;
    }
    try {
      await upsertPlan.mutateAsync({
        code: normalizedCode,
        description: planDescriptionValue.trim(),
        maxBotCount,
      });
      toast.success(planEditorTarget ? "套餐已更新" : "套餐已创建");
      setPlanEditorOpen(false);
      setPlanEditorTarget(null);
      setPlanCodeValue("");
      setPlanDescriptionValue("");
      setPlanMaxBotCountValue("0");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存套餐失败");
    }
  }

  async function handleDeletePlan() {
    if (!deletePlanTarget) {
      return;
    }
    try {
      await deletePlan.mutateAsync(deletePlanTarget.code);
      toast.success("套餐已删除");
      setDeletePlanTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除套餐失败");
    }
  }

  const subscriptionColumns = useMemo<ColumnDef<SubscriptionAdminRecord>[]>(
    () => [
      {
        accessorKey: "externalUserId",
        header: "用户 ID",
        cell: ({ row }) => (
          <code className="font-mono text-xs">{row.original.externalUserId}</code>
        ),
      },
      {
        accessorKey: "code",
        header: "套餐",
        cell: ({ row }) => <Badge variant="outline">{planLabel(row.original.code)}</Badge>,
      },
      {
        accessorKey: "status",
        header: "状态",
        cell: ({ row }) => (
          <Badge variant={statusVariant(row.original.status)}>
            {row.original.status}
          </Badge>
        ),
      },
      {
        accessorKey: "currentPeriodStart",
        header: "生效时间",
        cell: ({ row }) =>
          row.original.currentPeriodStart ? formatDateTime(row.original.currentPeriodStart) : "—",
      },
      {
        accessorKey: "currentPeriodEnd",
        header: "到期时间",
        cell: ({ row }) =>
          row.original.currentPeriodEnd ? formatDateTime(row.original.currentPeriodEnd) : "—",
      },
      {
        accessorKey: "sourceOrderId",
        header: "来源",
        cell: ({ row }) =>
          row.original.sourceOrderId ? (
            <code className="font-mono text-[11px]">{row.original.sourceOrderId}</code>
          ) : (
            "—"
          ),
      },
      {
        accessorKey: "aiGatewaySubscriptionId",
        header: "AI Gateway 副本",
        cell: ({ row }) =>
          row.original.aiGatewaySubscriptionId ? (
            <code className="font-mono text-[11px]">{row.original.aiGatewaySubscriptionId}</code>
          ) : (
            "—"
          ),
      },
      {
        accessorKey: "updatedAt",
        header: "更新时间",
        cell: ({ row }) => formatDateTime(row.original.updatedAt),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon" />}
            >
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => {
                  setSetTarget(row.original);
                  setSetCodeValue(row.original.code);
                }}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                修改套餐
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleResyncSubscription(row.original)}>
                <RefreshCw className="mr-2 h-4 w-4" />
                重同步
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setEventTarget(row.original)}>
                <ScrollText className="mr-2 h-4 w-4" />
                查看事件
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setCancelTarget(row.original)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                取消订阅
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [handleResyncSubscription]
  );

  const planColumns = useMemo<ColumnDef<SubscriptionAdminPlan>[]>(
    () => [
      {
        accessorKey: "code",
        header: "套餐 code",
        cell: ({ row }) => <Badge variant="outline">{row.original.code}</Badge>,
      },
      {
        accessorKey: "description",
        header: "描述",
        cell: ({ row }) => (
          <div className="max-w-[420px] whitespace-pre-wrap text-sm">{row.original.description || "—"}</div>
        ),
      },
      {
        accessorKey: "maxBotCount",
        header: "最大 Bot 数量",
      },
      {
        accessorKey: "updatedAt",
        header: "更新时间",
        cell: ({ row }) => formatDateTime(row.original.updatedAt),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon" />}
            >
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => openPlanEditor(row.original)}>
                <RefreshCw className="mr-2 h-4 w-4" />
                编辑套餐
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDeletePlanTarget(row.original)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                删除套餐
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    []
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="业务订阅"
        description="subscription 服务现在同时管理套餐目录和用户当前订阅，作为订阅真相源。"
      />

      <Card>
        <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <CardTitle>套餐目录</CardTitle>
            <CardDescription>维护业务套餐定义：code、描述和最大可创建 Bot 数量。</CardDescription>
          </div>
          <Button onClick={() => openPlanEditor()}>
            新建套餐
          </Button>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={planColumns}
            data={planItems}
            total={planItems.length}
            isLoading={plans.isLoading}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>当前订阅</CardTitle>
          <CardDescription>按用户查看订阅当前态，以及同步到 AI Gateway 的权益副本。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-wrap gap-3">
            <Input
              placeholder="按用户 ID / code / status 搜索"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="max-w-md"
            />
            <Select value={status} onValueChange={(value) => setStatus(value ?? "all")}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="订阅状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="active">active</SelectItem>
                <SelectItem value="cancelled">cancelled</SelectItem>
                <SelectItem value="expired">expired</SelectItem>
                <SelectItem value="pending_payment">pending_payment</SelectItem>
              </SelectContent>
            </Select>
            <Select value={code} onValueChange={(value) => setCode(value ?? "all")}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="套餐类型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部套餐</SelectItem>
                {planItems.map((plan) => (
                  <SelectItem key={plan.code} value={plan.code}>
                    {planLabel(plan.code)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DataTable
            columns={subscriptionColumns}
            data={data?.items ?? []}
            total={data?.total ?? 0}
            isLoading={isLoading}
          />
        </CardContent>
      </Card>

      <Dialog open={!!setTarget} onOpenChange={(open) => !open && setSetTarget(null)}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>修改订阅套餐</DialogTitle>
            <DialogDescription>
              直接修改 {setTarget?.externalUserId} 的业务订阅，并同步到 AI Gateway。
            </DialogDescription>
          </DialogHeader>
          <Select value={setCodeValue} onValueChange={(value) => setSetCodeValue(value ?? "")}>
            <SelectTrigger>
              <SelectValue placeholder={planItems.length ? "选择套餐" : "请先创建套餐目录"} />
            </SelectTrigger>
            <SelectContent>
              {planItems.map((plan) => (
                <SelectItem key={plan.code} value={plan.code}>
                  {planLabel(plan.code)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSetTarget(null)}>
              取消
            </Button>
            <Button
              onClick={handleSetSubscription}
              disabled={setSubscription.isPending || !setCodeValue}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={planEditorOpen} onOpenChange={(open) => {
        setPlanEditorOpen(open);
        if (!open) {
          setPlanEditorTarget(null);
          setPlanCodeValue("");
          setPlanDescriptionValue("");
          setPlanMaxBotCountValue("0");
        }
      }}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{planEditorTarget ? "编辑套餐" : "新建套餐"}</DialogTitle>
            <DialogDescription>
              这里维护 subscription 服务自己的套餐目录。AI Gateway 只保留下游权益副本。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="plan-code">套餐 code</Label>
              <Input
                id="plan-code"
                value={planCodeValue}
                disabled={!!planEditorTarget}
                onChange={(event) => setPlanCodeValue(event.target.value)}
                placeholder="free / lite / pro"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="plan-description">描述</Label>
              <Textarea
                id="plan-description"
                value={planDescriptionValue}
                onChange={(event) => setPlanDescriptionValue(event.target.value)}
                placeholder="用于后台说明和运营识别"
                rows={4}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="plan-max-bots">最大 Bot 数量</Label>
              <Input
                id="plan-max-bots"
                type="number"
                min={0}
                value={planMaxBotCountValue}
                onChange={(event) => setPlanMaxBotCountValue(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPlanEditorOpen(false);
                setPlanEditorTarget(null);
                setPlanCodeValue("");
                setPlanDescriptionValue("");
                setPlanMaxBotCountValue("0");
              }}
            >
              取消
            </Button>
            <Button onClick={handleSavePlan} disabled={upsertPlan.isPending}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!eventTarget} onOpenChange={(open) => !open && setEventTarget(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>订阅事件</DialogTitle>
            <DialogDescription>
              {eventTarget?.externalUserId} 的 subscription_events 时间线。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[420px] space-y-3 overflow-y-auto">
            {events.isLoading ? (
              <div className="text-sm text-muted-foreground">加载中...</div>
            ) : eventItems.length > 0 ? (
              eventItems.map((event) => (
                <div key={event.id} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{event.eventType}</Badge>
                      <Badge variant={statusVariant(event.status)}>{event.status}</Badge>
                      <Badge variant="secondary">{event.code}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatDateTime(event.createdAt)}
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    subscriptionId: <code>{event.subscriptionId}</code>
                  </div>
                  {event.sourceOrderId ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      source: <code>{event.sourceOrderId}</code>
                    </div>
                  ) : null}
                </div>
              ))
            ) : (
              <div className="text-sm text-muted-foreground">暂无事件</div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!cancelTarget}
        onOpenChange={(open) => !open && setCancelTarget(null)}
        title="取消订阅"
        description={`确认取消 ${cancelTarget?.externalUserId ?? ""} 的当前订阅？这会同时尝试取消 AI Gateway 侧的权益副本。`}
        confirmLabel="取消订阅"
        variant="destructive"
        onConfirm={handleCancelSubscription}
        loading={cancelSubscription.isPending}
      />

      <ConfirmDialog
        open={!!deletePlanTarget}
        onOpenChange={(open) => !open && setDeletePlanTarget(null)}
        title="删除套餐"
        description={`确认删除套餐 ${deletePlanTarget?.code ?? ""}？如果当前有用户正在使用这个套餐，后端会拒绝删除。`}
        confirmLabel="删除套餐"
        variant="destructive"
        onConfirm={handleDeletePlan}
        loading={deletePlan.isPending}
      />
    </div>
  );
}
