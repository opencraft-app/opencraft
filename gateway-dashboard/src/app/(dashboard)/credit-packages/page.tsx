"use client";

import { useMemo, useState } from "react";
import { ColumnDef } from "@tanstack/react-table";
import { RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  type AdminCreditPackage,
  useCreditAdminPackages,
  useCreditPackageRefund,
} from "@/lib/queries/use-credit-package-admin";
import { formatDateTime, statusVariant } from "@/lib/utils";

function packageLabel(pkg: AdminCreditPackage) {
  return `${pkg.package_id} / ${pkg.user_id}`;
}

function formatCredit(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 4,
  }).format(value);
}

export default function CreditPackagesPage() {
  const [userID, setUserID] = useState("");
  const [packageID, setPackageID] = useState("");
  const [productID, setProductID] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [refundTarget, setRefundTarget] =
    useState<AdminCreditPackage | null>(null);
  const [operationError, setOperationError] = useState("");

  const packages = useCreditAdminPackages({
    userID: userID.trim() || undefined,
    packageID: packageID.trim() || undefined,
    productID: productID.trim() || undefined,
    status,
    page,
    pageSize,
  });
  const refund = useCreditPackageRefund();

  async function handleRefund() {
    if (!refundTarget) {
      return;
    }
    setOperationError("");
    try {
      await refund.mutateAsync(refundTarget.package_id);
      toast.success(`积分包 ${refundTarget.package_id} 退款已提交`);
      setRefundTarget(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "退款失败";
      setOperationError(message);
      toast.error(message);
    }
  }

  const columns = useMemo<ColumnDef<AdminCreditPackage>[]>(
    () => [
      {
        accessorKey: "package_id",
        header: "积分包 ID",
        cell: ({ row }) => (
          <code className="block max-w-48 truncate font-mono text-xs">
            {row.original.package_id}
          </code>
        ),
      },
      {
        accessorKey: "user_id",
        header: "用户 ID",
        cell: ({ row }) => (
          <code className="block max-w-44 truncate font-mono text-xs">
            {row.original.user_id}
          </code>
        ),
      },
      {
        accessorKey: "product_name",
        header: "商品",
        cell: ({ row }) => (
          <div className="space-y-1">
            <div className="max-w-40 truncate text-sm font-medium">
              {row.original.product_name || "-"}
            </div>
            <code className="block max-w-40 truncate font-mono text-[11px] text-muted-foreground">
              {row.original.product_id}
            </code>
          </div>
        ),
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
        accessorKey: "credit_left",
        header: "积分",
        cell: ({ row }) => (
          <div className="space-y-1 tabular-nums">
            <div>
              {formatCredit(row.original.credit_left)} / {formatCredit(row.original.credit_total)}
            </div>
            <div className="text-xs text-muted-foreground">
              已用 {formatCredit(row.original.credit_used_total)}
            </div>
          </div>
        ),
      },
      {
        accessorKey: "deal_name",
        header: "订单",
        cell: ({ row }) => (
          <div className="space-y-1 font-mono text-[11px]">
            <div className="max-w-44 truncate">{row.original.deal_name || "-"}</div>
            <div className="max-w-44 truncate text-muted-foreground">
              {row.original.big_order_id || "-"}
            </div>
          </div>
        ),
      },
      {
        accessorKey: "expired_time",
        header: "到期时间",
        cell: ({ row }) => formatDateTime(row.original.expired_time),
      },
      {
        accessorKey: "uin",
        header: "UIN / AppID",
        cell: ({ row }) => (
          <div className="space-y-1 font-mono text-[11px] tabular-nums">
            <div>{row.original.uin || "-"}</div>
            <div className="text-muted-foreground">
              {row.original.app_id || "-"}
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
        cell: ({ row }) => {
          if (row.original.status !== "active") {
            return null;
          }
          return (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOperationError("");
                setRefundTarget(row.original);
              }}
            >
              <RotateCcw className="mr-2 size-4" aria-hidden="true" />
              退款
            </Button>
          );
        },
      },
    ],
    []
  );

  const queryError = packages.error instanceof Error ? packages.error.message : "";

  return (
    <div className="space-y-6">
      <PageHeader
        title="积分包"
        description="查询用户购买的积分包及用量，并为有效积分包发起退款。"
      />

      <Card>
        <CardHeader>
          <CardTitle>积分包列表</CardTitle>
          <CardDescription>支持按用户、积分包、商品和状态精确查询。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_180px_auto]">
            <div>
              <Label htmlFor="credit-user-id" className="sr-only">用户 ID</Label>
              <Input
                id="credit-user-id"
                placeholder="用户 ID"
                value={userID}
                onChange={(event) => {
                  setUserID(event.target.value);
                  setPage(1);
                }}
              />
            </div>
            <div>
              <Label htmlFor="credit-package-id" className="sr-only">积分包 ID</Label>
              <Input
                id="credit-package-id"
                placeholder="积分包 ID"
                value={packageID}
                onChange={(event) => {
                  setPackageID(event.target.value);
                  setPage(1);
                }}
              />
            </div>
            <div>
              <Label htmlFor="credit-product-id" className="sr-only">商品 ID</Label>
              <Input
                id="credit-product-id"
                placeholder="商品 ID"
                value={productID}
                onChange={(event) => {
                  setProductID(event.target.value);
                  setPage(1);
                }}
              />
            </div>
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value ?? "all");
                setPage(1);
              }}
            >
              <SelectTrigger aria-label="积分包状态">
                <SelectValue placeholder="积分包状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="active">active</SelectItem>
                <SelectItem value="isolating">isolating</SelectItem>
                <SelectItem value="isolated">isolated</SelectItem>
                <SelectItem value="terminating">terminating</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              onClick={() => void packages.refetch()}
              disabled={packages.isFetching}
            >
              <RefreshCw className="mr-2 size-4" aria-hidden="true" />
              查询
            </Button>
          </div>

          {(queryError || operationError) && (
            <p className="text-sm text-destructive" role="alert">
              {queryError || operationError}
            </p>
          )}

          <div className="overflow-x-auto">
            <DataTable
              columns={columns}
              data={packages.data?.packages ?? []}
              total={packages.data?.total ?? 0}
              page={packages.data?.page ?? page}
              pageSize={packages.data?.page_size ?? pageSize}
              pageSizeOptions={[20, 50, 100]}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              isLoading={packages.isLoading}
            />
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!refundTarget}
        onOpenChange={(open) => !open && setRefundTarget(null)}
        title="积分包退款"
        description={`确认为 ${refundTarget ? packageLabel(refundTarget) : ""} 发起退款？退款金额由计费根据积分包使用量计算。`}
        confirmLabel="发起退款"
        variant="destructive"
        onConfirm={handleRefund}
        loading={refund.isPending}
      />
    </div>
  );
}
