"use client";

import { useCallback, useMemo, useState } from "react";
import { ColumnDef } from "@tanstack/react-table";
import { ArrowRightLeft, MoreHorizontal, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  type CtlBundle,
  type CtlDianshiParticipation,
  type CtlPass,
  useCtlAdminBundles,
  useCtlAdminPasses,
  useCtlDeleteDianshiParticipation,
  useCtlDestroyPass,
  useCtlDianshiRecords,
  useCtlPassBillingMigration,
  useCtlRefundPass,
} from "@/lib/queries/use-ctl-pass-admin";
import { formatDateTime, formatNumber, statusVariant } from "@/lib/utils";

function formatTimeSpan(span: number, unit: string) {
  const unitLabel = unit === "m" ? "月" : unit === "y" ? "年" : unit === "d" ? "天" : unit;
  return `${span}${unitLabel}`;
}

function formatOptionalDateTime(value?: string | null) {
  return value ? formatDateTime(value) : "-";
}

function formatSpec(bundle: CtlBundle) {
  if (bundle.instance_spec_display) {
    return bundle.instance_spec_display;
  }
  if (bundle.cpu && bundle.memory && bundle.system_disk_size) {
    return `${bundle.cpu}C / ${bundle.memory}G / ${bundle.system_disk_size}G`;
  }
  return "-";
}

function passActionLabel(pass: CtlPass) {
  return `${pass.pass_id} / ${pass.user_id}`;
}

function parsePositiveIntegerInput(value: string) {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return Number.NaN;
  }
  return Number.parseInt(trimmed, 10);
}

export default function SubscriptionsPage() {
  const [userID, setUserID] = useState("");
  const [bundleID, setBundleID] = useState("all");
  const [status, setStatus] = useState("all");
  const [passPage, setPassPage] = useState(1);
  const [passPageSize, setPassPageSize] = useState(20);
  const [dianshiPage, setDianshiPage] = useState(1);
  const [dianshiPageSize, setDianshiPageSize] = useState(20);
  const [refundTarget, setRefundTarget] = useState<CtlPass | null>(null);
  const [destroyTarget, setDestroyTarget] = useState<CtlPass | null>(null);
  const [billingMigrationTarget, setBillingMigrationTarget] = useState<CtlPass | null>(null);
  const [billingMigrationUin, setBillingMigrationUin] = useState("");
  const [billingMigrationAppID, setBillingMigrationAppID] = useState("");
  const [deleteDianshiParticipationTarget, setDeleteDianshiParticipationTarget] =
    useState<CtlDianshiParticipation | null>(null);

  const bundles = useCtlAdminBundles();
  const passes = useCtlAdminPasses({
    userID: userID.trim() || undefined,
    bundleID: bundleID === "all" ? undefined : bundleID,
    status,
    page: passPage,
    pageSize: passPageSize,
  });
  const refundPass = useCtlRefundPass();
  const destroyPass = useCtlDestroyPass();
  const passBillingMigration = useCtlPassBillingMigration();
  const dianshiRecords = useCtlDianshiRecords({
    userID: userID.trim() || undefined,
    page: dianshiPage,
    pageSize: dianshiPageSize,
  });
  const deleteDianshiParticipation = useCtlDeleteDianshiParticipation();

  const bundleItems = bundles.data ?? [];
  const passItems = passes.data?.passes ?? [];

  const dianshiParticipationItems = dianshiRecords.data?.participations ?? [];
  const billingMigrationUinNumber = parsePositiveIntegerInput(billingMigrationUin);
  const billingMigrationAppIDNumber = parsePositiveIntegerInput(billingMigrationAppID);
  const canSubmitBillingMigration =
    Boolean(billingMigrationTarget) &&
    Number.isFinite(billingMigrationUinNumber) &&
    billingMigrationUinNumber > 0 &&
    Number.isFinite(billingMigrationAppIDNumber) &&
    billingMigrationAppIDNumber > 0;

  const openBillingMigrationDialog = useCallback((pass: CtlPass) => {
    setBillingMigrationTarget(pass);
    setBillingMigrationUin(pass.uin > 0 ? String(pass.uin) : "");
    setBillingMigrationAppID(pass.app_id > 0 ? String(pass.app_id) : "");
  }, []);

  async function handleRefundPass() {
    if (!refundTarget) {
      return;
    }

    try {
      const result = await refundPass.mutateAsync({
        passID: refundTarget.pass_id,
      });
      toast.success(`退款已提交：${result.deal_name}`);
      setRefundTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "退款失败");
    }
  }

  async function handleDestroyPass() {
    if (!destroyTarget) {
      return;
    }
    try {
      await destroyPass.mutateAsync({
        passID: destroyTarget.pass_id,
        userID: destroyTarget.user_id,
      });
      toast.success("销毁已触发");
      setDestroyTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "销毁失败");
    }
  }

  async function handlePassBillingMigration() {
    if (!billingMigrationTarget || !canSubmitBillingMigration) {
      return;
    }
    try {
      const result = await passBillingMigration.mutateAsync({
        userID: billingMigrationTarget.user_id,
        uin: billingMigrationUinNumber,
        appID: billingMigrationAppIDNumber,
      });
      const summary = result.deal_name || result.message || result.status;
      toast.success(`接入计费结果：${summary}`);
      setBillingMigrationTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "接入计费失败");
    }
  }

  async function handleDeleteDianshiParticipation() {
    if (!deleteDianshiParticipationTarget) {
      return;
    }
    try {
      const result = await deleteDianshiParticipation.mutateAsync(deleteDianshiParticipationTarget.id);
      toast.success(result.deleted ? "点石参与记录已删除" : "未找到可删除的参与记录");
      setDeleteDianshiParticipationTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除点石参与记录失败");
    }
  }

  const bundleColumns = useMemo<ColumnDef<CtlBundle>[]>(
    () => [
      {
        accessorKey: "bundle_id",
        header: "Bundle ID",
        cell: ({ row }) => <code className="font-mono text-xs">{row.original.bundle_id}</code>,
      },
      {
        accessorKey: "bundle_name",
        header: "名称",
        cell: ({ row }) => <div className="max-w-48 truncate">{row.original.bundle_name}</div>,
      },
      {
        accessorKey: "bundle_type",
        header: "类型",
        cell: ({ row }) => <Badge variant="outline">{row.original.bundle_type}</Badge>,
      },
      {
        accessorKey: "bundle_state",
        header: "状态",
        cell: ({ row }) => <Badge variant={statusVariant(row.original.bundle_state)}>{row.original.bundle_state}</Badge>,
      },
      {
        accessorKey: "time_span",
        header: "有效期",
        cell: ({ row }) => formatTimeSpan(row.original.time_span, row.original.time_unit),
      },
      {
        accessorKey: "agent_quota",
        header: "实例配额",
        cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.agent_quota)}</span>,
      },
      {
        accessorKey: "credit",
        header: "点数",
        cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.credit)}</span>,
      },
      {
        accessorKey: "instance_spec_id",
        header: "实例规格",
        cell: ({ row }) => <span className="text-sm">{formatSpec(row.original)}</span>,
      },
      {
        accessorKey: "bundle_sales_state",
        header: "库存",
        cell: ({ row }) => (
          <div className="space-y-1">
            <Badge variant={statusVariant(row.original.bundle_sales_state)}>{row.original.bundle_sales_state}</Badge>
            <div className="text-xs tabular-nums text-muted-foreground">
              {formatNumber(row.original.bundle_sales_available_count)} / {formatNumber(row.original.bundle_sales_total_count)}
            </div>
          </div>
        ),
      },
    ],
    []
  );

  const passColumns = useMemo<ColumnDef<CtlPass>[]>(
    () => [
      {
        accessorKey: "pass_id",
        header: "Pass ID",
        cell: ({ row }) => <code className="font-mono text-xs">{row.original.pass_id}</code>,
      },
      {
        accessorKey: "user_id",
        header: "用户 ID",
        cell: ({ row }) => <code className="font-mono text-xs">{row.original.user_id}</code>,
      },
      {
        accessorKey: "bundle_name",
        header: "Bundle",
        cell: ({ row }) => (
          <div className="space-y-1">
            <div className="max-w-44 truncate text-sm font-medium">{row.original.bundle_name || "-"}</div>
            <code className="block max-w-44 truncate font-mono text-[11px] text-muted-foreground">
              {row.original.bundle_id}
            </code>
          </div>
        ),
      },
      {
        accessorKey: "status",
        header: "状态",
        cell: ({ row }) => <Badge variant={statusVariant(row.original.status)}>{row.original.status}</Badge>,
      },
      {
        accessorKey: "expired_time",
        header: "到期时间",
        cell: ({ row }) => formatDateTime(row.original.expired_time),
      },
      {
        accessorKey: "isolated_time",
        header: "隔离时间",
        cell: ({ row }) => formatOptionalDateTime(row.original.isolated_time),
      },
      {
        accessorKey: "credit_available",
        header: "点数",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {formatNumber(row.original.credit_available)} / {formatNumber(row.original.credit_total)}
          </span>
        ),
      },
      {
        accessorKey: "agent_quota_available",
        header: "实例配额",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {formatNumber(row.original.agent_quota_available)} / {formatNumber(row.original.agent_quota_total)}
          </span>
        ),
      },
      {
        accessorKey: "uin",
        header: "UIN / AppID",
        cell: ({ row }) => (
          <div className="space-y-1 font-mono text-[11px]">
            <div>{row.original.uin || "-"}</div>
            <div className="text-muted-foreground">{row.original.app_id || "-"}</div>
          </div>
        ),
      },
      {
        accessorKey: "updated_time",
        header: "更新时间",
        cell: ({ row }) => formatDateTime(row.original.updated_time),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button aria-label="打开 pass 操作" variant="ghost" size="icon" />}>
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setRefundTarget(row.original)}>
                <RotateCcw className="mr-2 h-4 w-4" />
                退款
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openBillingMigrationDialog(row.original)}>
                <ArrowRightLeft className="mr-2 h-4 w-4" />
                接入计费
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => setDestroyTarget(row.original)}>
                <Trash2 className="mr-2 h-4 w-4" />
                销毁
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [openBillingMigrationDialog]
  );

  const dianshiParticipationColumns = useMemo<ColumnDef<CtlDianshiParticipation>[]>(
    () => [
      {
        accessorKey: "id",
        header: "ID",
        cell: ({ row }) => <span className="tabular-nums">{row.original.id}</span>,
      },
      {
        accessorKey: "external_user_id",
        header: "用户",
        cell: ({ row }) => (
          <div className="space-y-1">
            <code className="block font-mono text-xs">{row.original.external_user_id}</code>
            <div className="font-mono text-[11px] text-muted-foreground">
              {row.original.uin || "-"} / {row.original.app_id || "-"}
            </div>
          </div>
        ),
      },
      {
        accessorKey: "bundle_id",
        header: "Bundle / 活动",
        cell: ({ row }) => (
          <div className="space-y-1">
            <code className="block max-w-44 truncate font-mono text-xs">{row.original.bundle_id}</code>
            <div className="font-mono text-[11px] text-muted-foreground">
              {row.original.activity_id} / {row.original.act_id}
            </div>
          </div>
        ),
      },
      {
        accessorKey: "created_time",
        header: "创建时间",
        cell: ({ row }) => formatDateTime(row.original.created_time),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <Button
            aria-label="删除点石参与记录"
            variant="ghost"
            size="icon"
            onClick={() => setDeleteDianshiParticipationTarget(row.original)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        ),
      },
    ],
    []
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="业务订阅"
        description="查看 ctl bundle 目录和 pass 当前态，并处理 pass 退款、销毁。"
      />

      <Card>
        <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <CardTitle>Bundle 目录</CardTitle>
            <CardDescription>ctl 当前维护的套餐、规格、配额和库存状态。</CardDescription>
          </div>
          <Button variant="outline" onClick={() => void bundles.refetch()} disabled={bundles.isFetching}>
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={bundleColumns}
            data={bundleItems}
            total={bundleItems.length}
            isLoading={bundles.isLoading}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pass 列表</CardTitle>
          <CardDescription>按用户或 bundle 查询 pass，并执行退款、销毁操作。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-wrap gap-3">
            <Input
              placeholder="用户 ID"
              value={userID}
              onChange={(event) => {
                setUserID(event.target.value);
                setPassPage(1);
                setDianshiPage(1);
              }}
              className="max-w-md"
            />
            <Select
              value={bundleID}
              onValueChange={(value) => {
                setBundleID(value ?? "all");
                setPassPage(1);
              }}
            >
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Bundle" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部 Bundle</SelectItem>
                {bundleItems.map((bundle) => (
                  <SelectItem key={bundle.bundle_id} value={bundle.bundle_id}>
                    {bundle.bundle_name || bundle.bundle_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value ?? "all");
                setPassPage(1);
              }}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Pass 状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="active">active</SelectItem>
                <SelectItem value="isolating">isolating</SelectItem>
                <SelectItem value="isolated">isolated</SelectItem>
                <SelectItem value="deleting">deleting</SelectItem>
                <SelectItem value="terminating">terminating</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={() => void passes.refetch()} disabled={passes.isFetching}>
              <RefreshCw className="mr-2 h-4 w-4" />
              刷新
            </Button>
          </div>

          <DataTable
            columns={passColumns}
            data={passItems}
            total={passes.data?.total ?? 0}
            page={passes.data?.page ?? passPage}
            pageSize={passes.data?.page_size ?? passPageSize}
            pageSizeOptions={[20, 50, 100]}
            onPageChange={setPassPage}
            onPageSizeChange={(size) => {
              setPassPageSize(size);
              setPassPage(1);
            }}
            isLoading={passes.isLoading}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>点石参与记录</CardTitle>
          <CardDescription>查询点石参与记录，并删除阻塞重试的记录。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              onClick={() => void dianshiRecords.refetch()}
              disabled={dianshiRecords.isFetching}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              查询
            </Button>
          </div>

          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-medium">参与记录</h3>
              <p className="text-sm text-muted-foreground">trade_user_activity_participation 中用于拦截重复参与的记录。</p>
            </div>
            <div className="overflow-x-auto">
              <DataTable
                columns={dianshiParticipationColumns}
                data={dianshiParticipationItems}
                total={dianshiRecords.data?.total ?? 0}
                page={dianshiRecords.data?.page ?? dianshiPage}
                pageSize={dianshiRecords.data?.page_size ?? dianshiPageSize}
                pageSizeOptions={[20, 50, 100]}
                onPageChange={setDianshiPage}
                onPageSizeChange={(size) => {
                  setDianshiPageSize(size);
                  setDianshiPage(1);
                }}
                isLoading={dianshiRecords.isLoading}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!refundTarget} onOpenChange={(open) => {
        if (!open) {
          setRefundTarget(null);
        }
      }}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Pass 退款</DialogTitle>
            <DialogDescription>
              确认为 {refundTarget ? passActionLabel(refundTarget) : ""} 发起退款？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRefundTarget(null)}>
              取消
            </Button>
            <Button onClick={handleRefundPass} disabled={refundPass.isPending}>
              发起退款
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!destroyTarget}
        onOpenChange={(open) => !open && setDestroyTarget(null)}
        title="销毁 Pass"
        description={`确认销毁 ${destroyTarget ? passActionLabel(destroyTarget) : ""}？销毁会触发 ctl/pass 的异步销毁链路。`}
        confirmLabel="销毁"
        variant="destructive"
        onConfirm={handleDestroyPass}
        loading={destroyPass.isPending}
      />

      <Dialog open={!!billingMigrationTarget} onOpenChange={(open) => {
        if (!open) {
          setBillingMigrationTarget(null);
        }
      }}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>接入计费</DialogTitle>
            <DialogDescription>
              将 {billingMigrationTarget ? passActionLabel(billingMigrationTarget) : ""} 从免费套餐迁移到启航 01。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="billing-migration-uin">UIN</Label>
              <Input
                id="billing-migration-uin"
                inputMode="numeric"
                value={billingMigrationUin}
                onChange={(event) => setBillingMigrationUin(event.target.value)}
                placeholder="影子账号 UIN"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="billing-migration-app-id">AppID</Label>
              <Input
                id="billing-migration-app-id"
                inputMode="numeric"
                value={billingMigrationAppID}
                onChange={(event) => setBillingMigrationAppID(event.target.value)}
                placeholder="影子账号 AppID"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBillingMigrationTarget(null)}>
              取消
            </Button>
            <Button
              onClick={handlePassBillingMigration}
              disabled={!canSubmitBillingMigration || passBillingMigration.isPending}
            >
              确认接入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteDianshiParticipationTarget}
        onOpenChange={(open) => !open && setDeleteDianshiParticipationTarget(null)}
        title="删除点石参与记录"
        description={`确认删除参与记录 ${deleteDianshiParticipationTarget?.id ?? ""}？删除后该用户可重新尝试点石活动下单。`}
        confirmLabel="删除"
        variant="destructive"
        onConfirm={handleDeleteDianshiParticipation}
        loading={deleteDianshiParticipation.isPending}
      />
    </div>
  );
}
