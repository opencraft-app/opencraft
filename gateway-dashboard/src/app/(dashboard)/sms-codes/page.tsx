"use client";

import { useMemo, useState } from "react";
import { ColumnDef } from "@tanstack/react-table";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/shared/data-table";
import { PageHeader } from "@/components/shared/page-header";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import {
  useAuthAdminSMSChallenges,
  useDeleteAuthAdminSMSChallenge,
  type AuthAdminSMSChallenge,
} from "@/lib/queries/use-auth-admin";
import { formatDateTime } from "@/lib/utils";

export default function SMSCodesPage() {
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AuthAdminSMSChallenge | null>(
    null
  );
  const { data, isLoading } = useAuthAdminSMSChallenges(search || undefined);
  const deleteMutation = useDeleteAuthAdminSMSChallenge();

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.phone);
      toast.success("验证码记录已删除");
      setDeleteTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除验证码失败");
    }
  }

  const columns = useMemo<ColumnDef<AuthAdminSMSChallenge>[]>(
    () => [
      {
        accessorKey: "phone",
        header: "手机号",
      },
      {
        accessorKey: "code",
        header: "验证码",
        cell: ({ row }) => <code className="font-mono">{row.original.code}</code>,
      },
      {
        accessorKey: "remainingRetries",
        header: "剩余重试",
      },
      {
        accessorKey: "cooldownUntil",
        header: "冷却到",
        cell: ({ row }) => formatDateTime(row.original.cooldownUntil),
      },
      {
        accessorKey: "expiresAt",
        header: "过期时间",
        cell: ({ row }) => formatDateTime(row.original.expiresAt),
      },
      {
        accessorKey: "updatedAt",
        header: "更新时间",
        cell: ({ row }) => formatDateTime(row.original.updatedAt),
      },
      {
        id: "actions",
        header: "操作",
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setDeleteTarget(row.original)}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        ),
      },
    ],
    []
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="验证码管理"
        description="查看短信验证码状态，并在必要时清理错误或残留记录。"
      />

      <Input
        placeholder="按手机号搜索"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="max-w-sm"
      />

      <DataTable
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        isLoading={isLoading}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="删除验证码记录"
        description={`确认删除 ${deleteTarget?.phone ?? ""} 的验证码缓存？`}
        confirmLabel="删除"
        variant="destructive"
        onConfirm={handleDelete}
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
