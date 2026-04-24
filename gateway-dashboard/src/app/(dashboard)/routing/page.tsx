"use client";

import React, { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  MoreHorizontal,
  Plus,
  Pencil,
  Trash2,
  Play,
  Route,
  AlertCircle,
  CheckCircle,
  RefreshCw,
  Clock,
  Shield,
  Zap,
  X,
  ChevronDown,
  Shuffle,
  ArrowDownUp,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/page-header";
import { DataTable } from "@/components/shared/data-table";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Label } from "@/components/ui/label";
import {
  useModelMappings,
  useCreateModelMapping,
  useDeleteModelMapping,
  useUpdateModelMapping,
  useResolveModel,
  type ModelMapping,
} from "@/lib/queries/use-model-mappings";
import { useProviders } from "@/lib/queries/use-providers";
import { useRoutingConfig, useUpdateStrategy, useUpdateCircuitBreaker } from "@/lib/queries/use-config";
import { formatDateTime } from "@/lib/utils";

const mappingSchema = z.object({
  model_pattern: z.string().min(1, "模型模式不能为空").max(128, "最多 128 个字符"),
  provider_id: z.string().min(1, "请选择提供商"),
  priority: z.number().int().min(0).max(100),
  weight: z.number().int().min(0).max(1000),
  is_active: z.boolean(),
  strategy_mode: z.string().nullable().optional(),
  retry_attempts: z.number().int().min(0).max(5).nullable().optional(),
  on_status_codes: z.array(z.number()).nullable().optional(),
  override_params_str: z.string().optional(),
});

type MappingFormValues = z.infer<typeof mappingSchema>;

function defaultFormValues(): MappingFormValues {
  return {
    model_pattern: "",
    provider_id: "",
    priority: 0,
    weight: 100,
    is_active: true,
    strategy_mode: null,
    retry_attempts: null,
    on_status_codes: null,
    override_params_str: "",
  };
}

function formToValues(mapping: ModelMapping): MappingFormValues {
  return {
    model_pattern: mapping.model_pattern,
    provider_id: mapping.provider_id,
    priority: mapping.priority,
    weight: mapping.weight ?? 100,
    is_active: mapping.is_active,
    strategy_mode: mapping.strategy_mode ?? null,
    retry_attempts: mapping.retry_attempts ?? null,
    on_status_codes: mapping.on_status_codes ?? null,
    override_params_str: mapping.override_params
      ? JSON.stringify(mapping.override_params, null, 2)
      : "",
  };
}

export default function RoutingPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingMapping, setEditingMapping] = useState<ModelMapping | null>(null);
  const [deleteMapping, setDeleteMapping] = useState<ModelMapping | null>(null);
  const [strategyDialogOpen, setStrategyDialogOpen] = useState(false);
  const [strategyForm, setStrategyForm] = useState({
    default_model: "",
    strategy_mode: "fallback",
    strategy_on_status_codes: [] as number[],
    strategy_retry_attempts: 3,
    strategy_retry_status_codes: [] as number[],
  });
  const [legacyCbDialogOpen, setLegacyCbDialogOpen] = useState(false);
  const [legacyCbForm, setLegacyCbForm] = useState({
    failure_threshold: 3,
    cooldown_duration_s: 30,
  });
  const [testModel, setTestModel] = useState("");
  const [testResult, setTestResult] = useState<{
    model: string;
    providers: Array<{ name: string; status: string; weight: number; priority: number }>;
    mismatches?: Array<{ provider_name: string; reason: string; source: string }>;
    fallback?: boolean;
    message?: string;
  } | null>(null);

  const { data: mappingsData, isLoading } = useModelMappings();
  const { data: providersData } = useProviders();
  const { data: routingConfig, isLoading: routingLoading } = useRoutingConfig();
  const updateStrategy = useUpdateStrategy();
  const updateCircuitBreaker = useUpdateCircuitBreaker();
  const createMapping = useCreateModelMapping();
  const deleteMappingMutation = useDeleteModelMapping();
  const updateMapping = useUpdateModelMapping();
  const resolveModel = useResolveModel();

  const form = useForm<MappingFormValues>({
    resolver: zodResolver(mappingSchema),
    defaultValues: defaultFormValues(),
  });

  const providers = providersData?.items ?? [];

  function openCreate() {
    setEditingMapping(null);
    form.reset(defaultFormValues());
    setDialogOpen(true);
  }

  function openEdit(mapping: ModelMapping) {
    setEditingMapping(mapping);
    form.reset(formToValues(mapping));
    setDialogOpen(true);
  }

  async function onSubmit(values: MappingFormValues) {
    try {
      // 解析 override_params
      let overrideParams: Record<string, unknown> | null = null;
      if (values.override_params_str && values.override_params_str.trim()) {
        try {
          overrideParams = JSON.parse(values.override_params_str);
        } catch {
          toast.error("Override Params 格式错误，请输入有效的 JSON");
          return;
        }
      }

      const payload = {
        model_pattern: values.model_pattern,
        provider_id: values.provider_id,
        priority: values.priority,
        weight: values.weight,
        is_active: values.is_active,
        strategy_mode: values.strategy_mode || null,
        retry_attempts: values.retry_attempts,
        on_status_codes: values.on_status_codes?.length ? values.on_status_codes : null,
        override_params: overrideParams,
      };

      if (editingMapping) {
        await updateMapping.mutateAsync({
          id: editingMapping.id,
          data: payload,
        });
      } else {
        await createMapping.mutateAsync(payload);
      }
      toast.success(editingMapping ? "映射已更新" : "映射已创建");
      setDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存映射失败");
    }
  }

  async function handleDelete(mapping: ModelMapping) {
    try {
      await deleteMappingMutation.mutateAsync(mapping.id);
      toast.success("映射已删除");
      setDeleteMapping(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除映射失败");
    }
  }

  async function handleTest() {
    if (!testModel.trim()) {
      toast.error("请输入模型名称");
      return;
    }
    try {
      const result = await resolveModel.mutateAsync(testModel);
      setTestResult(result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "测试失败");
    }
  }

  function openStrategyEdit() {
    if (routingConfig) {
      setStrategyForm({
        default_model: routingConfig.default_model || "",
        strategy_mode: routingConfig.strategy?.mode || "fallback",
        strategy_on_status_codes: [...(routingConfig.strategy?.on_status_codes || [])],
        strategy_retry_attempts: routingConfig.strategy?.retry_attempts ?? 3,
        strategy_retry_status_codes: [...(routingConfig.strategy?.retry_status_codes || [])],
      });
    }
    setStrategyDialogOpen(true);
  }

  function openLegacyCbEdit() {
    if (routingConfig) {
      setLegacyCbForm({
        failure_threshold: routingConfig.failure_threshold,
        cooldown_duration_s: routingConfig.cooldown_duration_s,
      });
    }
    setLegacyCbDialogOpen(true);
  }

  async function handleStrategySubmit() {
    try {
      await updateStrategy.mutateAsync({
        default_model: strategyForm.default_model.trim(),
        mode: strategyForm.strategy_mode || "fallback",
        on_status_codes: strategyForm.strategy_on_status_codes,
        retry_attempts: strategyForm.strategy_retry_attempts,
        retry_status_codes: strategyForm.strategy_retry_status_codes,
      });
      toast.success("路由策略已更新");
      setStrategyDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新失败");
    }
  }

  async function handleCbSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    try {
      await updateCircuitBreaker.mutateAsync({
        failure_threshold: parseInt(fd.get("failure_threshold") as string) || 1,
        cooldown_duration_s: parseInt(fd.get("cooldown_duration_s") as string) || 30,
      });
      toast.success("熔断器配置已更新");
      setLegacyCbDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新失败");
    }
  }

  // 常见 HTTP 错误状态码预设
  const COMMON_STATUS_CODES = [
    { code: 400, label: "400 Bad Request" },
    { code: 401, label: "401 Unauthorized" },
    { code: 403, label: "403 Forbidden" },
    { code: 404, label: "404 Not Found" },
    { code: 408, label: "408 Timeout" },
    { code: 429, label: "429 Too Many Requests" },
    { code: 500, label: "500 Internal Server Error" },
    { code: 502, label: "502 Bad Gateway" },
    { code: 503, label: "503 Service Unavailable" },
    { code: 504, label: "504 Gateway Timeout" },
  ];

  // 状态码多选组件：tags + 下拉预设 + 自定义输入
  function StatusCodeTags({
    codes,
    onToggle,
    onRemove,
    placeholder,
  }: {
    codes: number[];
    onToggle: (code: number) => void;
    onRemove: (code: number) => void;
    placeholder?: string;
  }) {
    const [open, setOpen] = useState(false);
    const [customInput, setCustomInput] = useState("");
    const dropdownRef = React.useRef<HTMLDivElement>(null);

    // 点击外部关闭
    React.useEffect(() => {
      if (!open) return;
      function handleClick(e: MouseEvent) {
        if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
          setOpen(false);
        }
      }
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }, [open]);

    function handleCustomAdd() {
      const raw = customInput.trim();
      if (!raw) return;
      const num = parseInt(raw, 10);
      if (isNaN(num) || !Number.isInteger(Number(raw))) {
        toast.error("请输入有效的整数状态码");
        return;
      }
      if (num < 100 || num > 599) {
        toast.error("状态码必须在 100~599 范围内");
        return;
      }
      if (codes.includes(num)) {
        toast.error(`状态码 ${num} 已存在`);
        return;
      }
      onToggle(num);
      setCustomInput("");
    }

    return (
      <div className="relative" ref={dropdownRef}>
        <button
          type="button"
          className="flex flex-wrap items-center gap-1.5 rounded-md border bg-background p-2 min-h-[40px] w-full text-left cursor-pointer hover:border-muted-foreground/50 transition-colors"
          onClick={() => setOpen(!open)}
        >
          {codes.length > 0 ? (
            codes.map((code) => (
              <Badge key={code} variant="secondary" className="gap-1 font-mono text-xs">
                {code}
                <span
                  role="button"
                  className="ml-0.5 rounded-full outline-none hover:bg-muted-foreground/20"
                  onClick={(e) => { e.stopPropagation(); onRemove(code); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onRemove(code); } }}
                  tabIndex={0}
                >
                  <X className="h-3 w-3" />
                </span>
              </Badge>
            ))
          ) : (
            <span className="text-sm text-muted-foreground">{placeholder || "选择状态码"}</span>
          )}
          <ChevronDown className="h-4 w-4 ml-auto shrink-0 text-muted-foreground" />
        </button>

        {open && (
          <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
            <div className="max-h-48 overflow-y-auto p-1">
              {COMMON_STATUS_CODES.map(({ code, label }) => (
                <button
                  key={code}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent cursor-pointer"
                  onClick={() => onToggle(code)}
                >
                  <div className={`h-4 w-4 rounded border flex items-center justify-center ${codes.includes(code) ? "bg-primary border-primary" : "border-input"}`}>
                    {codes.includes(code) && <CheckCircle className="h-3 w-3 text-primary-foreground" />}
                  </div>
                  <span className="font-mono text-xs">{label}</span>
                </button>
              ))}
            </div>
            <div className="border-t p-2">
              <div className="flex gap-1.5">
                <Input
                  type="number"
                  className="h-7 flex-1 text-xs font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  placeholder="自定义状态码"
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); handleCustomAdd(); }
                    e.stopPropagation();
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
                <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={handleCustomAdd}>
                  添加
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const columns: ColumnDef<ModelMapping>[] = [
    {
      accessorKey: "model_pattern",
      header: "模型模式",
      cell: ({ row }) => (
        <code className="bg-muted px-2 py-1 rounded text-sm">
          {row.original.model_pattern}
        </code>
      ),
    },
    {
      id: "provider",
      header: "提供商",
      cell: ({ row }) => {
        const provider = row.original.provider;
        return provider ? (
          <Badge variant="outline">{provider.name}</Badge>
        ) : (
          <span className="text-muted-foreground">-</span>
        );
      },
    },
    {
      accessorKey: "priority",
      header: "优先级",
      cell: ({ row }) => row.original.priority,
    },
    {
      accessorKey: "weight",
      header: "权重",
      cell: ({ row }) => row.original.weight ?? 100,
    },
    {
      id: "strategy",
      header: "策略覆盖",
      cell: ({ row }) => {
        const mode = row.original.strategy_mode;
        if (!mode) return <span className="text-muted-foreground">-</span>;
        return (
          <Badge variant={mode === "loadbalance" ? "default" : "secondary"}>
            {mode === "loadbalance" ? "lb" : "fb"}
          </Badge>
        );
      },
    },
    {
      id: "override",
      header: "Override",
      cell: ({ row }) => {
        const params = row.original.override_params;
        if (!params || Object.keys(params).length === 0) {
          return <span className="text-muted-foreground">-</span>;
        }
        const summary = Object.keys(params).join(", ");
        return (
          <code className="bg-muted px-1.5 py-0.5 rounded text-xs truncate max-w-[120px] block" title={JSON.stringify(params)}>
            {summary}
          </code>
        );
      },
    },
    {
      accessorKey: "is_active",
      header: "状态",
      cell: ({ row }) => (
        <Badge variant={row.original.is_active ? "default" : "secondary"}>
          {row.original.is_active ? "启用" : "禁用"}
        </Badge>
      ),
    },
    {
      accessorKey: "created_at",
      header: "创建时间",
      cell: ({ row }) => formatDateTime(row.original.created_at),
    },
    {
      id: "actions",
      cell: ({ row }) => {
        const mapping = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" />}>
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => openEdit(mapping)}>
                <Pencil className="mr-2 h-4 w-4" /> 编辑
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setDeleteMapping(mapping)}
                className="text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" /> 删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  const mappings = mappingsData?.items ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="路由管理"
        description="配置模型到提供商的路由规则，支持通配符匹配、负载均衡和故障转移策略。"
      >
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" /> 添加映射
        </Button>
      </PageHeader>

      {/* 全局配置区 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 路由策略卡片 */}
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Shuffle className="h-5 w-5" />
              <h3 className="font-medium">路由策略</h3>
            </div>
            <Button variant="outline" size="sm" onClick={() => openStrategyEdit()}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" /> 编辑
            </Button>
          </div>
          {routingLoading ? (
            <div className="text-sm text-muted-foreground">加载配置中...</div>
          ) : routingConfig ? (
            <div className="space-y-3">
              <div className="rounded-md border p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Route className="h-3.5 w-3.5" />
                  默认模型
                </div>
                <p className="text-lg font-semibold">{routingConfig.default_model || "未配置"}</p>
                <p className="text-xs text-muted-foreground">
                  请求未指定模型时优先使用；若套餐不允许则回退到套餐首个允许模型
                </p>
              </div>
              <div className="rounded-md border p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ArrowDownUp className="h-3.5 w-3.5" />
                  路由模式
                </div>
                <p className="text-lg font-semibold">
                  {routingConfig.strategy?.mode === "loadbalance" ? "负载均衡" : "故障转移"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {routingConfig.strategy?.mode === "loadbalance"
                    ? "按权重分配请求到多个提供商"
                    : "优先使用主提供商，失败后切换"}
                </p>
              </div>
              <div className="rounded-md border p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Shield className="h-3.5 w-3.5" />
                  策略触发状态码
                </div>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {(routingConfig.strategy?.on_status_codes || []).map((code) => (
                    <Badge key={code} variant="outline" className="text-xs font-mono">
                      {code}
                    </Badge>
                  ))}
                </div>
              </div>
              <div className="rounded-md border p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <RefreshCw className="h-3.5 w-3.5" />
                  重试次数
                </div>
                <p className="text-lg font-semibold">{routingConfig.strategy?.retry_attempts ?? 0}</p>
              </div>
              <div className="rounded-md border p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Shield className="h-3.5 w-3.5" />
                  重试触发状态码
                </div>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {(routingConfig.strategy?.retry_status_codes || []).map((code) => (
                    <Badge key={code} variant="outline" className="text-xs font-mono">
                      {code}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* 熔断器配置卡片 */}
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              <h3 className="font-medium">熔断器配置</h3>
            </div>
            <Button variant="outline" size="sm" onClick={() => openLegacyCbEdit()}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" /> 编辑
            </Button>
          </div>
          {routingLoading ? (
            <div className="text-sm text-muted-foreground">加载配置中...</div>
          ) : routingConfig ? (
            <div className="space-y-3">
              <div className="rounded-md border p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <AlertCircle className="h-3.5 w-3.5" />
                  失败阈值
                </div>
                <p className="text-lg font-semibold">{routingConfig.failure_threshold} 次</p>
                <p className="text-xs text-muted-foreground">连续失败达到此次数后触发熔断</p>
              </div>
              <div className="rounded-md border p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  冷却时长
                </div>
                <p className="text-lg font-semibold">{routingConfig.cooldown_duration_s}s</p>
                <p className="text-xs text-muted-foreground">熔断后等待此时间进入半开状态</p>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* 路由测试器 */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2 mb-4">
          <Route className="h-5 w-5" />
          <h3 className="font-medium">路由测试器</h3>
        </div>
        <div className="flex gap-2">
          <Input
            placeholder="输入模型标识测试路由，例如：gpt-4o、claude-3.5-sonnet、hunyuan-2.0-instruct"
            value={testModel}
            onChange={(e) => setTestModel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleTest()}
            className="flex-1"
          />
          <Button onClick={handleTest} disabled={resolveModel.isPending}>
            <Play className="mr-2 h-4 w-4" />
            {resolveModel.isPending ? "测试中..." : "测试"}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          该测试器会按以下顺序解析候选提供商：先匹配模型映射；若未配置映射，则从各供应商
          <code className="mx-1 rounded bg-background px-1 py-0.5 text-[11px]">supported_models</code>
          自动发现；两者都没有时才按供应商类型兜底。结果中的“命中提供商”不等于已配置显式映射。
        </p>
        {testResult && (
          <div className="mt-4 p-3 rounded-md bg-muted">
            {testResult.providers.length > 0 ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle className="h-4 w-4 text-green-500" />
                  <span>
                    模型 <strong>{testResult.model}</strong> 解析到{" "}
                    {testResult.providers.length} 个候选提供商
                    {testResult.fallback
                      ? "（当前为兜底结果）"
                      : "（可能来自显式映射或 supported_models 自动发现）"}
                    :
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  未配置映射的模型也可能命中 provider，只要某个供应商的
                  <code className="mx-1 rounded bg-background px-1 py-0.5 text-[11px]">supported_models</code>
                  声明支持该模型即可。
                </div>
                <div className="grid gap-2 mt-2">
                  {testResult.providers.map((p) => (
                    <div
                      key={p.name}
                      className="flex items-center justify-between text-sm bg-background p-2 rounded"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono">{p.name}</span>
                        <Badge
                          variant={p.status === "active" ? "default" : "destructive"}
                        >
                          {p.status}
                        </Badge>
                      </div>
                      <span className="text-muted-foreground">
                        优先级: {p.priority} · 权重: {p.weight}
                      </span>
                    </div>
                  ))}
                </div>
                {testResult.mismatches && testResult.mismatches.length > 0 ? (
                  <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
                    以下 provider 因配置不一致已被排除：
                    {" "}
                    {testResult.mismatches
                      .map((m) => `${m.provider_name}（${m.reason}）`)
                      .join("；")}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm">
                <AlertCircle className="h-4 w-4 text-yellow-500" />
                <span>
                  {testResult.message || "未解析到可用提供商。请检查模型名是否与映射规则或 supported_models 中的实际标识一致。"}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 映射列表 */}
      <DataTable
        columns={columns}
        data={mappings}
        total={mappings.length}
        page={1}
        pageSize={20}
        onPageChange={() => {}}
        isLoading={isLoading}
      />

      {/* 添加/编辑对话框 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingMapping ? "编辑映射" : "添加映射"}
            </DialogTitle>
            <DialogDescription>
              配置模型模式到提供商的映射关系。使用 * 作为通配符，例如 gpt-4* 匹配所有 gpt-4 开头的模型。
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="model_pattern"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>模型模式</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="例如：gpt-4*, claude-*"
                        {...field}
                      />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">
                      支持通配符 * 匹配任意字符
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="provider_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>提供商</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="选择提供商">
                            {(() => {
                              const p = providers.find((p) => p.id === field.value);
                              return p ? `${p.name}` : undefined;
                            })()}
                          </SelectValue>
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {providers.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="priority"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>优先级</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        onChange={(e) =>
                          field.onChange(e.target.valueAsNumber || 0)
                        }
                      />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">
                      数值越大优先级越高，相同优先级时按权重分配流量
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="weight"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>权重</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        onChange={(e) =>
                          field.onChange(e.target.valueAsNumber || 0)
                        }
                      />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">
                      同优先级的映射按权重比例分配流量（0-1000，默认 100）
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* 路由策略覆盖字段 */}
              <div className="border-t pt-4 space-y-4">
                <p className="text-sm font-medium text-muted-foreground">路由策略覆盖（留空继承全局）</p>

                <FormField
                  control={form.control}
                  name="strategy_mode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>策略覆盖</FormLabel>
                      <Select
                        value={field.value || "__inherit__"}
                        items={[
                          { value: "__inherit__", label: "继承全局" },
                          { value: "loadbalance", label: "负载均衡 (loadbalance)" },
                          { value: "fallback", label: "故障转移 (fallback)" },
                        ]}
                        onValueChange={(v) => field.onChange(v === "__inherit__" ? null : v)}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="min-w-[240px]">
                          <SelectItem value="__inherit__">继承全局</SelectItem>
                          <SelectItem value="loadbalance">负载均衡 (loadbalance)</SelectItem>
                          <SelectItem value="fallback">故障转移 (fallback)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="retry_attempts"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>重试次数覆盖</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          max={5}
                          placeholder="留空继承全局"
                          value={field.value ?? ""}
                          onChange={(e) => {
                            const v = e.target.value;
                            field.onChange(v === "" ? null : parseInt(v));
                          }}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="on_status_codes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>策略触发状态码覆盖</FormLabel>
                      <FormControl>
                        <StatusCodeTags
                          codes={field.value ?? []}
                          onToggle={(code) => {
                            const current = field.value ?? [];
                            field.onChange(
                              current.includes(code)
                                ? current.filter((c: number) => c !== code)
                                : [...current, code]
                            );
                          }}
                          onRemove={(code) =>
                            field.onChange((field.value ?? []).filter((c: number) => c !== code))
                          }
                          placeholder="留空继承全局，点击选择状态码"
                        />
                      </FormControl>
                      <p className="text-xs text-muted-foreground">
                        收到这些状态码时触发策略切换（留空继承全局配置）
                      </p>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="override_params_str"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Override Params</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder='例如：{"model": "gpt-4o-mini"}'
                          className="font-mono text-sm"
                          rows={3}
                          {...field}
                        />
                      </FormControl>
                      <p className="text-xs text-muted-foreground">
                        JSON 格式，目标提供商级别参数覆盖
                      </p>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDialogOpen(false)}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  disabled={createMapping.isPending || updateMapping.isPending}
                >
                  {createMapping.isPending || updateMapping.isPending
                    ? "保存中..."
                    : editingMapping
                      ? "更新"
                      : "创建"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* 删除确认对话框 */}
      <ConfirmDialog
        open={!!deleteMapping}
        onOpenChange={(open) => !open && setDeleteMapping(null)}
        title="删除映射"
        description={`确定要删除模型模式 "${deleteMapping?.model_pattern}" 的映射吗？`}
        onConfirm={() => deleteMapping && handleDelete(deleteMapping)}
        confirmLabel="删除"
        variant="destructive"
      />

      {/* 路由策略编辑对话框 */}
      <Dialog open={strategyDialogOpen} onOpenChange={setStrategyDialogOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>编辑路由策略</DialogTitle>
            <DialogDescription>
              修改路由策略配置，保存后立即生效无需重启服务。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="default-model">默认模型</Label>
                <Input
                  id="default-model"
                  placeholder="例如：gpt-4o-mini"
                  value={strategyForm.default_model}
                  onChange={(e) => setStrategyForm(prev => ({ ...prev, default_model: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">
                  API Key 请求未指定模型时优先使用该模型；若用户套餐不允许则自动回退。
                </p>
              </div>
              <div className="space-y-2">
                <Label>路由模式</Label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    className={`rounded-lg border p-3 text-left text-sm transition-colors ${
                      strategyForm.strategy_mode === "fallback"
                        ? "border-primary bg-primary/5"
                        : "border-input hover:border-muted-foreground/50"
                    }`}
                    onClick={() => setStrategyForm(prev => ({ ...prev, strategy_mode: "fallback" }))}
                  >
                    <div className="font-medium">故障转移</div>
                    <div className="text-xs text-muted-foreground mt-0.5">按优先级依次尝试</div>
                  </button>
                  <button
                    type="button"
                    className={`rounded-lg border p-3 text-left text-sm transition-colors ${
                      strategyForm.strategy_mode === "loadbalance"
                        ? "border-primary bg-primary/5"
                        : "border-input hover:border-muted-foreground/50"
                    }`}
                    onClick={() => setStrategyForm(prev => ({ ...prev, strategy_mode: "loadbalance" }))}
                  >
                    <div className="font-medium">负载均衡</div>
                    <div className="text-xs text-muted-foreground mt-0.5">按权重分配流量</div>
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                <Label>策略触发状态码</Label>
                <StatusCodeTags
                  codes={strategyForm.strategy_on_status_codes}
                  onToggle={(code) => {
                    setStrategyForm(prev => ({
                      ...prev,
                      strategy_on_status_codes: prev.strategy_on_status_codes.includes(code)
                        ? prev.strategy_on_status_codes.filter((c) => c !== code)
                        : [...prev.strategy_on_status_codes, code],
                    }));
                  }}
                  onRemove={(code) =>
                    setStrategyForm(prev => ({
                      ...prev,
                      strategy_on_status_codes: prev.strategy_on_status_codes.filter((c) => c !== code),
                    }))
                  }
                  placeholder="收到这些状态码时触发策略切换"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>重试次数 (0~5)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={5}
                    value={strategyForm.strategy_retry_attempts}
                    onChange={(e) =>
                      setStrategyForm(prev => ({ ...prev, strategy_retry_attempts: parseInt(e.target.value) || 0 }))
                    }
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>底层重试状态码</Label>
                <StatusCodeTags
                  codes={strategyForm.strategy_retry_status_codes}
                  onToggle={(code) => {
                    setStrategyForm(prev => ({
                      ...prev,
                      strategy_retry_status_codes: prev.strategy_retry_status_codes.includes(code)
                        ? prev.strategy_retry_status_codes.filter((c) => c !== code)
                        : [...prev.strategy_retry_status_codes, code],
                    }));
                  }}
                  onRemove={(code) =>
                    setStrategyForm(prev => ({
                      ...prev,
                      strategy_retry_status_codes: prev.strategy_retry_status_codes.filter((c) => c !== code),
                    }))
                  }
                  placeholder="收到这些状态码时触发重试"
                />
                <p className="text-xs text-muted-foreground">
                  收到这些状态码时触发自动重试
                </p>
              </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStrategyDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleStrategySubmit} disabled={updateStrategy.isPending}>
              {updateStrategy.isPending ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 熔断器编辑对话框 */}
      <Dialog open={legacyCbDialogOpen} onOpenChange={setLegacyCbDialogOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <form onSubmit={handleCbSubmit}>
          <DialogHeader>
            <DialogTitle>编辑熔断器配置</DialogTitle>
            <DialogDescription>
              修改熔断器配置，保存后立即生效无需重启服务。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
              <div className="space-y-2">
                <Label>熔断失败阈值 (1~50)</Label>
                <Input
                  name="failure_threshold"
                  type="number"
                  min={1}
                  max={50}
                  value={legacyCbForm.failure_threshold}
                  onChange={(e) =>
                    setLegacyCbForm(prev => ({ ...prev, failure_threshold: parseInt(e.target.value) || 0 }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>熔断冷却时长 (5~300s)</Label>
                <Input
                  name="cooldown_duration_s"
                  type="number"
                  min={5}
                  max={300}
                  value={legacyCbForm.cooldown_duration_s}
                  onChange={(e) =>
                    setLegacyCbForm(prev => ({ ...prev, cooldown_duration_s: parseInt(e.target.value) || 0 }))
                  }
                />
              </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setLegacyCbDialogOpen(false)}>
              取消
            </Button>
            <Button type="submit" disabled={updateCircuitBreaker.isPending}>
              {updateCircuitBreaker.isPending ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
