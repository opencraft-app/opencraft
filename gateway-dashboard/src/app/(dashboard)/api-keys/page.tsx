"use client";

import { useState } from "react";
import Link from "next/link";
import { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { MoreHorizontal, Ban } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/page-header";
import { DataTable } from "@/components/shared/data-table";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { useApiKeys, useRevokeApiKey } from "@/lib/queries/use-api-keys";
import { DEFAULT_API_KEY_STATUS_FILTER, type ApiKeyStatusFilter } from "@/lib/queries/api-key-status-filter";
import { getApiKeyStatusLabel } from "@/lib/queries/api-key-status-label";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface ApiKeyItem {
  id: string;
  key_prefix: string;
  user_id: string;
  gateway_user_id: string;
  user_phone: string;
  user_nickname: string;
  status: string;
  created_at: string;
  last_used_at: string;
}

export default function ApiKeysPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ApiKeyStatusFilter>(DEFAULT_API_KEY_STATUS_FILTER);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyItem | null>(null);

  const { data, isLoading } = useApiKeys(page, search || undefined, statusFilter);
  const revokeApiKey = useRevokeApiKey();

  const statusOptions: Array<{ value: ApiKeyStatusFilter; label: string }> = [
    { value: "active", label: getApiKeyStatusLabel("active") },
    { value: "revoked", label: getApiKeyStatusLabel("revoked") },
    { value: "all", label: getApiKeyStatusLabel("all") },
  ];
  const selectedStatusLabel = getApiKeyStatusLabel(statusFilter);

  async function handleRevoke() {
    if (!revokeTarget) return;
    try {
      await revokeApiKey.mutateAsync(revokeTarget.id);
      toast.success("API Key 已撤销");
      setRevokeTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "撤销 API Key 失败");
    }
  }

  const columns: ColumnDef<ApiKeyItem>[] = [
    {
      accessorKey: "key_prefix",
      header: "密钥前缀",
      cell: ({ row }) => (
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">
          {row.original.key_prefix}
        </code>
      ),
    },
    {
      accessorKey: "user_id",
      header: "用户 ID",
      cell: ({ row }) => (
        <Link
          href={`/users/${row.original.user_id}`}
          className="text-primary underline-offset-4 hover:underline font-mono text-xs"
        >
          {row.original.user_id}
        </Link>
      ),
    },
    {
      accessorKey: "user_nickname",
      header: "昵称",
      cell: ({ row }) => row.original.user_nickname || "—",
    },
    {
      accessorKey: "user_phone",
      header: "手机号",
      cell: ({ row }) => row.original.user_phone || "—",
    },
    {
      accessorKey: "status",
      header: "状态",
      cell: ({ row }) => (
        <Badge variant={statusVariant(row.original.status)}>
          {row.original.status === "active" ? "活跃" : row.original.status === "revoked" ? "已撤销" : row.original.status}
        </Badge>
      ),
    },
    {
      accessorKey: "created_at",
      header: "创建时间",
      cell: ({ row }) => formatDateTime(row.original.created_at),
    },
    {
      accessorKey: "last_used_at",
      header: "最后使用",
      cell: ({ row }) =>
        row.original.last_used_at
          ? formatDateTime(row.original.last_used_at)
          : "从未使用",
    },
    {
      id: "actions",
      cell: ({ row }) => {
        const key = row.original;
        if (key.status === "revoked") return null;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon" />}
            >
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setRevokeTarget(key)}
              >
                <Ban className="mr-2 h-4 w-4" /> 撤销
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="密钥管理"
        description="管理所有用户的 API Key。"
      />

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="按密钥前缀、用户 ID、昵称或手机号搜索..."
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
              <SelectValue placeholder="选择状态">
                {selectedStatusLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {statusOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-sm text-muted-foreground">
          要创建新密钥，请前往用户详情页。
        </p>
      </div>

      <DataTable
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        page={page}
        pageSize={20}
        onPageChange={setPage}
        isLoading={isLoading}
      />

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title="撤销 API Key"
        description={`此操作将永久撤销 API Key "${revokeTarget?.key_prefix ?? ""}..."。该密钥将无法再用于身份验证。`}
        confirmLabel="撤销"
        variant="destructive"
        onConfirm={handleRevoke}
        loading={revokeApiKey.isPending}
      />
    </div>
  );
}
