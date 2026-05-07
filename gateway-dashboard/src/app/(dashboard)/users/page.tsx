"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MoreHorizontal, Eye, Ban, Trash2, UserCheck, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/page-header";
import { DataTable } from "@/components/shared/data-table";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { useUsers, useUpdateUser, useDeleteUser, useSubscribeUser, type User } from "@/lib/queries/use-users";
import { ensureItems } from "@/lib/page-null-guards";
import { getUserStatusLabel } from "@/lib/queries/user-status-label";
import { DEFAULT_USER_STATUS_FILTER, type UserStatusFilter } from "@/lib/queries/user-status-filter";
import { usePlans } from "@/lib/queries/use-plans";
import { formatDate, formatNumber, formatTokens, statusVariant } from "@/lib/utils";

export default function UsersPage() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<UserStatusFilter>(DEFAULT_USER_STATUS_FILTER);
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);

  const [changePlanTarget, setChangePlanTarget] = useState<User | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [switchMode, setSwitchMode] = useState<"reset" | "deduct_used">("reset");

  const { data, isLoading } = useUsers(page, pageSize, search || undefined, statusFilter);
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const subscribeUser = useSubscribeUser();
  const { data: plansData } = usePlans();
  const planItems = ensureItems(plansData?.items);

  async function handleToggleStatus(user: User) {
    const newStatus = user.status === "active" ? "suspended" : "active";
    try {
      await updateUser.mutateAsync({ userId: user.user_id, status: newStatus });
      toast.success(`用户已${newStatus === "active" ? "启用" : "禁用"}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新用户失败");
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteUser.mutateAsync(deleteTarget.user_id);
      toast.success("用户删除成功");
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除用户失败");
    }
  }

  function openChangePlan(user: User) {
    setChangePlanTarget(user);
    setSelectedPlanId("");
    setSwitchMode("reset");
  }

  async function handleChangePlan() {
    if (!changePlanTarget || !selectedPlanId) return;
    try {
      await subscribeUser.mutateAsync({
        userId: changePlanTarget.user_id,
        planId: selectedPlanId,
        mode: switchMode,
      });
      const planName = planItems.find((p) => p.id === selectedPlanId)?.name ?? "新套餐";
      toast.success(`已将用户切换到「${planName}」`);
      setChangePlanTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "切换套餐失败");
    }
  }

  const columns: ColumnDef<User>[] = [
    {
      accessorKey: "user_id",
      header: "用户 ID",
      cell: ({ row }) => (
        <Link href={`/users/${row.original.user_id}`} className="text-primary hover:underline font-mono text-xs">
          {row.original.user_id}
        </Link>
      ),
    },
    { accessorKey: "phone", header: "手机号", cell: ({ row }) => row.original.phone || "—" },
    {
      accessorKey: "status",
      header: "状态",
      cell: ({ row }) => (
        <Badge variant={statusVariant(row.original.status)}>
          {getUserStatusLabel(row.original.status)}
        </Badge>
      ),
    },
    { accessorKey: "current_plan", header: "套餐" },
    {
      accessorKey: "token_balance",
      header: "Token 余额",
      cell: ({ row }) =>
        row.original.is_unlimited
          ? "∞"
          : row.original.token_balance !== undefined
          ? formatNumber(row.original.token_balance)
          : "—",
    },
    {
      accessorKey: "created_at",
      header: "创建时间",
      cell: ({ row }) => formatDate(row.original.created_at),
    },
    {
      id: "actions",
      cell: ({ row }) => {
        const user = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon" />}
            >
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => router.push(`/users/${user.user_id}`)}>
                <Eye className="mr-2 h-4 w-4" /> 查看详情
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openChangePlan(user)}>
                <RefreshCw className="mr-2 h-4 w-4" /> 切换套餐
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleToggleStatus(user)}>
                {user.status === "active" ? (
                  <><Ban className="mr-2 h-4 w-4" /> 禁用</>
                ) : (
                  <><UserCheck className="mr-2 h-4 w-4" /> 启用</>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDeleteTarget(user)}
              >
                <Trash2 className="mr-2 h-4 w-4" /> 删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="用户管理" description="管理网关用户及其订阅信息。" />

      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="按用户 ID 或昵称搜索..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="max-w-sm"
        />
        <Select
          value={statusFilter}
          onValueChange={(value) => {
            if (!value) return;
            setStatusFilter(value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="选择状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">活跃</SelectItem>
            <SelectItem value="suspended">已禁用</SelectItem>
            <SelectItem value="deleted">已删除</SelectItem>
            <SelectItem value="all">全部</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        page={page}
        pageSize={pageSize}
        pageSizeOptions={[20, 50, 100]}
        onPageChange={setPage}
        onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        isLoading={isLoading}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="删除用户"
        description="此操作将软删除该用户。活跃的订阅将被取消，API Key 将被撤销。使用日志将保留。"
        confirmLabel="删除"
        variant="destructive"
        onConfirm={handleDelete}
        loading={deleteUser.isPending}
      />

      <Dialog open={!!changePlanTarget} onOpenChange={(open) => !open && setChangePlanTarget(null)}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>切换套餐</DialogTitle>
            <DialogDescription>
              为用户 {changePlanTarget?.user_id} 切换套餐
              {changePlanTarget?.current_plan && (
                <>，当前套餐：<strong>{changePlanTarget.current_plan}</strong></>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>新套餐</Label>
              <Select
                value={selectedPlanId}
                items={plansData?.items.map((plan) => ({
                  value: plan.id,
                  label: `${plan.name}（${plan.monthly_tokens > 0 ? `${formatTokens(plan.monthly_tokens)}/月` : "不限量"}）`,
                }))}
                onValueChange={(v) => v && setSelectedPlanId(v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="请选择套餐" />
                </SelectTrigger>
                <SelectContent>
                  {plansData?.items.map((plan) => (
                    <SelectItem key={plan.id} value={plan.id}>
                      {plan.name}（{plan.monthly_tokens > 0 ? `${formatTokens(plan.monthly_tokens)}/月` : "不限量"}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>额度模式</Label>
              <Select
                value={switchMode}
                items={[
                  { value: "reset", label: "重置额度（新套餐月配额）" },
                  { value: "deduct_used", label: "扣减已用量（新配额 - 已使用）" },
                ]}
                onValueChange={(v) => v && setSwitchMode(v as "reset" | "deduct_used")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="reset">
                    重置额度（新套餐月配额）
                  </SelectItem>
                  <SelectItem value="deduct_used">
                    扣减已用量（新配额 - 已使用）
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {switchMode === "reset"
                  ? "忽略旧订阅用量，直接按新套餐配额分配"
                  : "新额度 = 新套餐月配额 - 旧订阅已使用量（不会为负）"}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setChangePlanTarget(null)}>
              取消
            </Button>
            <Button
              onClick={handleChangePlan}
              disabled={!selectedPlanId || subscribeUser.isPending}
            >
              {subscribeUser.isPending ? "切换中..." : "确认切换"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
