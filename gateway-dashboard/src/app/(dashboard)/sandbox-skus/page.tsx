"use client";

import { useMemo, useState } from "react";
import { ColumnDef } from "@tanstack/react-table";
import { Boxes, GitBranch, RefreshCw, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DataTable } from "@/components/shared/data-table";
import { PageHeader } from "@/components/shared/page-header";
import { formatDateTime } from "@/lib/utils";
import {
  deriveSandboxTemplateClassWarnings,
  useSandboxSKUs,
  useSandboxTemplateClasses,
  useSandboxTemplateClassPoolBindings,
  useSandboxTemplateClassResolve,
  useSandboxTemplateClassSKUBindings,
  type SandboxBindingAdmissionState,
  type SandboxPoolBindingRole,
  type SandboxResolvedPool,
  type SandboxSKU,
  type SandboxSKURolloutState,
  type SandboxTemplateClass,
  type SandboxTemplatePoolBinding,
  type SandboxTemplateSkuBinding,
} from "@/lib/queries/use-sandbox-skus";

const EMPTY_TEMPLATE_CLASSES: SandboxTemplateClass[] = [];
const EMPTY_SKUS: SandboxSKU[] = [];
const EMPTY_SKU_BINDINGS: SandboxTemplateSkuBinding[] = [];
const EMPTY_POOL_BINDINGS: SandboxTemplatePoolBinding[] = [];
const EMPTY_POOLS: SandboxResolvedPool[] = [];

function statusBadge(status: string) {
  if (status === "active" || status === "stable") {
    return <Badge variant="default">{status}</Badge>;
  }
  if (status === "paused" || status === "rolling" || status === "draining") {
    return <Badge variant="secondary">{status}</Badge>;
  }
  if (status === "blocked" || status === "degraded" || status === "quarantined") {
    return <Badge variant="destructive">{status}</Badge>;
  }
  return <Badge variant="outline">{status || "unknown"}</Badge>;
}

function rolloutBadge(state: SandboxSKURolloutState) {
  return statusBadge(state);
}

function admissionBadge(state?: SandboxBindingAdmissionState) {
  return statusBadge(state || "unknown");
}

function roleBadge(role: SandboxPoolBindingRole) {
  if (role === "primary") {
    return <Badge variant="default">primary</Badge>;
  }
  if (role === "fallback" || role === "burst") {
    return <Badge variant="secondary">{role}</Badge>;
  }
  return <Badge variant="outline">{role || "unknown"}</Badge>;
}

function mono(value?: string | number | null) {
  if (value === undefined || value === null || value === "") {
    return <span className="text-muted-foreground">-</span>;
  }
  return <span className="font-mono text-xs">{value}</span>;
}

export default function SandboxSKUsPage() {
  const [selectedTemplateClassID, setSelectedTemplateClassID] = useState("");
  const templateClassesQuery = useSandboxTemplateClasses();
  const skusQuery = useSandboxSKUs();
  const templateClasses = templateClassesQuery.data ?? EMPTY_TEMPLATE_CLASSES;
  const skus = skusQuery.data ?? EMPTY_SKUS;
  const activeTemplateClassID = selectedTemplateClassID || templateClasses[0]?.id || "";
  const activeTemplateClass = templateClasses.find((item) => item.id === activeTemplateClassID) ?? null;
  const skuBindingsQuery = useSandboxTemplateClassSKUBindings(activeTemplateClassID);
  const poolBindingsQuery = useSandboxTemplateClassPoolBindings(activeTemplateClassID);
  const resolveQuery = useSandboxTemplateClassResolve(activeTemplateClassID);
  const skuBindings = skuBindingsQuery.data ?? EMPTY_SKU_BINDINGS;
  const poolBindings = poolBindingsQuery.data ?? EMPTY_POOL_BINDINGS;
  const resolvedPools = resolveQuery.data?.pools ?? EMPTY_POOLS;
  const selectedSKUs = useMemo(
    () => skus.filter((sku) => sku.template_class_id === activeTemplateClassID),
    [activeTemplateClassID, skus],
  );
  const warnings = useMemo(
    () => deriveSandboxTemplateClassWarnings({
      templateClass: activeTemplateClass,
      skuBindings,
      poolBindings,
      resolvedPools,
      skus,
    }),
    [activeTemplateClass, poolBindings, resolvedPools, skuBindings, skus],
  );

  function refetchAll() {
    void templateClassesQuery.refetch();
    void skusQuery.refetch();
    void skuBindingsQuery.refetch();
    void poolBindingsQuery.refetch();
    void resolveQuery.refetch();
  }

  const templateClassColumns = useMemo<ColumnDef<SandboxTemplateClass>[]>(
    () => [
      {
        accessorKey: "id",
        header: "Template Class",
        cell: ({ row }) => mono(row.original.id),
      },
      { accessorKey: "name", header: "名称" },
      {
        accessorKey: "status",
        header: "状态",
        cell: ({ row }) => statusBadge(row.original.status),
      },
      {
        accessorKey: "resolution_mode",
        header: "解析模式",
        cell: ({ row }) => <Badge variant="outline">{row.original.resolution_mode}</Badge>,
      },
      {
        accessorKey: "region",
        header: "Region",
        cell: ({ row }) => row.original.region || "-",
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <Button
            variant={row.original.id === activeTemplateClassID ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedTemplateClassID(row.original.id)}
          >
            查看
          </Button>
        ),
      },
    ],
    [activeTemplateClassID],
  );

  const skuColumns = useMemo<ColumnDef<SandboxSKU>[]>(
    () => [
      {
        accessorKey: "id",
        header: "SKU",
        cell: ({ row }) => mono(row.original.id),
      },
      { accessorKey: "name", header: "名称" },
      {
        accessorKey: "rollout_state",
        header: "Rollout",
        cell: ({ row }) => rolloutBadge(row.original.rollout_state),
      },
      {
        accessorKey: "instance_type",
        header: "规格",
        cell: ({ row }) => mono(row.original.instance_type),
      },
      {
        accessorKey: "desired_image_id",
        header: "Desired Image",
        cell: ({ row }) => mono(row.original.desired_image_id),
      },
      {
        accessorKey: "stable_image_id",
        header: "Stable Image",
        cell: ({ row }) => mono(row.original.stable_image_id),
      },
      {
        id: "convergence",
        header: "收敛",
        cell: ({ row }) => (
          <span className="text-sm">
            {row.original.converged_pool_count ?? 0}/{row.original.total_pool_count ?? 0}
            {typeof row.original.pools_pending_rollout === "number" ? ` · pending ${row.original.pools_pending_rollout}` : ""}
          </span>
        ),
      },
      {
        accessorKey: "last_rollout_error",
        header: "最后错误",
        cell: ({ row }) => row.original.last_rollout_error || "-",
      },
    ],
    [],
  );

  const skuBindingColumns = useMemo<ColumnDef<SandboxTemplateSkuBinding>[]>(
    () => [
      {
        accessorKey: "sku_id",
        header: "SKU",
        cell: ({ row }) => mono(row.original.sku_id),
      },
      { accessorKey: "priority", header: "优先级" },
      { accessorKey: "weight", header: "权重" },
      {
        accessorKey: "admission_state",
        header: "Admission",
        cell: ({ row }) => admissionBadge(row.original.admission_state),
      },
      {
        accessorKey: "rollout_eligibility",
        header: "参与 Rollout",
        cell: ({ row }) => row.original.rollout_eligibility ? <Badge variant="default">yes</Badge> : <Badge variant="secondary">no</Badge>,
      },
      {
        accessorKey: "region_affinity",
        header: "Region Affinity",
        cell: ({ row }) => row.original.region_affinity || "-",
      },
    ],
    [],
  );

  const poolBindingColumns = useMemo<ColumnDef<SandboxTemplatePoolBinding>[]>(
    () => [
      {
        accessorKey: "pool_id",
        header: "Pool",
        cell: ({ row }) => mono(row.original.pool_id),
      },
      { accessorKey: "priority", header: "优先级" },
      { accessorKey: "weight", header: "权重" },
      {
        accessorKey: "role",
        header: "角色",
        cell: ({ row }) => roleBadge(row.original.role),
      },
      {
        accessorKey: "admission_state",
        header: "Admission",
        cell: ({ row }) => admissionBadge(row.original.admission_state),
      },
      {
        accessorKey: "reason",
        header: "原因",
        cell: ({ row }) => row.original.reason || "-",
      },
    ],
    [],
  );

  const resolvedPoolColumns = useMemo<ColumnDef<SandboxResolvedPool>[]>(
    () => [
      {
        accessorKey: "id",
        header: "Resolved Pool",
        cell: ({ row }) => mono(row.original.id),
      },
      { accessorKey: "name", header: "名称" },
      {
        accessorKey: "status",
        header: "状态",
        cell: ({ row }) => statusBadge(row.original.status),
      },
      {
        accessorKey: "capacity_state",
        header: "容量状态",
        cell: ({ row }) => statusBadge(row.original.capacity_state || "unknown"),
      },
      {
        accessorKey: "sku_id",
        header: "SKU",
        cell: ({ row }) => mono(row.original.sku_id),
      },
      {
        accessorKey: "desired_capacity",
        header: "期望容量",
      },
      {
        accessorKey: "created_at",
        header: "创建时间",
        cell: ({ row }) => formatDateTime(row.original.created_at),
      },
    ],
    [],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sandbox SKUs"
        description="查看 Template Class、SKU、绑定关系和实际 resolve 结果。写操作会在后续阶段加入风险 diff 确认。"
      >
        <Button variant="outline" onClick={refetchAll}>
          <RefreshCw className="mr-2 h-4 w-4" />
          刷新
        </Button>
      </PageHeader>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Template Classes</CardTitle>
            <CardDescription>逻辑分配入口</CardDescription>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{templateClasses.length}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>SKUs</CardTitle>
            <CardDescription>规格与镜像 rollout 单元</CardDescription>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{skus.length}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Resolved Pools</CardTitle>
            <CardDescription>{activeTemplateClassID || "未选择 Template Class"}</CardDescription>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{resolvedPools.length}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            Template Classes
          </CardTitle>
          <CardDescription>选择一个 Template Class 后，下面会展示它的 SKU、Pool 绑定和 resolve 结果。</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={templateClassColumns}
            data={templateClasses}
            total={templateClasses.length}
            isLoading={templateClassesQuery.isLoading}
          />
        </CardContent>
      </Card>

      {warnings.length > 0 ? (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <TriangleAlert className="h-4 w-4" />
              风险提示
            </CardTitle>
            <CardDescription>这些提示来自当前 bindings、SKU rollout 和 resolve 结果的客户端推导。</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {warnings.map((warning) => (
                <li key={warning} className="leading-6">{warning}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>SKUs for {activeTemplateClassID || "-"}</CardTitle>
            <CardDescription>SKU rollout 状态和镜像收敛进度。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable columns={skuColumns} data={selectedSKUs} total={selectedSKUs.length} isLoading={skusQuery.isLoading} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Template → SKU Bindings</CardTitle>
            <CardDescription>后续写操作会使用 replace 语义，必须先展示 diff。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable columns={skuBindingColumns} data={skuBindings} total={skuBindings.length} isLoading={skuBindingsQuery.isLoading} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Template → Pool Bindings</CardTitle>
            <CardDescription>Pool binding 会参与 legacy/template-class 解析路径。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable columns={poolBindingColumns} data={poolBindings} total={poolBindings.length} isLoading={poolBindingsQuery.isLoading} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Boxes className="h-4 w-4" />
              Resolve Result
            </CardTitle>
            <CardDescription>当前 sandbox 后端返回的实际候选 pools。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable columns={resolvedPoolColumns} data={resolvedPools} total={resolvedPools.length} isLoading={resolveQuery.isLoading} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
