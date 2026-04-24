"use client";

import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ColumnDef } from "@tanstack/react-table";
import {
  MoreHorizontal,
  Plus,
  Pencil,
  Server,
  RefreshCw,
  TriangleAlert,
  PauseCircle,
  PlayCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/shared/data-table";
import { PageHeader } from "@/components/shared/page-header";
import { formatDateTime } from "@/lib/utils";
import {
  useCreateSandboxPool,
  useSandboxPoolInstanceSummaries,
  useSandboxPoolInstances,
  useSandboxPools,
  useUpdateSandboxPool,
  type SandboxPool,
  type SandboxPoolInput,
  type SandboxPoolInstance,
} from "@/lib/queries/use-sandbox-pools";

const poolFormSchema = z.object({
  name: z.string().min(1, "Pool 名称不能为空").max(64, "最多 64 个字符"),
  description: z.string().optional(),
  base_image: z.string().min(1, "Base image 不能为空"),
  desired_capacity: z.number().int().min(0, "不能为负数"),
  instance_type: z.string().optional(),
  status: z.enum(["active", "paused"]),
  pause_reason: z.string().optional(),
  vpc_id: z.string().min(1, "VPC ID 不能为空"),
  subnet_id: z.string().min(1, "Subnet ID 不能为空"),
  zone: z.string().min(1, "Zone 不能为空"),
  security_groups_text: z.string().optional(),
  mark_clean_as_dry: z.boolean(),
});

type PoolFormValues = z.infer<typeof poolFormSchema>;

function defaultPoolFormValues(): PoolFormValues {
  return {
    name: "",
    description: "",
    base_image: "",
    desired_capacity: 24,
    instance_type: "",
    status: "active",
    pause_reason: "",
    vpc_id: "",
    subnet_id: "",
    zone: "",
    security_groups_text: "",
    mark_clean_as_dry: false,
  };
}

function poolToFormValues(pool: SandboxPool): PoolFormValues {
  return {
    name: pool.name,
    description: pool.description ?? "",
    base_image: pool.base_image,
    desired_capacity: pool.desired_capacity,
    instance_type: pool.instance_type ?? "",
    status: pool.status,
    pause_reason: pool.pause_reason ?? "",
    vpc_id: pool.vpc_id,
    subnet_id: pool.subnet_id,
    zone: pool.zone,
    security_groups_text: (pool.security_groups ?? []).join(", "),
    mark_clean_as_dry: false,
  };
}

function parseSecurityGroups(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function poolPayload(values: PoolFormValues): SandboxPoolInput {
  return {
    name: values.name.trim(),
    description: values.description?.trim() || "",
    base_image: values.base_image.trim(),
    desired_capacity: values.desired_capacity,
    instance_type: values.instance_type?.trim() || "",
    status: values.status,
    pause_reason: values.pause_reason?.trim() || "",
    vpc_id: values.vpc_id.trim(),
    subnet_id: values.subnet_id.trim(),
    zone: values.zone.trim(),
    security_groups: parseSecurityGroups(values.security_groups_text),
  };
}

function poolStatusBadge(status: SandboxPool["status"]) {
  if (status === "active") {
    return <Badge variant="default">active</Badge>;
  }
  return <Badge variant="secondary">paused</Badge>;
}

function PauseReasonCell({ reason }: { reason?: string }) {
  const normalized = reason?.trim();
  if (!normalized) {
    return <span className="text-sm text-muted-foreground">-</span>;
  }

  return (
    <div className="max-w-[340px] space-y-1">
      <div className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
        <TriangleAlert className="h-3.5 w-3.5" />
        paused reason
      </div>
      <p className="line-clamp-3 text-xs leading-5 text-muted-foreground">
        {normalized}
      </p>
    </div>
  );
}

function instanceStateBadge(state: SandboxPoolInstance["state"]) {
  switch (state) {
    case "CLEAN":
      return <Badge variant="default">CLEAN</Badge>;
    case "ALLOCATED":
      return <Badge variant="outline">ALLOCATED</Badge>;
    case "DRY":
      return <Badge variant="secondary">DRY</Badge>;
    case "RESETTING":
    case "REINSTALLING":
    case "CREATING":
      return <Badge variant="outline">{state}</Badge>;
    case "FAILED":
    case "DELETING":
    case "DELETED":
      return <Badge variant="destructive">{state}</Badge>;
    default:
      return <Badge variant="outline">{state}</Badge>;
  }
}

function PoolInstancesDialog({
  pool,
  open,
  onOpenChange,
}: {
  pool: SandboxPool | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isLoading, refetch, isFetching } = useSandboxPoolInstances(pool?.id ?? null, open);
  const items = data ?? [];

  const columns = useMemo<ColumnDef<SandboxPoolInstance>[]>(
    () => [
      { accessorKey: "id", header: "实例 ID" },
      {
        accessorKey: "state",
        header: "状态",
        cell: ({ row }) => instanceStateBadge(row.original.state),
      },
      {
        accessorKey: "cloud_id",
        header: "Cloud ID",
        cell: ({ row }) => row.original.cloud_id || "-",
      },
      {
        accessorKey: "address",
        header: "内网 IP",
        cell: ({ row }) => row.original.address || "-",
      },
      {
        accessorKey: "updated_at",
        header: "更新时间",
        cell: ({ row }) => formatDateTime(row.original.updated_at),
      },
    ],
    []
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Pool 实例</DialogTitle>
          <DialogDescription>
            {pool ? `${pool.id} · ${pool.name}` : "查看 pool 实例"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            共 {items.length} 个实例
          </div>
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
        </div>
        <DataTable columns={columns} data={items} total={items.length} isLoading={isLoading} />
      </DialogContent>
    </Dialog>
  );
}

export default function SandboxPoolsPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPool, setEditingPool] = useState<SandboxPool | null>(null);
  const [instancesPool, setInstancesPool] = useState<SandboxPool | null>(null);
  const [statusUpdatingPoolID, setStatusUpdatingPoolID] = useState<string | null>(null);

  const { data: pools = [], isLoading, refetch } = useSandboxPools();
  const createPool = useCreateSandboxPool();
  const updatePool = useUpdateSandboxPool();
  const instanceQueries = useSandboxPoolInstanceSummaries(pools.map((pool) => pool.id));

  const form = useForm<PoolFormValues>({
    resolver: zodResolver(poolFormSchema),
    defaultValues: defaultPoolFormValues(),
  });

  const instanceSummaryByPoolId = useMemo(() => {
    return pools.reduce<Record<string, Record<string, number>>>((acc, pool, index) => {
      const counts: Record<string, number> = {};
      const instances = instanceQueries[index]?.data ?? [];
      for (const instance of instances) {
        counts[instance.state] = (counts[instance.state] ?? 0) + 1;
      }
      acc[pool.id] = counts;
      return acc;
    }, {});
  }, [instanceQueries, pools]);

  function openCreate() {
    setEditingPool(null);
    form.reset(defaultPoolFormValues());
    setDialogOpen(true);
  }

  function openEdit(pool: SandboxPool) {
    setEditingPool(pool);
    form.reset(poolToFormValues(pool));
    setDialogOpen(true);
  }

  async function onSubmit(values: PoolFormValues) {
    try {
      if (editingPool) {
        await updatePool.mutateAsync({
          id: editingPool.id,
          ...poolPayload(values),
          mark_clean_as_dry: values.mark_clean_as_dry,
        });
        toast.success("Pool 已更新");
      } else {
        await createPool.mutateAsync(poolPayload(values));
        toast.success("Pool 已创建");
      }
      setDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存 pool 失败");
    }
  }

  async function updatePoolStatus(pool: SandboxPool, status: SandboxPool["status"]) {
    try {
      setStatusUpdatingPoolID(pool.id);
      await updatePool.mutateAsync({
        id: pool.id,
        name: pool.name,
        description: pool.description ?? "",
        base_image: pool.base_image,
        desired_capacity: pool.desired_capacity,
        instance_type: pool.instance_type ?? "",
        status,
        pause_reason:
          status === "paused"
            ? pool.pause_reason?.trim() || "paused manually from dashboard"
            : "",
        vpc_id: pool.vpc_id,
        subnet_id: pool.subnet_id,
        zone: pool.zone,
        security_groups: pool.security_groups ?? [],
        mark_clean_as_dry: false,
      });
      toast.success(status === "paused" ? "Pool 已暂停" : "Pool 已恢复为 active");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新 pool 状态失败");
    } finally {
      setStatusUpdatingPoolID(null);
    }
  }

  const columns = useMemo<ColumnDef<SandboxPool>[]>(
    () => [
      { accessorKey: "id", header: "Pool ID" },
      { accessorKey: "name", header: "名称" },
      {
        accessorKey: "status",
        header: "状态",
        cell: ({ row }) => (
          <div className="space-y-2">
            {poolStatusBadge(row.original.status)}
            {row.original.status === "paused" ? (
              <p className="max-w-[220px] line-clamp-2 text-xs leading-5 text-muted-foreground">
                {row.original.pause_reason?.trim() || "暂停中，未记录原因"}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: "pause_reason",
        header: "暂停原因",
        cell: ({ row }) => <PauseReasonCell reason={row.original.pause_reason} />,
      },
      {
        accessorKey: "base_image",
        header: "Base Image",
        cell: ({ row }) => (
          <div className="max-w-[180px] truncate font-mono text-xs">{row.original.base_image}</div>
        ),
      },
      {
        accessorKey: "desired_capacity",
        header: "期望容量",
      },
      {
        id: "instances",
        header: "实例状态分布",
        cell: ({ row }) => {
          const counts = instanceSummaryByPoolId[row.original.id] ?? {};
          const entries = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
          if (entries.length === 0) {
            return <span className="text-sm text-muted-foreground">暂无实例</span>;
          }
          return (
            <div className="flex flex-wrap gap-1">
              {entries.map(([state, count]) => (
                <Badge key={state} variant="outline">
                  {state} {count}
                </Badge>
              ))}
            </div>
          );
        },
      },
      {
        accessorKey: "zone",
        header: "Zone",
      },
      {
        accessorKey: "subnet_id",
        header: "Subnet",
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.subnet_id}</span>,
      },
      {
        accessorKey: "created_at",
        header: "创建时间",
        cell: ({ row }) => formatDateTime(row.original.created_at),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent hover:bg-accent">
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setInstancesPool(row.original)}>
                <Server className="mr-2 h-4 w-4" />
                查看实例
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openEdit(row.original)}>
                <Pencil className="mr-2 h-4 w-4" />
                编辑 Pool
              </DropdownMenuItem>
              {row.original.status === "active" ? (
                <DropdownMenuItem
                  disabled={statusUpdatingPoolID === row.original.id}
                  onClick={() => void updatePoolStatus(row.original, "paused")}
                >
                  <PauseCircle className="mr-2 h-4 w-4" />
                  暂停 Pool
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  disabled={statusUpdatingPoolID === row.original.id}
                  onClick={() => void updatePoolStatus(row.original, "active")}
                >
                  <PlayCircle className="mr-2 h-4 w-4" />
                  恢复 Pool
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [instanceSummaryByPoolId, statusUpdatingPoolID]
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sandbox Pools"
        description="管理当前环境的 sandbox pool：查看状态分布、创建 pool、编辑配置和查看实例。"
      >
        <Button variant="outline" onClick={() => void refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          刷新
        </Button>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          创建 Pool
        </Button>
      </PageHeader>

      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        第一版允许自由填写网络字段：`vpc_id / subnet_id / zone / security_groups / base_image`。
      </div>

      <DataTable columns={columns} data={pools} total={pools.length} isLoading={isLoading} />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editingPool ? "编辑 Pool" : "创建 Pool"}</DialogTitle>
            <DialogDescription>
              当前环境 pool 运维入口。变更 `base_image` 或 `instance_type` 时，可选择将当前 `CLEAN` 实例改成 `DRY`。
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>名称</FormLabel>
                      <FormControl><Input {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="base_image"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Base Image</FormLabel>
                      <FormControl><Input {...field} className="font-mono" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="desired_capacity"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Desired Capacity</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          value={field.value}
                          onChange={(event) => field.onChange(Number(event.target.value))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="instance_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Instance Type</FormLabel>
                      <FormControl><Input {...field} placeholder="SA9.MEDIUM2" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="status"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>状态</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="active">active</SelectItem>
                          <SelectItem value="paused">paused</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="zone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Zone</FormLabel>
                      <FormControl><Input {...field} placeholder="ap-shanghai-5" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="vpc_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>VPC ID</FormLabel>
                      <FormControl><Input {...field} className="font-mono" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="subnet_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Subnet ID</FormLabel>
                      <FormControl><Input {...field} className="font-mono" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="security_groups_text"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Security Groups</FormLabel>
                    <FormControl><Input {...field} placeholder="sg-1, sg-2" className="font-mono" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>描述</FormLabel>
                    <FormControl><Textarea {...field} rows={3} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="pause_reason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Pause Reason</FormLabel>
                    <FormControl><Textarea {...field} rows={2} placeholder="状态为 paused 时可填写" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {editingPool ? (
                <FormField
                  control={form.control}
                  name="mark_clean_as_dry"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                      <div className="space-y-0.5">
                        <FormLabel>Mark CLEAN as DRY</FormLabel>
                        <div className="text-sm text-muted-foreground">
                          如果同时修改了 `base_image` 或 `instance_type`，可把当前 `CLEAN` 实例标记为 `DRY`，方便后续 rollout。
                        </div>
                      </div>
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                    </FormItem>
                  )}
                />
              ) : null}

              <DialogFooter>
                <Button type="submit" disabled={createPool.isPending || updatePool.isPending}>
                  {editingPool ? "保存修改" : "创建 Pool"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <PoolInstancesDialog
        pool={instancesPool}
        open={!!instancesPool}
        onOpenChange={(open) => {
          if (!open) {
            setInstancesPool(null);
          }
        }}
      />
    </div>
  );
}
