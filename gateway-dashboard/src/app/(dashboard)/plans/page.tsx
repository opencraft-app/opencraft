"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { MoreHorizontal, Pencil, Trash2, Plus, X, ChevronDown, Check } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/page-header";
import { DataTable } from "@/components/shared/data-table";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import {
  usePlans,
  useCreatePlan,
  useUpdatePlan,
  useDeletePlan,
  type Plan,
  type RateLimitRule,
} from "@/lib/queries/use-plans";
import { formatTokens, formatNumber, formatDate, formatPeriod } from "@/lib/utils";
import { useProviders } from "@/lib/queries/use-providers";

// 预置窗口选项（label：下拉展示；ruleLabel：提交给后端的简短人类可读标签）
const WINDOW_OPTIONS = [
  { value: "1m", label: "1 分钟", ruleLabel: "每分钟" },
  { value: "5m", label: "5 分钟", ruleLabel: "每 5 分钟" },
  { value: "1h", label: "1 小时", ruleLabel: "每小时" },
  { value: "5h", label: "5 小时", ruleLabel: "每 5 小时" },
  { value: "1d", label: "1 天", ruleLabel: "每日" },
  { value: "1w", label: "1 周", ruleLabel: "每周" },
  { value: "1M", label: "1 个月", ruleLabel: "每月" },
] as const;

function ruleLabelForWindow(window: string): string | undefined {
  return WINDOW_OPTIONS.find((o) => o.value === window)?.ruleLabel;
}

function rateLimitSummaryLine(window: string, maxRequests: number, storedLabel: string): string {
  const scope = ruleLabelForWindow(window) ?? storedLabel;
  return `${scope}最多 ${maxRequests} 次请求`;
}

const planSchema = z.object({
  name: z.string().min(1, "名称不能为空").max(64, "名称最多 64 个字符"),
  unlimited_tokens: z.boolean(),
  monthly_tokens: z.number().int().min(0, "不能为负数"),
  period_value: z.number().int().min(1, "时长至少为 1"),
  period_unit: z.enum(["days", "months"]),
  rate_limits: z
    .array(
      z.object({
        window: z.string().min(1, "窗口不能为空"),
        max_requests: z.number().int().min(1, "最大请求数至少为 1"),
        label: z.string().min(1, "标签不能为空"),
      })
    )
    .min(1, "至少需要一条限流规则"),
  allowed_models: z.array(z.string()).min(1, "至少选择一个允许的模型"),
  multipliers: z.array(
    z.object({
      model: z.string().min(1, "模型名称不能为空"),
      multiplier: z.number().min(0.01, "倍率必须大于 0"),
    })
  ),
}).refine(
  (data) => {
    // 不限量时无需校验 monthly_tokens
    if (!data.unlimited_tokens && data.monthly_tokens <= 0) {
      return false;
    }
    return true;
  },
  {
    message: "限量模式下月度 Token 必须大于 0",
    path: ["monthly_tokens"],
  }
).refine(
  (data) => {
    const models = data.allowed_models;
    if (models.length === 0) return true;
    if (data.multipliers.length === 0) return true;
    const modelSet = new Set(models);
    return data.multipliers.every((m) => modelSet.has(m.model));
  },
  {
    message: "Token 倍率中存在不在「允许的模型」列表中的模型",
    path: ["multipliers"],
  }
);

type PlanFormValues = z.infer<typeof planSchema>;

function defaultFormValues(): PlanFormValues {
  return {
    name: "",
    unlimited_tokens: false,
    monthly_tokens: 0,
    period_value: 30,
    period_unit: "days",
    rate_limits: [
      { window: "1m", max_requests: 60, label: "每分钟" },
      { window: "1d", max_requests: 1000, label: "每日" },
    ],
    allowed_models: [],
    multipliers: [],
  };
}

function planToFormValues(plan: Plan): PlanFormValues {
  // 从 rate_limits 数组提取窗口信息
  const rateLimits: RateLimitRule[] = plan.rate_limits?.length
    ? plan.rate_limits
    : [];

  return {
    name: plan.name,
    unlimited_tokens: plan.monthly_tokens === 0,
    monthly_tokens: plan.monthly_tokens,
    period_value: plan.period_value ?? 30,
    period_unit: plan.period_unit ?? "days",
    rate_limits: rateLimits.map((r) => ({
      ...r,
      label: ruleLabelForWindow(r.window) ?? r.label,
    })),
    allowed_models: plan.allowed_models,
    multipliers: Object.entries(plan.token_multipliers).map(([model, multiplier]) => ({
      model,
      multiplier,
    })),
  };
}

function formValuesToInput(values: PlanFormValues) {
  const allowed_models = values.allowed_models;
  const token_multipliers: Record<string, number> = {};
  for (const m of values.multipliers) {
    if (m.model) token_multipliers[m.model] = m.multiplier;
  }
  return {
    name: values.name,
    monthly_tokens: values.unlimited_tokens ? 0 : values.monthly_tokens,
    period_value: values.period_value,
    period_unit: values.period_unit,
    rate_limits: values.rate_limits,
    allowed_models,
    token_multipliers,
  };
}

// 模型多选组件：tags + 下拉预设 + 自定义输入
function ModelMultiSelect({
  models,
  onToggle,
  onRemove,
  predefinedModels,
  placeholder,
}: {
  models: string[];
  onToggle: (model: string) => void;
  onRemove: (model: string) => void;
  predefinedModels: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [customInput, setCustomInput] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  function addCustom() {
    const val = customInput.trim();
    if (val && !models.includes(val)) {
      onToggle(val);
    }
    setCustomInput("");
  }

  return (
    <div ref={containerRef} className="relative">
      {/* 触发区域 */}
      <button
        type="button"
        className="flex min-h-9 w-full items-center gap-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm cursor-pointer hover:border-muted-foreground/50 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <div className="flex flex-1 flex-wrap items-center gap-1">
          {models.length === 0 && (
            <span className="text-muted-foreground text-sm">{placeholder || "选择模型..."}</span>
          )}
          {models.map((m) => (
            <span
              key={m}
              className="inline-flex items-center gap-0.5 rounded-md bg-secondary px-1.5 py-0.5 text-xs font-medium"
            >
              {m}
              <X
                className="h-3 w-3 cursor-pointer hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(m);
                }}
              />
            </span>
          ))}
        </div>
        <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {/* 下拉面板 */}
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
          <div className="max-h-48 overflow-y-auto p-1">
            {predefinedModels.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">暂无预定义模型，请使用自定义输入</p>
            )}
            {predefinedModels.map((m) => {
              const selected = models.includes(m);
              return (
                <button
                  key={m}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent cursor-pointer"
                  onClick={() => onToggle(m)}
                >
                  <div className={`flex h-4 w-4 items-center justify-center rounded-sm border ${selected ? "bg-primary border-primary" : "border-muted-foreground/30"}`}>
                    {selected && <Check className="h-3 w-3 text-primary-foreground" />}
                  </div>
                  <span className={selected ? "font-medium" : ""}>{m}</span>
                </button>
              );
            })}
          </div>
          {/* 自定义输入 */}
          <div className="border-t p-2 flex gap-1">
            <Input
              placeholder="自定义模型名..."
              className="h-7 text-xs"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustom();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs shrink-0"
              onClick={addCustom}
            >
              添加
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PlansPage() {
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<Plan | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Plan | null>(null);

  const { data, isLoading } = usePlans();
  const { data: providersData } = useProviders();
  const createPlan = useCreatePlan();

  // 从所有供应商的 supported_models 去重，作为预定义模型选项
  const predefinedModels = useMemo(() => {
    const providers = providersData?.items ?? [];
    const modelSet = new Set<string>();
    for (const p of providers) {
      if (p.supported_models) {
        for (const m of p.supported_models) {
          modelSet.add(m);
        }
      }
    }
    return Array.from(modelSet).sort();
  }, [providersData]);
  const updatePlan = useUpdatePlan();
  const deletePlan = useDeletePlan();

  const form = useForm<PlanFormValues>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(planSchema) as any,
    defaultValues: defaultFormValues(),
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "multipliers",
  });

  const { fields: rateLimitFields, append: appendRateLimit, remove: removeRateLimit } = useFieldArray({
    control: form.control,
    name: "rate_limits",
  });

  function openCreate() {
    setEditingPlan(null);
    form.reset(defaultFormValues());
    setDialogOpen(true);
  }

  function openEdit(plan: Plan) {
    setEditingPlan(plan);
    form.reset(planToFormValues(plan));
    setDialogOpen(true);
  }

  async function onSubmit(values: PlanFormValues) {
    const input = formValuesToInput(values);
    try {
      if (editingPlan) {
        await updatePlan.mutateAsync({ id: editingPlan.id, ...input });
        toast.success("套餐已更新");
      } else {
        await createPlan.mutateAsync(input);
        toast.success("套餐已创建");
      }
      setDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存套餐失败");
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deletePlan.mutateAsync(deleteTarget.id);
      toast.success("套餐已删除");
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除套餐失败");
    }
  }

  const columns: ColumnDef<Plan>[] = [
    { accessorKey: "name", header: "名称" },
    {
      accessorKey: "monthly_tokens",
      header: "月度 Token",
      cell: ({ row }) =>
        row.original.monthly_tokens === 0 ? (
          <Badge variant="secondary">不限量</Badge>
        ) : (
          formatTokens(row.original.monthly_tokens)
        ),
    },
    {
      accessorKey: "rate_limits",
      header: "限流规则",
      cell: ({ row }) => {
        const rules = row.original.rate_limits ?? [];
        if (rules.length === 0) return <span className="text-muted-foreground">—</span>;
        const MAX_SHOW = 2;
        return (
          <div className="flex items-center gap-1">
            {rules.slice(0, MAX_SHOW).map((rule, idx) => {
              const text = `${rule.label}: ${formatNumber(rule.max_requests)}`;
              return (
                <Tooltip key={idx}>
                  <TooltipTrigger
                    render={
                      <Badge variant="secondary" className="max-w-[140px] truncate shrink-0">
                        {text}
                      </Badge>
                    }
                  />
                  <TooltipContent>{text}</TooltipContent>
                </Tooltip>
              );
            })}
            {rules.length > MAX_SHOW && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button className="text-xs text-primary hover:text-primary/80 cursor-pointer shrink-0">
                      +{rules.length - MAX_SHOW}
                    </button>
                  }
                />
                <DropdownMenuContent className="min-w-[180px]">
                  <DropdownMenuLabel>限流规则 ({rules.length})</DropdownMenuLabel>
                  {rules.map((rule, idx) => (
                    <DropdownMenuItem key={idx} className="text-sm">
                      {rule.label}: {formatNumber(rule.max_requests)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "allowed_models",
      header: "允许的模型",
      cell: ({ row }) => {
        const models = row.original.allowed_models;
        if (models.length === 0) return <span className="text-muted-foreground text-xs">-</span>;
        if (models.length === 1) {
          return <span className="text-sm truncate max-w-[150px]">{models[0]}</span>;
        }
        return (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground cursor-pointer">
                  <span className="truncate max-w-[120px]">{models[0]}</span>
                  <span className="text-xs text-primary">+{models.length - 1}</span>
                </button>
              }
            />
            <DropdownMenuContent className="max-h-48 min-w-[200px] overflow-y-auto">
              <DropdownMenuLabel>允许的模型 ({models.length})</DropdownMenuLabel>
              {models.map((model) => (
                <DropdownMenuItem key={model} className="text-sm">
                  {model}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
    {
      accessorKey: "token_multipliers",
      header: "Token 倍率",
      cell: ({ row }) => {
        const entries = Object.entries(row.original.token_multipliers);
        if (entries.length === 0) return <span className="text-muted-foreground">—</span>;
        const MAX_SHOW = 2;
        return (
          <div className="flex items-center gap-1">
            {entries.slice(0, MAX_SHOW).map(([model, mult]) => {
              const text = `${model}: ${mult}x`;
              return (
                <Tooltip key={model}>
                  <TooltipTrigger
                    render={
                      <Badge variant="outline" className="max-w-[140px] truncate shrink-0">
                        {text}
                      </Badge>
                    }
                  />
                  <TooltipContent>{text}</TooltipContent>
                </Tooltip>
              );
            })}
            {entries.length > MAX_SHOW && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button className="text-xs text-primary hover:text-primary/80 cursor-pointer shrink-0">
                      +{entries.length - MAX_SHOW}
                    </button>
                  }
                />
                <DropdownMenuContent className="min-w-[200px]">
                  <DropdownMenuLabel>Token 倍率 ({entries.length})</DropdownMenuLabel>
                  {entries.map(([model, mult]) => (
                    <DropdownMenuItem key={model} className="text-sm">
                      {model}: {mult}x
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "period_value",
      header: "订阅时长",
      cell: ({ row }) => {
        const { period_value, period_unit } = row.original;
        if (!period_value || !period_unit) return <span className="text-muted-foreground">—</span>;
        return <Badge variant="outline">{formatPeriod(period_value, period_unit)}</Badge>;
      },
    },
    {
      accessorKey: "created_at",
      header: "创建时间",
      cell: ({ row }) => formatDate(row.original.created_at),
    },
    {
      id: "actions",
      cell: ({ row }) => {
        const plan = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon" />}
            >
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => openEdit(plan)}>
                <Pencil className="mr-2 h-4 w-4" /> 编辑
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDeleteTarget(plan)}
              >
                <Trash2 className="mr-2 h-4 w-4" /> 删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  const isSaving = createPlan.isPending || updatePlan.isPending;

  return (
    <div className="space-y-6">
      <PageHeader title="套餐管理" description="管理订阅套餐及其配额。">
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" /> 创建套餐
        </Button>
      </PageHeader>

      <DataTable
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        page={page}
        pageSize={20}
        onPageChange={setPage}
        isLoading={isLoading}
      />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editingPlan ? "编辑套餐" : "创建套餐"}</DialogTitle>
            <DialogDescription>
              {editingPlan
                ? "更新套餐配置。"
                : "配置新的订阅套餐。"}
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>名称</FormLabel>
                    <FormControl>
                      <Input placeholder="例如：Coding Plan Lite 套餐" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <FormLabel className="mb-0">月度 Token</FormLabel>
                  <Button
                    type="button"
                    variant={form.watch("unlimited_tokens") ? "default" : "outline"}
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => {
                      const current = form.getValues("unlimited_tokens");
                      form.setValue("unlimited_tokens", !current, { shouldValidate: true });
                      if (!current) {
                        form.setValue("monthly_tokens", 0);
                      }
                    }}
                  >
                    {form.watch("unlimited_tokens") ? "✓ 不限量" : "不限量"}
                  </Button>
                </div>
                {!form.watch("unlimited_tokens") && (
                  <FormField
                    control={form.control}
                    name="monthly_tokens"
                    render={({ field }) => (
                      <FormItem>
                        <FormControl>
                          <Input
                            type="number"
                            placeholder="例如：1000000"
                            {...field}
                            onChange={(e) => field.onChange(e.target.valueAsNumber || 0)}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              </div>

              {/* 订阅时长：数值 + 单位组合为一组输入 */}
              <div className="space-y-2">
                <FormLabel>订阅时长</FormLabel>
                <div className="flex rounded-lg border border-input bg-background shadow-xs overflow-hidden dark:bg-input/30">
                  <FormField
                    control={form.control}
                    name="period_value"
                    render={({ field }) => (
                      <FormItem className="min-w-0 flex-1 space-y-0">
                        <FormControl>
                          <Input
                            type="number"
                            min={1}
                            placeholder="例如：30"
                            className="h-9 rounded-none border-0 bg-transparent shadow-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
                            {...field}
                            onChange={(e) => field.onChange(e.target.valueAsNumber || 1)}
                          />
                        </FormControl>
                        <FormMessage className="px-3 pb-1 pt-0.5" />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="period_unit"
                    render={({ field }) => (
                      <FormItem className="w-26 shrink-0 space-y-0 border-l border-input">
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger className="h-9 min-w-0 w-full rounded-none border-0 bg-transparent shadow-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset">
                              <span className="truncate">{field.value === "days" ? "天" : "个月"}</span>
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="days">天</SelectItem>
                            <SelectItem value="months">个月</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage className="px-2 pb-1 pt-0.5" />
                      </FormItem>
                    )}
                  />
                </div>
                {/* 时长预览 */}
                {form.watch("period_value") > 0 && (
                  <p className="text-xs text-muted-foreground">
                    订阅周期：{formatPeriod(form.watch("period_value"), form.watch("period_unit"))}
                  </p>
                )}
              </div>

              {/* Rate Limits */}
              <div className="rounded-lg border border-dashed p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm font-medium">限流规则</Label>
                    <Badge variant="outline" className="text-xs">{rateLimitFields.length}</Badge>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      appendRateLimit({
                        window: "1m",
                        max_requests: 60,
                        label: ruleLabelForWindow("1m") ?? "每分钟",
                      })
                    }
                  >
                    <Plus className="mr-1 h-3 w-3" /> 添加
                  </Button>
                </div>
                {rateLimitFields.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    至少需要一条限流规则来控制请求频率。
                  </p>
                )}
                {rateLimitFields.map((field, index) => (
                  <div key={field.id} className="rounded-lg border border-border/60 bg-muted/30 p-3">
                    <FormField
                      control={form.control}
                      name={`rate_limits.${index}.label`}
                      render={({ field: f }) => <input type="hidden" {...f} />}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <FormField
                        control={form.control}
                        name={`rate_limits.${index}.window`}
                        render={({ field: f }) => (
                          <FormItem className="min-w-0 w-29 shrink-0 space-y-0">
                            <Select
                              value={f.value}
                              onValueChange={(val) => {
                                const opt = WINDOW_OPTIONS.find((o) => o.value === val);
                                f.onChange(val);
                                if (opt) {
                                  form.setValue(`rate_limits.${index}.label`, opt.ruleLabel);
                                }
                              }}
                            >
                              <SelectTrigger className="h-8 min-w-0 w-full">
                                <span className="truncate">
                                  {WINDOW_OPTIONS.find((o) => o.value === f.value)?.label ?? f.value}
                                </span>
                              </SelectTrigger>
                              <SelectContent>
                                {WINDOW_OPTIONS.map((opt) => (
                                  <SelectItem key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name={`rate_limits.${index}.max_requests`}
                        render={({ field: f }) => (
                          <FormItem className="w-24 shrink-0 space-y-0">
                            <Input
                              type="number"
                              min={1}
                              placeholder="次数"
                              className="h-8 tabular-nums"
                              {...f}
                              onChange={(e) => f.onChange(e.target.valueAsNumber || 0)}
                            />
                          </FormItem>
                        )}
                      />
                      <p className="min-w-40 flex-1 text-xs leading-snug text-muted-foreground">
                        {rateLimitSummaryLine(
                          form.watch(`rate_limits.${index}.window`),
                          form.watch(`rate_limits.${index}.max_requests`),
                          form.watch(`rate_limits.${index}.label`)
                        )}
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 sm:ml-auto"
                        onClick={() => removeRateLimit(index)}
                      >
                        <X className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              <FormField
                control={form.control}
                name="allowed_models"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>允许的模型</FormLabel>
                    <FormControl>
                      <ModelMultiSelect
                        models={field.value}
                        predefinedModels={predefinedModels}
                        onToggle={(model) => {
                          const current = field.value;
                          if (current.includes(model)) {
                            field.onChange(current.filter((m: string) => m !== model));
                          } else {
                            field.onChange([...current, model]);
                          }
                        }}
                        onRemove={(model) =>
                          field.onChange(field.value.filter((m: string) => m !== model))
                        }
                        placeholder="点击选择或输入自定义模型..."
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Token Multipliers */}
              <div className="rounded-lg border border-dashed p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm font-medium">Token 倍率</Label>
                    <Badge variant="outline" className="text-xs">{fields.length}</Badge>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => append({ model: "", multiplier: 1 })}
                  >
                    <Plus className="mr-1 h-3 w-3" /> 添加
                  </Button>
                </div>
                {fields.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    未配置倍率，所有模型使用 1x Token 费率。
                  </p>
                )}
                {fields.map((field, index) => (
                  <div key={field.id} className="flex items-center gap-2 bg-muted/30 p-2 rounded-md">
                    <FormField
                      control={form.control}
                      name={`multipliers.${index}.model`}
                      render={({ field }) => (
                        <FormItem className="flex-1">
                          <Select value={field.value} onValueChange={field.onChange}>
                            <SelectTrigger className="h-8">
                              <SelectValue placeholder="选择模型" />
                            </SelectTrigger>
                            <SelectContent>
                              {(form.watch("allowed_models") ?? []).map((m: string) => (
                                <SelectItem key={m} value={m}>
                                  {m}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )}
                    />
                    <div className="flex items-center gap-1">
                      <FormField
                        control={form.control}
                        name={`multipliers.${index}.multiplier`}
                        render={({ field }) => (
                          <FormItem className="w-20">
                            <Input
                              type="number"
                              step="0.1"
                              placeholder="1.0"
                              className="h-8 text-center"
                              {...field}
                              onChange={(e) => field.onChange(e.target.valueAsNumber || 0)}
                            />
                          </FormItem>
                        )}
                      />
                      <span className="text-sm text-muted-foreground font-medium">x</span>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => remove(index)}
                    >
                      <X className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDialogOpen(false)}
                >
                  取消
                </Button>
                <Button type="submit" disabled={isSaving}>
                  {isSaving ? "保存中..." : editingPlan ? "更新" : "创建"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="删除套餐"
        description={`此操作将永久删除"${deleteTarget?.name}"套餐。当前使用此套餐的用户需要重新分配。此操作不可撤销。`}
        confirmLabel="删除"
        variant="destructive"
        onConfirm={handleDelete}
        loading={deletePlan.isPending}
      />
    </div>
  );
}
