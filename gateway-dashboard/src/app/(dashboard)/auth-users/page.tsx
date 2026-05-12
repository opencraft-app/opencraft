"use client";

import { useMemo, useState } from "react";
import { LogIn, MoreHorizontal, Trash2 } from "lucide-react";
import { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { DataTable } from "@/components/shared/data-table";
import { PageHeader } from "@/components/shared/page-header";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import {
  useCreateAuthImpersonationSession,
  useAuthAdminUsers,
  useDeleteAuthAdminUser,
  type AuthAdminUser,
} from "@/lib/queries/use-auth-admin";
import { formatDateTime } from "@/lib/utils";

export default function AuthUsersPage() {
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AuthAdminUser | null>(null);
  const [impersonationTarget, setImpersonationTarget] = useState<AuthAdminUser | null>(null);
  const [impersonationReturnTo, setImpersonationReturnTo] = useState("");
  const [impersonationReason, setImpersonationReason] = useState("");
  const { data, isLoading } = useAuthAdminUsers(search || undefined);
  const deleteUser = useDeleteAuthAdminUser();
  const createImpersonationSession = useCreateAuthImpersonationSession();

  async function handleDeleteUser() {
    if (!deleteTarget) {
      return;
    }
    try {
      await deleteUser.mutateAsync(deleteTarget.id);
      toast.success("认证用户已注销");
      setDeleteTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "注销认证用户失败");
    }
  }

  function openImpersonationDialog(user: AuthAdminUser) {
    setImpersonationTarget(user);
    setImpersonationReturnTo("");
    setImpersonationReason("");
  }

  async function handleCreateImpersonationSession() {
    if (!impersonationTarget) {
      return;
    }
    const returnTo = impersonationReturnTo.trim();
    const reason = impersonationReason.trim();
    if (!returnTo || !reason) {
      toast.error("请输入登录目标 URL 和代登原因");
      return;
    }

    try {
      const session = await createImpersonationSession.mutateAsync({
        userID: impersonationTarget.id,
        returnTo,
        reason,
      });
      window.open(session.loginUrl, "_blank", "noopener,noreferrer");
      toast.success("代登链接已打开");
      setImpersonationTarget(null);
      setImpersonationReturnTo("");
      setImpersonationReason("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建代登会话失败");
    }
  }

  const columns = useMemo<ColumnDef<AuthAdminUser>[]>(
    () => [
      {
        accessorKey: "id",
        header: "用户 ID",
        cell: ({ row }) => (
          <code className="font-mono text-xs">{row.original.id}</code>
        ),
      },
      {
        accessorKey: "name",
        header: "名称",
        cell: ({ row }) => row.original.name || "—",
      },
      {
        accessorKey: "email",
        header: "邮箱",
        cell: ({ row }) => row.original.email || "—",
      },
      {
        accessorKey: "phone",
        header: "手机号",
        cell: ({ row }) => row.original.phone || "—",
      },
      {
        accessorKey: "authMethods",
        header: "登录方式",
        cell: ({ row }) =>
          row.original.authMethods.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {row.original.authMethods.map((method) => (
                <Badge key={method} variant={method === "qq" ? "default" : "outline"}>
                  {method === "qq"
                    ? "QQ"
                    : method === "phone"
                      ? "手机号"
                      : method === "email"
                        ? "邮箱"
                        : method}
                </Badge>
              ))}
            </div>
          ) : (
            "—"
          ),
      },
      {
        accessorKey: "qqOpenId",
        header: "QQ OpenID",
        cell: ({ row }) =>
          row.original.qqOpenId ? (
            <code className="font-mono text-[11px]">{row.original.qqOpenId}</code>
          ) : (
            "—"
          ),
      },
      {
        accessorKey: "inviteRequired",
        header: "邀请码策略",
        cell: ({ row }) => (
          <Badge variant={row.original.inviteRequired ? "outline" : "default"}>
            {row.original.inviteRequired ? "首登需要" : "免邀请码"}
          </Badge>
        ),
      },
      {
        accessorKey: "createdAt",
        header: "创建时间",
        cell: ({ row }) => formatDateTime(row.original.createdAt),
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
              <DropdownMenuItem onClick={() => openImpersonationDialog(row.original)}>
                <LogIn className="mr-2 h-4 w-4" />
                以此用户身份登录
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDeleteTarget(row.original)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                注销用户
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
        title="认证用户"
        description="查看 user-auth 里的账号主数据、登录方式、QQ OpenID 和邀请码策略。"
      />

      <Input
        placeholder="按用户 ID、手机号、邮箱或名称搜索"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="max-w-md"
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
        title="注销认证用户"
        description={`确认删除 ${deleteTarget?.id ?? ""} 的 user-auth 账号数据？这会清掉该用户在认证体系内的会话、QQ 身份、密码凭据和订阅，但不会跨服务级联删除其他数据。`}
        confirmLabel="注销"
        variant="destructive"
        onConfirm={handleDeleteUser}
        loading={deleteUser.isPending}
      />

      <Dialog open={!!impersonationTarget} onOpenChange={(open) => !open && setImpersonationTarget(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>以用户身份登录</DialogTitle>
            <DialogDescription>
              创建一个短时运营代登会话，并把 session_token 写入你输入的目标 URL fragment。目标站点会以该用户身份启动。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              <div className="font-medium">{impersonationTarget?.name || impersonationTarget?.id}</div>
              <code className="mt-1 block text-xs text-muted-foreground">{impersonationTarget?.id}</code>
            </div>

            <div className="space-y-2">
              <Label htmlFor="impersonation-return-to">登录目标 URL</Label>
              <Input
                id="impersonation-return-to"
                placeholder="https://lightclaw.tech/openclaw/settings"
                value={impersonationReturnTo}
                onChange={(event) => setImpersonationReturnTo(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                必须是包含 scheme 和 host 的绝对 URL；域名不做白名单限制。
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="impersonation-reason">代登原因</Label>
              <Textarea
                id="impersonation-reason"
                value={impersonationReason}
                onChange={(event) => setImpersonationReason(event.target.value)}
                placeholder="例如：协助用户排查订单状态"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setImpersonationTarget(null)}
              disabled={createImpersonationSession.isPending}
            >
              取消
            </Button>
            <Button
              onClick={() => void handleCreateImpersonationSession()}
              disabled={createImpersonationSession.isPending}
            >
              {createImpersonationSession.isPending ? "创建中..." : "创建并打开"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
