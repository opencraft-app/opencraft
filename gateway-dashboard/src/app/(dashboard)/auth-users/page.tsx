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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  useCreateAuthImpersonationSession,
  useAuthAdminUsers,
  useDeleteAuthAdminUser,
  type AuthAdminUser,
} from "@/lib/queries/use-auth-admin";
import {
  type AdminShadowAccount,
  useShadowAdminAccounts,
} from "@/lib/queries/use-shadow-admin";
import { formatDateTime } from "@/lib/utils";

function ShadowAccountsPanel() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const accounts = useShadowAdminAccounts({
    search: search.trim() || undefined,
    page,
    pageSize,
  });

  const columns = useMemo<ColumnDef<AdminShadowAccount>[]>(
    () => [
      {
        accessorKey: "user_id",
        header: "用户 ID",
        cell: ({ row }) => (
          <code className="block max-w-48 truncate font-mono text-xs">
            {row.original.user_id}
          </code>
        ),
      },
      {
        accessorKey: "shadow_user_name",
        header: "影子用户名",
        cell: ({ row }) =>
          row.original.shadow_user_name ? (
            <code className="block max-w-40 truncate font-mono text-xs">
              {row.original.shadow_user_name}
            </code>
          ) : (
            "—"
          ),
      },
      {
        accessorKey: "phone_number",
        header: "手机号",
        cell: ({ row }) => (
          <span className="whitespace-nowrap tabular-nums">
            {row.original.country_code} {row.original.phone_number}
          </span>
        ),
      },
      {
        id: "account_ids",
        header: "UIN / OwnerUIN / AppID",
        cell: ({ row }) => (
          <div className="space-y-1 font-mono text-[11px] tabular-nums">
            <div>{row.original.uin || "—"}</div>
            <div className="text-muted-foreground">
              {row.original.owner_uin || "—"}
            </div>
            <div className="text-muted-foreground">
              {row.original.appid || "—"}
            </div>
          </div>
        ),
      },
      {
        accessorKey: "instance_id",
        header: "实例 ID",
        cell: ({ row }) =>
          row.original.instance_id ? (
            <code className="block max-w-40 truncate font-mono text-xs">
              {row.original.instance_id}
            </code>
          ) : (
            "—"
          ),
      },
      {
        id: "states",
        header: "认证状态",
        cell: ({ row }) => (
          <div className="flex min-w-28 flex-col items-start gap-1">
            <Badge variant={row.original.is_register_shadow_account ? "default" : "outline"}>
              {row.original.is_register_shadow_account ? "已注册" : "注册中"}
            </Badge>
            <Badge variant={row.original.is_shadow_account_basic_auth ? "secondary" : "outline"}>
              {row.original.is_shadow_account_basic_auth ? "基础认证" : "未基础认证"}
            </Badge>
            <Badge variant={row.original.is_standard_realname_auth ? "secondary" : "outline"}>
              {row.original.is_standard_realname_auth ? "标准实名" : "未标准实名"}
            </Badge>
          </div>
        ),
      },
      {
        accessorKey: "created_at",
        header: "创建时间",
        cell: ({ row }) => formatDateTime(row.original.created_at),
      },
      {
        accessorKey: "bound_at",
        header: "绑定时间",
        cell: ({ row }) =>
          row.original.bound_at ? formatDateTime(row.original.bound_at) : "—",
      },
    ],
    []
  );

  const queryError = accounts.error instanceof Error ? accounts.error.message : "";

  return (
    <div className="space-y-6 pt-4">
      <div>
        <Label htmlFor="shadow-account-search" className="sr-only">
          搜索影子账号
        </Label>
        <Input
          id="shadow-account-search"
          placeholder="按用户 ID、影子用户名、手机号、UIN、AppID 或实例 ID 搜索"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          className="max-w-2xl"
        />
      </div>

      {queryError && (
        <p role="alert" className="text-sm text-destructive">
          {queryError}
        </p>
      )}

      <DataTable
        columns={columns}
        data={accounts.data?.items ?? []}
        total={accounts.data?.total ?? 0}
        page={page}
        pageSize={pageSize}
        pageSizeOptions={[20, 50, 100]}
        onPageChange={setPage}
        onPageSizeChange={(value) => {
          setPageSize(value);
          setPage(1);
        }}
        isLoading={accounts.isLoading}
      />
    </div>
  );
}

export default function AuthUsersPage() {
  const [activeView, setActiveView] = useState<"auth" | "shadow">("auth");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [deleteTarget, setDeleteTarget] = useState<AuthAdminUser | null>(null);
  const [impersonationTarget, setImpersonationTarget] = useState<AuthAdminUser | null>(null);
  const [impersonationReturnTo, setImpersonationReturnTo] = useState("");
  const [impersonationReason, setImpersonationReason] = useState("");
  const { data, isLoading } = useAuthAdminUsers({
    search: search.trim() || undefined,
    page,
    pageSize,
  });
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
        description="查看认证账号主数据，以及对应的腾讯云影子账号映射。"
      />

      <Tabs
        value={activeView}
        onValueChange={(value) => setActiveView(value as "auth" | "shadow")}
      >
        <TabsList variant="line" aria-label="用户数据类型">
          <TabsTrigger value="auth">认证用户</TabsTrigger>
          <TabsTrigger value="shadow">影子账号</TabsTrigger>
        </TabsList>

        <TabsContent value="auth" className="space-y-6 pt-4">
          <div>
            <Label htmlFor="auth-user-search" className="sr-only">
              搜索认证用户
            </Label>
            <Input
              id="auth-user-search"
              placeholder="按用户 ID、手机号、邮箱或名称搜索"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              className="max-w-md"
            />
          </div>

          <DataTable
            columns={columns}
            data={data?.items ?? []}
            total={data?.total ?? 0}
            page={page}
            pageSize={pageSize}
            pageSizeOptions={[20, 50, 100]}
            onPageChange={setPage}
            onPageSizeChange={(value) => {
              setPageSize(value);
              setPage(1);
            }}
            isLoading={isLoading}
          />
        </TabsContent>

        <TabsContent value="shadow">
          {activeView === "shadow" && <ShadowAccountsPanel />}
        </TabsContent>
      </Tabs>

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
