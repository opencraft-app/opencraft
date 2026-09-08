"use client";

import { useCallback, useMemo, useState } from "react";
import { ColumnDef } from "@tanstack/react-table";
import { ArrowRightLeft, MoreHorizontal, Bot, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DataTable } from "@/components/shared/data-table";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { GatewayOperationDialog } from "@/components/ctl/gateway-operation-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { formatDateTime } from "@/lib/utils";
import { CtlBot, useCtlBots, useDeleteCtlBot } from "@/lib/queries/use-ctl-bots";
import { canRunGatewayOperation, migrationNeedsLegacyKeyCleanup } from "@/lib/queries/gateway-operation-policy";
import {
  type GatewayOperation,
  useMigrateCtlBot,
  useResetCtlUserQuota,
} from "@/lib/queries/gateway-operations";

const statusOptions = [
  { label: "全部状态", value: "all" },
  { label: "Creating", value: "Creating" },
  { label: "Running", value: "Running" },
  { label: "Paused", value: "Paused" },
  { label: "Failed", value: "Failed" },
  { label: "Deleting", value: "Deleting" },
  { label: "Deleted", value: "Deleted" },
] as const;

function statusBadge(status: CtlBot["status"]) {
  switch (status) {
    case "Running":
      return <Badge variant="default">Running</Badge>;
    case "Paused":
      return <Badge variant="secondary">Paused</Badge>;
    case "Creating":
    case "Deleting":
      return <Badge variant="outline">{status}</Badge>;
    case "Failed":
    case "Deleted":
      return <Badge variant="destructive">{status}</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function CtlBotsPage() {
  const [page, setPage] = useState(1);
  const [userIDInput, setUserIDInput] = useState("");
  const [userIDFilter, setUserIDFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [deleteTarget, setDeleteTarget] = useState<CtlBot | null>(null);
  const [gatewayTarget, setGatewayTarget] = useState<{ bot: CtlBot; operation: GatewayOperation } | null>(null);
  const [gatewayPreviewError, setGatewayPreviewError] = useState<string>();

  const { data, isLoading, isFetching, refetch } = useCtlBots({
    page,
    pageSize: 20,
    userID: userIDFilter,
    status: statusFilter === "all" ? "" : statusFilter,
  });
  const deleteBot = useDeleteCtlBot();
  const migrateBot = useMigrateCtlBot();
  const resetQuota = useResetCtlUserQuota();

  const openGatewayOperation = useCallback(async (bot: CtlBot, operation: GatewayOperation) => {
    setGatewayPreviewError(undefined);
    migrateBot.reset();
    resetQuota.reset();
    setGatewayTarget({ bot, operation });
    try {
      if (operation === "migrate") {
        await migrateBot.mutateAsync({ instanceID: bot.instance_id, userID: bot.user_id, dryRun: true });
      } else {
        await resetQuota.mutateAsync({ userID: bot.user_id, dryRun: true });
      }
    } catch (error) {
      setGatewayPreviewError(error instanceof Error ? error.message : "预检失败");
    }
  }, [migrateBot, resetQuota]);

  async function executeGatewayOperation() {
    if (!gatewayTarget) return;
    const { bot, operation } = gatewayTarget;
    try {
      if (operation === "migrate") {
        const result = await migrateBot.mutateAsync({ instanceID: bot.instance_id, userID: bot.user_id, dryRun: false });
        if (migrationNeedsLegacyKeyCleanup(result.previous_gateway, result.legacy_key_revoked)) {
          toast.warning("迁移已完成，但旧网关 Key 撤销失败，需要人工清理");
        } else {
          toast.success("用户及 Running Bot 已迁移到 VelaGW");
        }
      } else {
        const result = await resetQuota.mutateAsync({ userID: bot.user_id, dryRun: false });
        toast.success(result.status === "already_reset" ? "额度已经是 0，无需重置" : "VelaGW 额度已重置");
      }
      setGatewayTarget(null);
      await refetch();
    } catch (error) {
      setGatewayPreviewError(error instanceof Error ? error.message : "操作失败");
    }
  }

  async function handleDeleteBot() {
    if (!deleteTarget) {
      return;
    }
    try {
      await deleteBot.mutateAsync(deleteTarget.instance_id);
      toast.success(deleteTarget.status === "Deleting" ? "已重试删除" : "已发起删除");
      setDeleteTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除 bot 失败");
    }
  }

  const columns = useMemo<ColumnDef<CtlBot>[]>(
    () => [
      {
        accessorKey: "user_id",
        header: "用户 ID",
      },
      {
        accessorKey: "instance_id",
        header: "Bot / Instance ID",
      },
      {
        accessorKey: "sandbox_id",
        header: "Sandbox ID",
        cell: ({ row }) => row.original.sandbox_id || "-",
      },
      {
        accessorKey: "status",
        header: "状态",
        cell: ({ row }) => statusBadge(row.original.status),
      },
      {
        accessorKey: "created_at",
        header: "创建时间",
        cell: ({ row }) => formatDateTime(row.original.created_at),
      },
      {
        accessorKey: "updated_at",
        header: "更新时间",
        cell: ({ row }) => formatDateTime(row.original.updated_at),
      },
      {
        accessorKey: "timeout_at",
        header: "超时时间",
        cell: ({ row }) => row.original.timeout_at ? formatDateTime(row.original.timeout_at) : "-",
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          if (row.original.status === "Deleted") {
            return null;
          }
          const label = row.original.status === "Deleting" ? "重试删除" : "删除";
          return (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon" />}
              >
                <MoreHorizontal className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                {canRunGatewayOperation(row.original.status) ? (
                  <>
                    <DropdownMenuItem onClick={() => void openGatewayOperation(row.original, "migrate")}>
                      <ArrowRightLeft className="mr-2 h-4 w-4" />
                      迁移到 VelaGW
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void openGatewayOperation(row.original, "reset_quota")}>
                      <RotateCcw className="mr-2 h-4 w-4" />
                      重置 VelaGW 额度
                    </DropdownMenuItem>
                  </>
                ) : null}
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setDeleteTarget(row.original)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {label}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [openGatewayOperation]
  );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  function applyFilters() {
    setPage(1);
    setUserIDFilter(userIDInput.trim());
  }

  function onStatusChange(value: string | null) {
    setPage(1);
    setStatusFilter(value ?? "all");
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="CTL Bots"
        description="查看当前环境下 bot 实例归属、关联沙箱、创建时间和运行状态。"
      >
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className="mr-2 h-4 w-4" />
          刷新
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4">
        <div className="min-w-64 flex-1">
          <Input
            value={userIDInput}
            onChange={(event) => setUserIDInput(event.target.value)}
            placeholder="按用户 ID 过滤，例如 usr_xxx"
          />
        </div>
        <Select value={statusFilter} onValueChange={onStatusChange}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="选择状态" />
          </SelectTrigger>
          <SelectContent>
            {statusOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={applyFilters}>
          <Bot className="mr-2 h-4 w-4" />
          应用筛选
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={items}
        total={total}
        page={data?.page ?? page}
        pageSize={data?.page_size ?? 20}
        onPageChange={setPage}
        isLoading={isLoading}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={deleteTarget?.status === "Deleting" ? "重试删除 Bot" : "删除 Bot"}
        description={
          deleteTarget
            ? `确认对 ${deleteTarget.instance_id} 执行${deleteTarget.status === "Deleting" ? "重试删除" : "删除"}？当前状态：${deleteTarget.status}。`
            : ""
        }
        confirmLabel={deleteTarget?.status === "Deleting" ? "重试删除" : "删除"}
        variant="destructive"
        onConfirm={handleDeleteBot}
        loading={deleteBot.isPending}
      />

      {gatewayTarget ? (
        <GatewayOperationDialog
          key={`${gatewayTarget.operation}:${gatewayTarget.bot.instance_id}`}
          target={gatewayTarget.bot}
          operation={gatewayTarget.operation}
          preview={gatewayTarget.operation === "migrate" ? migrateBot.data : resetQuota.data}
          previewError={gatewayPreviewError}
          loading={migrateBot.isPending || resetQuota.isPending}
          onClose={() => setGatewayTarget(null)}
          onExecute={() => void executeGatewayOperation()}
        />
      ) : null}
    </div>
  );
}
