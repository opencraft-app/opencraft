"use client";

import { useMemo, useState } from "react";
import { ColumnDef } from "@tanstack/react-table";
import { Ban, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { PageHeader } from "@/components/shared/page-header";
import { DataTable } from "@/components/shared/data-table";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import {
  useAuthAdminInvites,
  useCreateAuthAdminInvite,
  useDisableAuthAdminInvite,
  type AuthAdminInvite,
} from "@/lib/queries/use-auth-admin";
import { formatDateTime, statusVariant } from "@/lib/utils";

export default function InvitesPage() {
  const [search, setSearch] = useState("");
  const [state, setState] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [disableTarget, setDisableTarget] = useState<AuthAdminInvite | null>(null);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");

  const { data, isLoading } = useAuthAdminInvites(
    search || undefined,
    state === "all" ? undefined : state
  );
  const createMutation = useCreateAuthAdminInvite();
  const disableMutation = useDisableAuthAdminInvite();

  async function handleCreate() {
    try {
      const created = await createMutation.mutateAsync({
        code: code.trim() || undefined,
        message: message.trim() || undefined,
      });
      toast.success(`邀请码 ${created.code} 已创建`);
      setCode("");
      setMessage("");
      setCreateOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建邀请码失败");
    }
  }

  async function handleDisable() {
    if (!disableTarget) return;
    try {
      await disableMutation.mutateAsync(disableTarget.code);
      toast.success(`邀请码 ${disableTarget.code} 已禁用`);
      setDisableTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "禁用邀请码失败");
    }
  }

  const columns = useMemo<ColumnDef<AuthAdminInvite>[]>(
    () => [
      {
        accessorKey: "code",
        header: "邀请码",
        cell: ({ row }) => <code className="font-mono">{row.original.code}</code>,
      },
      {
        accessorKey: "state",
        header: "状态",
        cell: ({ row }) => (
          <Badge variant={statusVariant(row.original.state)}>
            {row.original.state}
          </Badge>
        ),
      },
      {
        accessorKey: "message",
        header: "备注",
        cell: ({ row }) => row.original.message || "—",
      },
      {
        accessorKey: "usedByUserId",
        header: "使用者",
        cell: ({ row }) =>
          row.original.usedByUserId ? (
            <code className="font-mono text-xs">{row.original.usedByUserId}</code>
          ) : (
            "—"
          ),
      },
      {
        accessorKey: "usedVia",
        header: "使用方式",
        cell: ({ row }) => row.original.usedVia || "—",
      },
      {
        accessorKey: "usedAt",
        header: "使用时间",
        cell: ({ row }) =>
          row.original.usedAt ? formatDateTime(row.original.usedAt) : "—",
      },
      {
        accessorKey: "createdAt",
        header: "创建时间",
        cell: ({ row }) => formatDateTime(row.original.createdAt),
      },
      {
        id: "actions",
        header: "操作",
        cell: ({ row }) =>
          row.original.state === "valid" ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDisableTarget(row.original)}
            >
              <Ban className="h-4 w-4 text-destructive" />
            </Button>
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          ),
      },
    ],
    []
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="邀请码"
        description="管理一次性邀请码，查看使用记录，并按需禁用尚未消费的邀请码。"
      >
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          新建邀请码
        </Button>
      </PageHeader>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Input
          placeholder="按邀请码、备注或使用者搜索"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-md"
        />
        <Select value={state} onValueChange={(value) => setState(value ?? "all")}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="筛选状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="valid">valid</SelectItem>
            <SelectItem value="used">used</SelectItem>
            <SelectItem value="disabled">disabled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        isLoading={isLoading}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建邀请码</DialogTitle>
            <DialogDescription>
              你可以手工指定邀请码；留空则由后端自动生成一次性邀请码。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="invite-code">邀请码</Label>
              <Input
                id="invite-code"
                placeholder="留空自动生成"
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-message">备注</Label>
              <Textarea
                id="invite-message"
                placeholder="比如：社区活动、内部测试、线下赠送"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={createMutation.isPending}
            >
              取消
            </Button>
            <Button onClick={handleCreate} disabled={createMutation.isPending}>
              {createMutation.isPending ? "创建中…" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!disableTarget}
        onOpenChange={(open) => !open && setDisableTarget(null)}
        title="禁用邀请码"
        description={`确认禁用邀请码 ${disableTarget?.code ?? ""}？已消费的邀请码不会受影响。`}
        confirmLabel="禁用"
        variant="destructive"
        onConfirm={handleDisable}
        loading={disableMutation.isPending}
      />
    </div>
  );
}
